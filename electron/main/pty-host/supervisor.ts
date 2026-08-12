import {
  CRASH_LIMIT,
  CRASH_WINDOW_MS,
  HEARTBEAT_INTERVAL_MS,
  MISSED_BEAT_LIMIT,
  SHUTDOWN_TIMEOUT_MS,
  type DataMessage,
  type ErrorMessage,
  type ExitMessage,
  type HostCommand,
  type HostMessage,
  type SpawnCommand,
  type SpawnedMessage,
} from '@shared/pty-host-protocol';

/**
 * The pty-host supervisor (story 091).
 *
 * PTYs run in a dedicated `utilityProcess`, not in the main process. The
 * simpler design — `node-pty` loaded directly in main — was considered and
 * rejected: `node-pty` is a native addon, a segfault in a native addon is not
 * catchable, and in main that is a hard crash of the entire application. Every
 * other live session dies with it, and the UI that would have reported the
 * failure dies first.
 *
 * This module owns the child's lifetime, its health, and the mapping from
 * session id to "the host that owns it". It does **not** know what a project
 * is, what a shell is, or what should run — that is main's job upstream and the
 * host's job downstream.
 *
 * Every external dependency is injected. There is no `import { utilityProcess }`
 * here, which is what lets the whole supervision story — lazy start, heartbeat
 * timeout, crash fan-out, the crash-loop guard, shutdown escalation — be
 * asserted with fake timers instead of by killing real processes. Real
 * supervision, a genuine host actually crashing, belongs to story 098.
 */

/**
 * The slice of Electron's `UtilityProcess` this module uses.
 *
 * Narrow on purpose: it is the whole surface a fake has to implement, and it
 * documents exactly how much of Electron this design depends on.
 */
export interface HostChild {
  readonly pid: number | undefined;
  postMessage(message: HostCommand): void;
  kill(): boolean;
  on(event: 'message', listener: (message: HostMessage) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(event: 'spawn', listener: () => void): void;
}

export interface SupervisorOptions {
  /** Creates a host process. Injected so tests never fork anything. */
  fork: () => HostChild;
  /** Injected clock for the crash-loop window. */
  now?: () => number;
  heartbeatIntervalMs?: number;
  missedBeatLimit?: number;
  shutdownTimeoutMs?: number;
  crashWindowMs?: number;
  crashLimit?: number;
}

/** Why a session stopped being live. */
export interface SessionLost {
  sessionId: string;
  reason: 'host-crashed';
}

type Listener<T> = (payload: T) => void;

export interface PtyHostSupervisor {
  /** Start a session, lazily starting the host if this is the first one. */
  spawn(request: Omit<SpawnCommand, 'type'>): void;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  kill(sessionId: string, signal?: string): void;
  /**
   * Stop / start the pty reading its fd (story 093).
   *
   * Silent for an unknown session rather than an error: flow control runs on a
   * timer against a session the user may have just killed, and a race there is
   * ordinary, not a fault worth surfacing in the feed.
   */
  pause(sessionId: string): void;
  resume(sessionId: string): void;

  onData(listener: Listener<DataMessage>): () => void;
  onExit(listener: Listener<ExitMessage>): () => void;
  onSpawned(listener: Listener<SpawnedMessage>): () => void;
  onError(listener: Listener<ErrorMessage>): () => void;
  onSessionLost(listener: Listener<SessionLost>): () => void;

  /** Ask the host to kill everything and exit; force-kill after the timeout. */
  shutdown(): Promise<void>;

  /** Diagnostics — story 093 surfaces these through `app:info`. */
  isRunning(): boolean;
  isBlocked(): boolean;
  sessionIds(): string[];
}

function emitter<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    add(listener: Listener<T>): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(payload: T): void {
      for (const listener of [...listeners]) listener(payload);
    },
  };
}

