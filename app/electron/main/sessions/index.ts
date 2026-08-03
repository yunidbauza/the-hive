import type { ConfigSnapshot } from '@shared/config-contract';
import {
  CH,
  type DataEvent,
  type ExitEvent,
  type PtyDiagnostics,
  type SessionLostEvent,
} from '@shared/ipc-contract';
import { MAX_SESSIONS } from '@shared/pty-host-protocol';
import {
  spawnRefusal,
  type DerivedStatus,
  type SessionStatusEvent,
} from '@shared/session-contract';

import { createPtyIpc, type PtyIpc } from '../ipc/pty';
import type { PtyHostSupervisor } from '../pty-host/supervisor';

import { createActivityTracker, type ActivityTracker } from './activity';
import { createBootstrap, type Bootstrap } from './bootstrap';
import { createSessionRegistry, type SessionRegistry } from './registry';

/**
 * Sessions: what a terminal actually *is* in this app (story 096).
 *
 * The layer between "a pty exists" and "a session is running". It owns three
 * things the PTY layers deliberately do not:
 *
 * - **What to run.** `$SHELL -l`, then `claude` written in as input.
 * - **Identity.** `entityId → sessionId → pty`, and a fresh session id per
 *   restart so stale output is droppable.
 * - **Lifecycle.** Attach-never-respawn, restart-as-an-ordering, and teardown.
 *
 * It wraps `PtyIpc` rather than sitting beside it, because every event in both
 * directions has to be translated between the two id spaces and there must be
 * no path around that translation.
 */

export interface SessionsOptions {
  supervisor: PtyHostSupervisor;
  /** Push an event to the renderer. Injected — no `BrowserWindow` in here. */
  send: (channel: string, payload: unknown) => void;
  /** The workspace config, read per call so a reload is picked up. */
  config: () => ConfigSnapshot;
  maxSessions?: number;
}

export interface OpenRequest {
  entityId: string;
  projectId: string;
  cols: number;
  rows: number;
  /**
   * The session's first instruction, delivered after the bootstrap (story 097).
   *
   * Absent on `restart`, and on every `open` that is really an attach — see
   * the note on `restartOnce`.
   */
  task?: string;
}

export interface Sessions {
  /** Spawn, bootstrap and attach — or attach to what is already running. */
  open(request: OpenRequest): void;
  write(entityId: string, data: string): void;
  resize(entityId: string, cols: number, rows: number): void;
  ack(entityId: string, seq: number): void;
  kill(entityId: string): void;
  /** Kill, wait for the exit, then spawn a fresh process and bootstrap it. */
  restart(request: OpenRequest): Promise<void>;
  /** Live entity ids, for diagnostics and the session cap. */
  entities(): string[];
  diagnostics(): PtyDiagnostics[];
  dispose(): void;
}

/**
 * The login shell, and why the flag is not optional.
 *
 * `-l` sources the user's full profile, which is what puts `claude`,
 * nvm-managed node, mise/asdf shims and everything else on `PATH`. A non-login
 * shell finds none of it, and the failure is `claude: command not found` in an
 * app whose entire purpose is running `claude`.
 */
const LOGIN_SHELL_ARGS = ['-l'];

/**
 * How long a restart waits for the old process to die before giving up.
 *
 * Comfortably past the host's own SIGTERM-then-SIGKILL escalation, so this only
 * fires when that escalation itself has failed — which means the host is wedged,
 * not that the process is slow.
 */
const RESTART_EXIT_TIMEOUT_MS = 10_000;

