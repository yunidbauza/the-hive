import { StringDecoder } from 'node:string_decoder';

import { spawn as spawnPty, type IPty } from 'node-pty';

import {
  KILL_GRACE_MS,
  MAX_SESSIONS,
  SCROLLBACK_BYTES,
  SHUTDOWN_TIMEOUT_MS,
  type HostMessage,
  type SpawnCommand,
} from '@shared/pty-host-protocol';

import { TERM, buildEnv } from './env';
import {
  processControl,
  type Descendant,
  type ProcessControl,
} from './process-tree';
import { Scrollback } from './scrollback';
import type { SessionOperations } from './sessions';

/**
 * The PTY session manager (story 092).
 *
 * **This is the story the whole desktop epic exists for.** Everything else is
 * plumbing around it.
 *
 * What makes a terminal real is not the renderer — xterm.js has been rendering
 * this app's fixtures since story 042. What has been missing is a kernel-level
 * pty pair behind it, with a process whose controlling terminal it is. That
 * gives, for free and without a line of UI code: SGR colour, cursor
 * addressing, the alternate screen, `SIGWINCH` on resize, `SIGINT` from
 * Ctrl-C, job control, and `isatty()` returning true so tools enable their
 * interactive paths — which is precisely why Claude Code's TUI renders at all.
 */

export interface SessionManagerOptions {
  maxSessions?: number;
  scrollbackBytes?: number;
  killGraceMs?: number;
  /** The environment sessions inherit from. Injected so tests are hermetic. */
  baseEnv?: NodeJS.ProcessEnv;
  /**
   * Signals and process-table access. Injected so no test signals a real
   * process or execs a real `ps`.
   */
  control?: ProcessControl;
  /** Injected so tests never load the real native addon. */
  spawn?: typeof spawnPty;
}

export interface SessionManager extends SessionOperations {
  /**
   * The buffered transcript, or `null` for a session that never existed.
   *
   * The seam story 093 reaches for when a surface attaches: it sends this
   * before the first live chunk, which is what makes a late-mounting terminal
   * show what it missed.
   */
  replay(sessionId: string): string | null;
  /** Live session ids, in creation order. */
  sessionIds(): string[];
  /** Whether a session exists and has not exited. */
  isLive(sessionId: string): boolean;
}

interface Session {
  pty: IPty;
  pid: number;
  /**
   * Holds a partial multi-byte sequence until the next chunk completes it.
   *
   * Not fastidiousness — a real defect. A multi-byte character can straddle a
   * read boundary, and decoding each chunk independently turns the split
   * character into replacement characters *permanently*, since the damage
   * happens before the bytes reach xterm. A terminal running Claude Code
   * renders box-drawing characters and emoji constantly, so this is a when,
   * not an if.
   */
  decoder: StringDecoder;
  buffer: Scrollback;
  emit: (message: HostMessage) => void;
  status: 'live' | 'exited';
  /** Tracked so a redundant pause/resume cannot desynchronise the fd. */
  paused: boolean;
  cols: number;
  rows: number;
}

/**
 * A moment for a job that took SIGHUP to finish going.
 *
 * A courtesy, not a correctness requirement — the sweep would be correct
 * without it, just quicker to SIGKILL something that was already leaving.
 */
const SWEEP_SETTLE_MS = 250;

/**
 * The wall clock the whole teardown has to finish inside.
 *
 * `supervisor.shutdown()` arms a `SHUTDOWN_TIMEOUT_MS` timer **before** it even
 * posts the shutdown message, and force-kills the host when it fires. A
 * teardown that overruns is killed mid-sweep — orphaning the descendant this
 * code exists to reap, by way of the fix's own latency.
 *
 * So the budget is *derived* from that timeout and threaded through as a
 * deadline, rather than summed from independent constants and hoped to fit.
 * Summing is how the first version of this got it wrong: `ps` (up to 2s) then
 * the grace (2s) then the settle (250ms) are sequential, not overlapping, so
 * the real worst case was 4.25s against a 3s limit.
 */
const TEARDOWN_BUDGET_MS = SHUTDOWN_TIMEOUT_MS - 500;

/** Whatever is left of the budget, never negative. */
const remaining = (deadline: number): number =>
  Math.max(0, deadline - Date.now());