export function createPtyHostSupervisor(
  options: SupervisorOptions,
): PtyHostSupervisor {
  const {
    fork,
    now = Date.now,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    missedBeatLimit = MISSED_BEAT_LIMIT,
    shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
    crashWindowMs = CRASH_WINDOW_MS,
    crashLimit = CRASH_LIMIT,
  } = options;

  const data = emitter<DataMessage>();
  const exit = emitter<ExitMessage>();
  const spawned = emitter<SpawnedMessage>();
  const errors = emitter<ErrorMessage>();
  const lost = emitter<SessionLost>();

  let child: HostChild | null = null;
  /** The host has emitted `spawn`; before that, `postMessage` has nowhere to go. */
  let ready = false;
  /** Commands issued before the host was ready. Flushed in order on `spawn`. */
  let outbox: HostCommand[] = [];

  /** Sessions this host owns. Membership is the ownership check. */
  const sessions = new Set<string>();

  const crashes: number[] = [];
  let blocked = false;

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unanswered = 0;
  let pingSeq = 0;

  /** Set while a deliberate shutdown is in flight, so exit is not a crash. */
  let shuttingDown = false;
  let onExited: (() => void) | null = null;

  function post(command: HostCommand): void {
    if (!child) return;
    // Queued rather than dropped: `spawn` is issued the moment the host is
    // forked, and Electron gives no guarantee the child's port is attached
    // yet. A dropped spawn is a terminal that never opens and never explains
    // why.
    if (!ready) {
      outbox.push(command);
      return;
    }
    child.postMessage(command);
  }

  function stopHeartbeat(): void {
    if (heartbeat === null) return;
    clearInterval(heartbeat);
    heartbeat = null;
    unanswered = 0;
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    heartbeat = setInterval(() => {
      if (unanswered >= missedBeatLimit) {
        // A host can hang without exiting, and a hang is indistinguishable
        // from a dead terminal to the user unless something is watching.
        // Killing it converts an ambiguous hang into an unambiguous crash.
        const hung = child;
        if (!hung) return;
        child = null;
        ready = false;
        hung.kill();
        handleCrash();
        return;
      }
      unanswered += 1;
      pingSeq += 1;
      // Deliberately not `post` — a queued ping would answer itself late and
      // mask exactly the condition being measured.
      if (child && ready) child.postMessage({ type: 'ping', seq: pingSeq });
    }, heartbeatIntervalMs);
  }

  function handleCrash(): void {
    stopHeartbeat();
    child = null;
    ready = false;
    outbox = [];

    crashes.push(now());
    // Only crashes inside the window count; an app that has been up for days
    // must not trip the guard on its fourth unrelated crash.
    const cutoff = now() - crashWindowMs;
    while (crashes.length > 0 && crashes[0]! < cutoff) crashes.shift();

    /**
     * Sessions are **not** silently resurrected.
     *
     * A restarted host has no memory of the processes the old one owned —
     * those children are gone. Re-spawning `claude` in the same repository
     * without asking could rerun work the user did not ask for. The user
     * restarts a session explicitly (story 096).
     */
    for (const sessionId of [...sessions]) {
      lost.emit({ sessionId, reason: 'host-crashed' });
    }
    sessions.clear();

    if (crashes.length >= crashLimit) {
      blocked = true;
      errors.emit({
        type: 'error',
        message: `pty host crashed ${crashes.length} times in ${Math.round(
          crashWindowMs / 1000,
        )}s — not restarting. Restart The Hive once the cause is fixed.`,
      });
    }
  }

  function handleMessage(message: HostMessage): void {
    switch (message.type) {
      case 'pong':
        unanswered = 0;
        return;
      case 'ping':
        // The protocol allows the host to ping; answering costs nothing and
        // keeps the two sides symmetric. A *pong*, not a ping — replying with
        // a ping would ask the question back instead of answering it.
        post({ type: 'pong', seq: message.seq });
        return;
      case 'data':
        if (!sessions.has(message.sessionId)) return;
        data.emit(message);
        return;
      case 'spawned':
        if (!sessions.has(message.sessionId)) return;
        spawned.emit(message);
        return;
      case 'exit':
        // An ordinary exit, not a crash: the session is gone, the host is not.
        if (!sessions.delete(message.sessionId)) return;
        exit.emit(message);
        return;
      case 'error':
        errors.emit(message);
        return;
    }
  }

  function start(): void {
    const instance = fork();
    child = instance;
    ready = false;
    outbox = [];

    instance.on('spawn', () => {
      if (child !== instance) return;
      ready = true;
      const queued = outbox;
      outbox = [];
      for (const command of queued) instance.postMessage(command);
      startHeartbeat();
    });

    instance.on('message', (message) => {
      if (child !== instance) return;
      handleMessage(message);
    });

    instance.on('exit', () => {
      // Guarded so a host we already replaced or deliberately killed cannot
      // report a second crash on its way out.
      if (child !== instance) {
        onExited?.();
        return;
      }
      child = null;
      ready = false;
      if (shuttingDown) {
        stopHeartbeat();
        onExited?.();
        return;
      }
      handleCrash();
    });
  }

  /** Reject rather than forward. A session id we do not own is not ours to act on. */
  function owned(sessionId: string, verb: string): boolean {
    if (sessions.has(sessionId)) return true;
    errors.emit({
      type: 'error',
      sessionId,
      message: `${verb}: unknown session "${sessionId}"`,
    });
    return false;
  }

  return {
    spawn(request) {
      if (blocked) {
        errors.emit({
          type: 'error',
          sessionId: request.sessionId,
          message:
            'the pty host is not running — it crashed repeatedly and restarts are disabled',
        });
        return;
      }
      if (sessions.has(request.sessionId)) {
        errors.emit({
          type: 'error',
          sessionId: request.sessionId,
          message: `spawn: session "${request.sessionId}" already exists`,
        });
        return;
      }

      /**
       * Lazy start. Most launches land on the orchestrator console (041),
       * which owns no PTY — starting a process for it is waste.
       */
      if (!child) start();

      sessions.add(request.sessionId);
      post({ type: 'spawn', ...request });
    },

    write(sessionId, data: string) {
      if (!owned(sessionId, 'write')) return;
      post({ type: 'write', sessionId, data });
    },

    resize(sessionId, cols, rows) {
      if (!owned(sessionId, 'resize')) return;
      post({ type: 'resize', sessionId, cols, rows });
    },

    kill(sessionId, signal) {
      if (!owned(sessionId, 'kill')) return;
      post({ type: 'kill', sessionId, signal });
    },

    pause(sessionId) {
      if (!sessions.has(sessionId)) return;
      post({ type: 'pause', sessionId });
    },

    resume(sessionId) {
      if (!sessions.has(sessionId)) return;
      post({ type: 'resume', sessionId });
    },

    onData: data.add,
    onExit: exit.add,
    onSpawned: spawned.add,
    onError: errors.add,
    onSessionLost: lost.add,

    async shutdown() {
      const instance = child;
      if (!instance) {
        stopHeartbeat();
        return;
      }

      shuttingDown = true;
      stopHeartbeat();

      /**
       * Ask first, then insist.
       *
       * This is what stops `claude` processes surviving app quit: the host
       * kills every session's process group before exiting. `kill()` alone
       * would take the host down and leave its children orphaned, which is
       * the bug story 098 asserts against.
       */
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          onExited = null;
          resolve();
        };

        const timer = setTimeout(() => {
          // Graceful exit did not happen. The app must still quit.
          instance.kill();
          finish();
        }, shutdownTimeoutMs);

        onExited = finish;
        if (ready) instance.postMessage({ type: 'shutdown' });
        else instance.kill();
      });

      child = null;
      ready = false;
      outbox = [];
      sessions.clear();
      shuttingDown = false;
    },

    isRunning: () => child !== null,
    isBlocked: () => blocked,
    sessionIds: () => [...sessions],
  };
}