export function createSessions(options: SessionsOptions): Sessions {
  const { supervisor, send, config, maxSessions = MAX_SESSIONS } = options;

  const registry: SessionRegistry = createSessionRegistry();
  /** Resolvers waiting for a specific entity's process to exit. */
  const exitWaiters = new Map<string, (() => void)[]>();
  /**
   * Input written before the session finished bootstrapping.
   *
   * Held rather than delivered, because until the bootstrap has run the pty is
   * a bare login shell: a message routed there (story 097) would be executed by
   * the *shell* as a command line instead of reaching the agent, and the user
   * would see a `command not found` where they expected an answer. The renderer
   * cannot know — it can see that a process exists, not what is running in it —
   * so main holds the input and releases it in order once the agent is up.
   *
   * The same ordering the task stage already relies on, applied to everything
   * else that arrives in the same window.
   */
  const heldInput = new Map<string, string[]>();

  /** Release everything held for this entity, in the order it was written. */
  function flushHeldInput(entityId: string): void {
    const held = heldInput.get(entityId);
    heldInput.delete(entityId);
    if (!held) return;

    const sessionId = registry.sessionFor(entityId);
    if (sessionId === undefined) return;
    for (const data of held) ptyIpc.write(sessionId, data);
  }
  /** In-flight restarts, so a second request joins rather than races. */
  const restarting = new Map<string, Promise<void>>();

  /**
   * Everything main pushes to the renderer passes through here, and the
   * translation is the point.
   *
   * An event whose session id no longer maps to an entity belongs to a
   * generation that has been restarted away. It is dropped rather than
   * forwarded — that is the mechanism the registry exists for.
   */
  function forward(channel: string, payload: unknown): void {
    const event = payload as { sessionId?: string };
    const sessionId = event.sessionId;
    if (sessionId === undefined) return;

    const entityId = registry.entityFor(sessionId);
    if (entityId === undefined) return;

    switch (channel) {
      case CH.ptyData: {
        const data = payload as DataEvent;
        activity.sawOutput(entityId);
        bootstrap.sawOutput(entityId);
        send(channel, { ...data, sessionId: entityId } satisfies DataEvent);
        return;
      }
      case CH.ptyExit: {
        const data = payload as ExitEvent;
        send(channel, { ...data, sessionId: entityId } satisfies ExitEvent);
        settleExit(entityId);
        return;
      }
      case CH.ptyLost: {
        const data = payload as SessionLostEvent;
        send(channel, { ...data, sessionId: entityId } satisfies SessionLostEvent);
        settleExit(entityId);
        return;
      }
      default:
        send(channel, payload);
    }
  }

  const activity: ActivityTracker = createActivityTracker({
    onStatus: (entityId, status) => publishStatus(entityId, status),
  });

  const bootstrap: Bootstrap = createBootstrap({
    write: (entityId, data) => {
      const sessionId = registry.sessionFor(entityId);
      if (sessionId === undefined) return;
      ptyIpc.write(sessionId, data);
    },
    onComplete: (entityId) => flushHeldInput(entityId),
    onSilentStart: (entityId) => {
      // Recorded rather than silent: five seconds of no output at all is
      // unusual, and if the bootstrap also fails to take, this is the fact
      // that explains it.
      console.info(
        `[hive] ${entityId}: no shell output within the startup window — bootstrap written anyway`,
      );
    },
  });

  /**
   * Constructed last because `forward` is its `send`, and `forward` reaches the
   * activity tracker and the bootstrap above. Every reference runs inside a
   * callback, well after this line, so the cycle is only in the source order.
   */
  const ptyIpc: PtyIpc = createPtyIpc({ supervisor, send: forward });

  function publishStatus(entityId: string, status: DerivedStatus): void {
    send(CH.sessionStatus, { entityId, status } satisfies SessionStatusEvent);
  }

  /**
   * The process for this entity is gone.
   *
   * Ordering matters: the exit event has already been forwarded by the time
   * this runs, so closing the registry here is what makes every *later* message
   * for that session id undeliverable.
   */
  function settleExit(entityId: string): void {
    bootstrap.cancel(entityId);
    heldInput.delete(entityId);
    activity.exited(entityId);
    registry.close(entityId);

    const waiters = exitWaiters.get(entityId);
    if (!waiters) return;
    exitWaiters.delete(entityId);
    for (const resolve of waiters) resolve();
  }

  /**
   * Kill, **wait for the exit**, then spawn. An ordering, not a set.
   *
   * Spawning before the old process is reaped means two `claude` instances in
   * one repository writing the same files. Waiting is what makes the new
   * generation genuinely new.
   */
  async function restartOnce(request: OpenRequest): Promise<void> {
    const sessionId = registry.sessionFor(request.entityId);

    if (sessionId !== undefined) {
      const exit = new Promise<void>((resolve, reject) => {
        const waiters = exitWaiters.get(request.entityId) ?? [];
        waiters.push(resolve);
        exitWaiters.set(request.entityId, waiters);

        /**
         * A bound of this layer's own, rather than trust in two others.
         *
         * The host escalates SIGTERM to SIGKILL and the supervisor's heartbeat
         * eventually condemns a hung host, so in practice the exit arrives. But
         * this promise is awaited across an `invoke`, so if it ever did not, the
         * renderer's `restart()` would hang forever with no error and no
         * timeout — a spinner that never resolves.
         *
         * It **rejects** rather than proceeding. Spawning anyway would mint a
         * fresh session id, which the supervisor would happily accept, leaving
         * two live shells in one repository — the exact outcome the wait exists
         * to prevent, arrived at by way of a safety net.
         */
        setTimeout(() => {
          reject(
            new Error(
              `restart: ${request.entityId} did not exit within ${RESTART_EXIT_TIMEOUT_MS}ms — its process may still be running`,
            ),
          );
        }, RESTART_EXIT_TIMEOUT_MS);
      });

      ptyIpc.kill(sessionId);
      await exit;
    }

    /**
     * The task is dropped, not replayed (story 097).
     *
     * A restart discards a running agent's context on purpose. Re-delivering
     * the instruction it may already have acted on — files edited, a PR opened
     * — would make "start again" mean "do it twice". The renderer does not send
     * one on restart either; this is the belt to that braces, because
     * `restartOnce` takes the same `OpenRequest` shape as `open`.
     */
    spawn({ ...request, task: undefined });
  }

  /** Refuse with a message the user can act on, never a generic failure. */
  function spawn(request: OpenRequest): void {
    const snapshot = config();

    if (registry.size() >= maxSessions) {
      throw new Error(spawnRefusal({ reason: 'at-capacity', limit: maxSessions }));
    }

    /**
     * A crash-blocked host cannot start anything, and saying "not mapped" or
     * failing silently would send the user to edit a config file that is
     * perfectly correct.
     */
    if (supervisor.isBlocked()) {
      throw new Error(spawnRefusal({ reason: 'host-unavailable' }));
    }

    const project = snapshot.projects.find(
      (entry) => entry.id === request.projectId,
    );
    if (!project || project.status !== 'ok' || project.path === null) {
      throw new Error(
        spawnRefusal({
          reason: 'unmapped',
          projectId: request.projectId,
          configPath: snapshot.configPath,
        }),
      );
    }

    /**
     * A new generation starts with no status history.
     *
     * Without this the tracker keeps the previous generation's terminal `done`,
     * and `done` is deliberately sticky — output after an exit must not
     * resurrect a dead session, or the last bytes of a finished process would
     * strand it claiming to be busy forever. That guard is right, and it is
     * exactly what makes a *restarted* session invisible: its new process
     * produces output, the tracker sees an entity it already considers
     * finished, and the status never leaves `done` again.
     *
     * Forgetting here is the seam between the two: the entity is the same, the
     * session is not.
     */
    activity.forget(request.entityId);

    const sessionId = registry.open(request.entityId);

    ptyIpc.spawn({
      sessionId,
      shell: snapshot.shell,
      args: LOGIN_SHELL_ARGS,
      cwd: project.path,
      /**
       * Nothing added. The host builds the environment (story 092); a session
       * inherits the user's, which is the only environment in which their
       * `claude` and their tooling behave the way they do outside this app.
       */
      env: {},
      cols: request.cols,
      rows: request.rows,
    });

    bootstrap.arm(request.entityId, snapshot.claudeCommand, request.task);
  }

  return {
    open(request) {
      /**
       * **Attach, never respawn.** The invariant that makes the product work.
       *
       * The user navigates between sessions constantly, and every one of those
       * navigations re-subscribes a transport. A respawn on any of them would
       * discard a running agent's context — the single most destructive thing
       * this layer could do — so an entity that already holds a live session
       * gets nothing but its existing output stream.
       */
      if (registry.sessionFor(request.entityId) !== undefined) return;
      spawn(request);
    },

    write(entityId, data) {
      const sessionId = registry.sessionFor(entityId);
      if (sessionId === undefined) return;

      /**
       * Held, not dropped and not delivered early. See {@link heldInput}.
       *
       * Keystrokes typed directly into the terminal take this path too, which
       * is the right behaviour for the same reason: anything typed while
       * `claude` is still starting would otherwise be eaten by the shell.
       */
      if (bootstrap.isPending(entityId)) {
        const held = heldInput.get(entityId) ?? [];
        held.push(data);
        heldInput.set(entityId, held);
        return;
      }

      ptyIpc.write(sessionId, data);
    },

    resize(entityId, cols, rows) {
      const sessionId = registry.sessionFor(entityId);
      if (sessionId === undefined) return;
      ptyIpc.resize(sessionId, cols, rows);
    },

    ack(entityId, seq) {
      const sessionId = registry.sessionFor(entityId);
      if (sessionId === undefined) return;
      ptyIpc.ack(sessionId, seq);
    },

    kill(entityId) {
      const sessionId = registry.sessionFor(entityId);
      if (sessionId === undefined) return;
      // The transcript stays readable — killing ends the process, it does not
      // clear the terminal.
      ptyIpc.kill(sessionId);
    },

    restart(request) {
      /**
       * One restart per entity at a time, and a second request **joins** the
       * first rather than starting its own.
       *
       * Without this the two are genuinely destructive rather than merely
       * redundant: both read the same live session id, both wait on the same
       * exit, and both then spawn. The second `registry.open` overwrites the
       * first's mapping, so the first new shell is orphaned — still running,
       * not counted against the cap, not reachable through `entities()`, and
       * invisible until the app quits. Two `claude` processes in one repository,
       * one of which nothing can address.
       *
       * Joining is also the right *semantics*. Two restarts issued together mean
       * "restart it", not "restart it twice" — and restarting twice would kill
       * the process the first one had only just started.
       */
      const inFlight = restarting.get(request.entityId);
      if (inFlight) return inFlight;

      const run = restartOnce(request).finally(() => {
        restarting.delete(request.entityId);
      });
      restarting.set(request.entityId, run);
      return run;
    },

    entities: () => registry.entities(),
    diagnostics: () => ptyIpc.diagnostics(),

    dispose() {
      bootstrap.dispose();
      activity.dispose();
      ptyIpc.dispose();
      heldInput.clear();
      registry.clear();
      restarting.clear();
      exitWaiters.clear();
    },
  };
}