export function createSessionManager(
  options: SessionManagerOptions = {},
): SessionManager {
  const {
    maxSessions = MAX_SESSIONS,
    scrollbackBytes = SCROLLBACK_BYTES,
    killGraceMs = KILL_GRACE_MS,
    baseEnv = process.env,
    control = processControl,
    spawn = spawnPty,
  } = options;

  const sessions = new Map<string, Session>();

  /**
   * Notified whenever a session reaches `exited`.
   *
   * `killAll` waits on this rather than polling: teardown is on the app's quit
   * path, where a 10ms interval is both wasteful and the kind of thing that
   * keeps an event loop alive just long enough to be confusing.
   */
  const exitWatchers = new Set<() => void>();

  function fail(
    sessionId: string,
    emit: (message: HostMessage) => void,
    message: string,
  ): void {
    emit({ type: 'error', sessionId, message });
  }

  /** Signal a group, tolerating a process that is already gone. */
  function signalGroup(pgid: number, sig: NodeJS.Signals): void {
    try {
      control.signalGroup(pgid, sig);
    } catch {
      // ESRCH — it died between the decision and the signal. Nothing to do,
      // and certainly nothing to fail the app over.
    }
  }

  /** Signal one process, same tolerance. */
  function signalPid(pid: number, sig: NodeJS.Signals): void {
    try {
      control.signalPid(pid, sig);
    } catch {
      // As above.
    }
  }

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  function handleExit(
    sessionId: string,
    session: Session,
    exitCode: number,
    exitSignal?: number,
  ): void {
    // A process exits once, but nothing about `onExit` guarantees the event
    // fires once. A second `exit` message would break story 093's ordering
    // contract, which promises exit lands after the final data flush — twice
    // means the second one lands after nothing.
    if (session.status === 'exited') return;

    // Flush whatever the decoder was still holding, so a transcript never ends
    // mid-character.
    const tail = session.decoder.end();
    if (tail !== '') {
      session.buffer.push(tail);
      session.emit({ type: 'data', sessionId, chunk: tail });
    }

    session.status = 'exited';

    /**
     * The buffer is **retained**, not cleared.
     *
     * A terminal that empties itself the instant a process dies destroys the
     * error the user needed to read. Cleanup happens when the user closes the
     * session, not when the process ends.
     */
    session.emit({ type: 'exit', sessionId, exitCode, signal: exitSignal });

    for (const watcher of [...exitWatchers]) watcher();
  }

  /** Wait for every target to exit, SIGKILLing whatever outlasts the grace. */
  function waitForExit(
    targets: readonly Session[],
    deadline: number,
  ): Promise<void> {
    const allGone = () => targets.every((session) => session.status !== 'live');

    // The grace is whichever is shorter: the usual one, or what is left of the
    // budget once the sweep has been reserved its settle.
    const grace = Math.min(
      killGraceMs,
      Math.max(0, remaining(deadline) - SWEEP_SETTLE_MS),
    );

    return new Promise<void>((resolve) => {
      if (allGone()) {
        resolve();
        return;
      }

      const finish = () => {
        clearTimeout(timer);
        exitWatchers.delete(watcher);
        resolve();
      };

      const timer = setTimeout(() => {
        // Grace expired. Anything still alive gets SIGKILL, and the app stops
        // waiting on it — "the app would not quit" is worse than "one teardown
        // step was abrupt".
        for (const session of targets) {
          if (session.status === 'live') signalGroup(session.pid, 'SIGKILL');
        }
        finish();
      }, grace);

      const watcher = () => {
        if (allGone()) finish();
      };

      exitWatchers.add(watcher);
    });
  }

  /**
   * Kill anything from the snapshot that is still running.
   *
   * Unconditional, and that is the point. The tempting shortcut — stop once
   * the shells have exited — is exactly the leak HIVE-72 describes: a shell
   * takes SIGHUP and goes promptly while a descendant that ignores hangup
   * carries on, invisible, holding the tokens.
   */
  async function sweep(
    snapshot: readonly Descendant[],
    deadline: number,
  ): Promise<void> {
    if (snapshot.length === 0) return;

    // Nothing to be courteous to. Checking before sleeping keeps the common
    // case — every job took the hangup and left — off the quit path entirely.
    if (!snapshot.some(({ pid }) => control.isAlive(pid))) return;

    const settle = Math.min(SWEEP_SETTLE_MS, remaining(deadline));
    if (settle > 0) await delay(settle);

    const survivors = snapshot.filter(({ pid }) => control.isAlive(pid));
    if (survivors.length === 0) return;

    // The group first — it reaches children the job spawned after the snapshot
    // was taken, which by definition are not in it.
    for (const pgid of new Set(survivors.map((d) => d.pgid))) {
      signalGroup(pgid, 'SIGKILL');
    }

    for (const { pid } of survivors) {
      if (control.isAlive(pid)) signalPid(pid, 'SIGKILL');
    }
  }

  /**
   * Teardowns started by `kill` that have not finished yet.
   *
   * `killAll` waits on these as well as its own. Without that, closing a tab
   * and then quitting within the sweep's settle window abandons the sweep: the
   * shell is already `exited`, so `killAll` sees no live session, returns
   * immediately, and `host.ts` calls `process.exit` out from under the pending
   * work — leaving exactly the orphan this file exists to prevent.
   */
  const inFlight = new Set<Promise<void>>();

  /** Track a teardown, and make sure a rejection cannot take the host down. */
  function track(work: Promise<void>): void {
    const settled = work.catch(() => {
      /**
       * Every signal inside teardown is already ESRCH-tolerant, so this can
       * only fire for a `ProcessControl` whose `descendants` rejects. Losing
       * one sweep is bad; an unhandled rejection killing the pty-host and
       * every live session with it is worse.
       */
    });

    inFlight.add(settled);
    void settled.finally(() => inFlight.delete(settled));
  }

  /** The one teardown both `kill` and `killAll` run. */
  async function teardown(
    targets: readonly Session[],
    sig: NodeJS.Signals,
  ): Promise<void> {
    if (targets.length === 0) return;

    const deadline = Date.now() + TEARDOWN_BUDGET_MS;

    /**
     * Before any signal, without exception.
     *
     * Once a shell dies its children are reparented to launchd/init and the
     * `ppid` linkage that identifies them is gone for good. There is no
     * reading the tree afterwards — snapshot first or do not snapshot at all.
     */
    const snapshot = await control
      .descendants(targets.map((session) => session.pid))
      .catch(() => {
        /**
         * A tree we could not read must not stop the shells being killed.
         *
         * The shipped `ProcessControl` already answers `[]` for any failure,
         * but the interface permits a rejection, and letting one propagate
         * here would abandon teardown *before the first signal* — turning a
         * failed `ps` into "no session was killed at all", which is far worse
         * than the group-kill-only behaviour this degrades to.
         */
        return [] as Descendant[];
      });

    for (const session of targets) signalGroup(session.pid, sig);

    await waitForExit(targets, deadline);
    await sweep(snapshot, deadline);
  }

  return {
    spawn(command: SpawnCommand, emit) {
      const { sessionId, shell, args, cwd, cols, rows } = command;

      if (sessions.has(sessionId)) {
        fail(sessionId, emit, `session "${sessionId}" already exists`);
        return;
      }

      /**
       * The cap counts **live** sessions, not registry entries.
       *
       * Exited entries are retained on purpose — their transcript is the error
       * the user still needs to read — but they own no process. Counting them
       * would mean an app that has opened and closed 24 sessions over a long
       * session can never open a 25th, with a message blaming a limit that
       * nothing is currently using.
       */
      const live = [...sessions.values()].filter(
        (session) => session.status === 'live',
      ).length;

      if (live >= maxSessions) {
        // Refused with a clear error rather than letting the app fork-bomb a
        // laptop.
        fail(
          sessionId,
          emit,
          `session limit reached (${maxSessions}) — close a session before opening another`,
        );
        return;
      }

      let pty: IPty;
      try {
        pty = spawn(shell, args, {
          // `TERM` in the child. See `env.ts` — the single most consequential
          // option here.
          name: TERM,
          cwd,
          env: buildEnv(baseEnv, cwd, command.env, command.stripEnv),
          cols: Math.max(1, cols),
          rows: Math.max(1, rows),
          /**
           * Buffers rather than strings, decoded through a per-session
           * `StringDecoder`. See {@link Session.decoder} — this is what stops
           * a character split across a read boundary becoming permanent
           * mojibake.
           */
          encoding: null,
        });
      } catch (cause) {
        fail(
          sessionId,
          emit,
          `could not start ${shell} in ${cwd}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        return;
      }

      const session: Session = {
        pty,
        pid: pty.pid,
        decoder: new StringDecoder('utf8'),
        buffer: new Scrollback(scrollbackBytes),
        emit,
        status: 'live',
        paused: false,
        cols: Math.max(1, cols),
        rows: Math.max(1, rows),
      };
      sessions.set(sessionId, session);

      pty.onData((chunk: string | Buffer) => {
        // node-pty types `onData` as `string`, but `encoding: null` yields
        // Buffers — the one option its types do not model. Both are handled
        // rather than asserting away the discrepancy.
        const text = session.decoder.write(
          typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk,
        );
        if (text === '') return;
        session.buffer.push(text);
        session.emit({ type: 'data', sessionId, chunk: text });
      });

      pty.onExit(({ exitCode, signal: exitSignal }) => {
        handleExit(sessionId, session, exitCode, exitSignal);
      });

      emit({ type: 'spawned', sessionId, pid: pty.pid });
    },

    write(sessionId, data) {
      const session = sessions.get(sessionId);
      if (!session || session.status !== 'live') return;
      /**
       * Straight through. No interpretation, no line handling, no echo — the
       * pty and the shell own all of that. A transport that helpfully appended
       * a newline would break every interactive prompt.
       */
      session.pty.write(data);
    },

    resize(sessionId, cols, rows) {
      const session = sessions.get(sessionId);
      if (!session || session.status !== 'live') return;

      /**
       * **Dropped, not clamped** — found by the conformance suite (story 098).
       *
       * xterm reports 0 transiently while its container is hidden or
       * mid-layout, and resizing a pty to zero columns puts curses
       * applications into states they do not recover from. That much was
       * always right. Clamping to 1 was not: a 1×1 pty is not a recovery, it
       * is the same catastrophe one column wider — and nothing ever resizes it
       * back, because the *renderer's* own geometry never changed, so it has
       * no reason to send anything new. The session is simply ruined until
       * something else happens to resize it.
       *
       * A nonsensical size is not a request to be honoured approximately; it
       * is a frame of bad measurement to be ignored. Story 098's matrix says
       * so directly: "zero-size resizes are dropped → geometry unchanged".
       */
      const nextCols = Math.floor(cols);
      const nextRows = Math.floor(rows);
      if (!Number.isFinite(nextCols) || !Number.isFinite(nextRows)) return;
      if (nextCols < 1 || nextRows < 1) return;

      // A no-op resize is still a SIGWINCH to the child, and a redraw.
      if (nextCols === session.cols && nextRows === session.rows) return;

      session.cols = nextCols;
      session.rows = nextRows;
      session.pty.resize(nextCols, nextRows);
    },

    kill(sessionId, sig = 'SIGHUP') {
      const session = sessions.get(sessionId);
      if (!session || session.status !== 'live') return;

      /**
       * Ask, wait, then insist — and ask with SIGHUP.
       *
       * An interactive shell ignores SIGTERM, so the old escalation always
       * reached SIGKILL, and a SIGKILLed shell cannot hang up its own jobs.
       * SIGHUP is what a closing terminal sends, and the shell answers it by
       * hanging up every job it owns.
       *
       * Closing one session leaks its background jobs by exactly the mechanism
       * app-quit does, so it runs the same teardown. Fire-and-forget, because
       * `SessionOperations.kill` is synchronous; every signal inside tolerates
       * a process that is already gone.
       */
      track(teardown([session], sig as NodeJS.Signals));
    },

    pause(sessionId) {
      const session = sessions.get(sessionId);
      if (!session || session.status !== 'live' || session.paused) return;
      session.paused = true;
      // Stops reading the fd. The kernel pty buffer fills and the producing
      // process blocks on write — the same thing that happens when you pipe to
      // a slow consumer in a shell.
      session.pty.pause();
    },

    resume(sessionId) {
      const session = sessions.get(sessionId);
      if (!session || session.status !== 'live' || !session.paused) return;
      session.paused = false;
      session.pty.resume();
    },

    async killAll() {
      await teardown(
        [...sessions.values()].filter((session) => session.status === 'live'),
        'SIGHUP',
      );

      /**
       * Then wait out anything `kill` started and has not finished.
       *
       * Loops rather than awaiting once because a `kill` can land while the
       * first batch is settling. It terminates: teardown never starts another
       * teardown, so the set only drains.
       */
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },

    replay(sessionId) {
      return sessions.get(sessionId)?.buffer.read() ?? null;
    },

    sessionIds: () => [...sessions.keys()],

    isLive: (sessionId) => sessions.get(sessionId)?.status === 'live',
  };
}
