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

export function createSessions(options: SessionsOptions): Sessions {
  const { supervisor, send, config, maxSessions = MAX_SESSIONS } = options;

  const registry: SessionRegistry = createSessionRegistry();
  /** Resolvers waiting for a specific entity's process to exit. */
  const exitWaiters = new Map<string, (() => void)[]>();

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
    activity.exited(entityId);
    registry.close(entityId);

    const waiters = exitWaiters.get(entityId);
    if (!waiters) return;
    exitWaiters.delete(entityId);
    for (const resolve of waiters) resolve();
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

    bootstrap.arm(request.entityId, snapshot.claudeCommand);
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

    async restart(request) {
      const sessionId = registry.sessionFor(request.entityId);

      /**
       * Kill, **wait for the exit**, then spawn. An ordering, not a set.
       *
       * Spawning before the old process is reaped means two `claude` instances
       * in one repository writing the same files, and the supervisor rejects
       * the second spawn if the id is still live. Waiting is what makes the new
       * generation genuinely new.
       */
      if (sessionId !== undefined) {
        const exit = new Promise<void>((resolve) => {
          const waiters = exitWaiters.get(request.entityId) ?? [];
          waiters.push(resolve);
          exitWaiters.set(request.entityId, waiters);
        });
        ptyIpc.kill(sessionId);
        await exit;
      }

      spawn(request);
    },

    entities: () => registry.entities(),
    diagnostics: () => ptyIpc.diagnostics(),

    dispose() {
      bootstrap.dispose();
      activity.dispose();
      ptyIpc.dispose();
      registry.clear();
      exitWaiters.clear();
    },
  };
}
