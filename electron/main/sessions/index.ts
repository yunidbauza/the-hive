import { randomUUID } from 'node:crypto';

import { AUTH_ENV_KEYS, type ConfigSnapshot } from '@shared/config-contract';
import type {
  HookNotificationType,
  IdleDetail,
  ObservedStatus,
  StatusHookEvent,
} from '@shared/hook-contract';
import {
  CH,
  type DataEvent,
  type ExitEvent,
  type PtyDiagnostics,
  type SessionLostEvent,
} from '@shared/ipc-contract';
import type { SessionMetricsEvent } from '@shared/metrics-contract';
import { MAX_SESSIONS } from '@shared/pty-host-protocol';
import {
  spawnRefusal,
  type SessionEffort,
  type SessionModel,
  type SessionTheme,
  SESSION_NAME_DISPLAY_MAX,
  type SessionBranchEvent,
  type SessionClearedEvent,
  type SessionNameEvent,
  type SessionStatusEvent,
  type SessionTicketIntentEvent,
} from '@shared/session-contract';

import { effectiveRuntime } from '../config/runtime';
import type { HookRuntime } from '../hooks';
import { createStatusTracker } from '../hooks/tracker';
import { createPtyIpc, type PtyIpc } from '../ipc/pty';
import type { PtyHostSupervisor } from '../pty-host/supervisor';

import { createActivityTracker, type ActivityTracker } from './activity';
import { createBootstrap, sessionCommand, type Bootstrap } from './bootstrap';
import { createBranchReader, resolveGit, type BranchReaderOptions } from './git';
import type { SessionLedger } from './ledger';
import { createSessionRegistry, type SessionRegistry } from './registry';
import { createTitleReader, type TitleReader } from './title';

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
  /**
   * The hook pipeline, when the app has one (HIVE-62).
   *
   * Optional, and absent is a supported state rather than a degraded one: the
   * browser build has no main process at all, and a desktop build whose
   * receiver could not bind runs on `activity.ts` alone. Everything downstream
   * treats "no hooks" and "hooks not started yet" identically.
   */
  hooks?: HookRuntime;
  /**
   * The uuid pinned as `--session-id` on a spawn (HIVE-61).
   *
   * Injected for the same reason `send` and `config` are: a random value
   * generated in here makes the command line this module builds unassertable,
   * and the command line is the whole observable behaviour of the spawn path.
   */
  newSessionUuid?: () => string;
  /**
   * How branches are read (HIVE-78).
   *
   * Injected for exactly the reason `newSessionUuid` is: the default shells out
   * to `git`, and a unit test that did so would answer differently on every
   * machine and in every checkout. Absent means the real reader.
   */
  branchReader?: BranchReaderOptions;
  /**
   * Where the fleet is written down, so it survives a quit (HIVE-87).
   *
   * Optional in the same spirit as `hooks`: absent is a supported state rather
   * than a degraded one. The browser build has no main process at all, and a
   * unit test that does not care about history passes nothing — every call site
   * below is `ledger?.record(…)`, so "no ledger" costs exactly the history and
   * nothing else.
   *
   * Injected rather than constructed in here for the reason `newSessionUuid`
   * and `branchReader` are: the real one writes a file in the user's
   * `userData`, and a unit test that did so would leave state behind and answer
   * differently on the second run.
   */
  ledger?: SessionLedger;
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
  /**
   * What to start `claude` as (story 109).
   *
   * Present on `restart` precisely where {@link OpenRequest.task} is not: an
   * instruction is something the previous generation may already have acted on,
   * while the model is a property of the session itself. A restart that
   * silently dropped it would relaunch the session as a different model than
   * the one its own row advertises.
   */
  model?: SessionModel;
  effort?: SessionEffort;
  /**
   * What to call the session inside Claude (HIVE-78).
   *
   * Absent for every ordinary spawn, which falls back to the entity id — the
   * HIVE-61 behaviour, unchanged. Present only when the renderer has a better
   * name than `sess-07`, which today means one thing: the session was started
   * from a ticket card and is called after its issue key.
   *
   * Validated twice before it reaches a command line — `assertSessionName` at
   * the IPC boundary and `isSendableSessionName` in `bootstrap.ts` — because
   * unlike `model` and `effort` this has no closed list behind it. A value that
   * fails either simply omits the flag.
   */
  name?: string;
  /**
   * Which way round `claude` paints its own UI (see `hooks/settings.ts`).
   *
   * Carried on `restart` for the same reason `model` is: it is a property of
   * how the session is dressed rather than an instruction it may have acted on.
   * A restart is also the *only* moment a running session can pick up a theme
   * toggle, because the settings file is read once at startup.
   *
   * Absent means dark, which is Claude Code's default and the app's.
   */
  theme?: SessionTheme;
  /**
   * Continue the conversation a previous run left under this id (HIVE-88).
   *
   * Honoured only when the ledger can name that conversation —
   * `SessionLedger.resumable` — and ignored otherwise, so a restored row whose
   * record predates uuids, or a build with no ledger at all, gets the ordinary
   * spawn. Never set on `restart`: a restart is a new process for a session
   * this run already owns, and its record is kept by `begin` regardless.
   */
  resume?: boolean;
}

/**
 * A PTY that runs a command rather than a session (story 102).
 *
 * Everything {@link OpenRequest} resolves — a project, a shell, a bootstrap —
 * is absent here on purpose. The caller has already decided what to run and
 * where, because the only caller is the clone flow, and a clone's cwd is a
 * directory *it* validated whose child does not exist yet. Routing it through
 * `open()` would hit the `unmapped` refusal, which is right for a session and
 * wrong for this.
 */
export interface OpenCommandRequest {
  entityId: string;
  cwd: string;
  file: string;
  args: string[];
  cols: number;
  rows: number;
  /** Fires once, for whichever ending arrives first. */
  onExit: (result: CommandExit) => void;
}

/** How a command session ended. */
export interface CommandExit {
  /** `-1` when nothing ran or nothing concluded — never a real status then. */
  exitCode: number;
  /**
   * The signal that ended it, as a number. **`0` means no signal.**
   *
   * Carried separately because a signalled process routinely reports
   * `exitCode: 0` — a `git clone` killed with SIGTERM exits 0 with signal 15,
   * and a caller that read only the code would call that a success. Every
   * consumer must treat a non-zero signal as "did not finish".
   */
  signal: number;
  /** The host died under a process that may still have been working. */
  lost: boolean;
  /** A host-level failure — set when the binary could not start at all. */
  message?: string;
}

export interface Sessions {
  /** Spawn, bootstrap and attach — or attach to what is already running. */
  open(request: OpenRequest): void;
  /**
   * Spawn a bare command in a PTY — no project, no bootstrap, no activity
   * tracking (story 102). `onExit` fires once, for whichever of exit, host
   * loss, or a failure to start arrives first.
   */
  openCommand(request: OpenCommandRequest): void;
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
 * Comfortably past the host's own SIGHUP-then-SIGKILL escalation and the
 * descendant sweep that follows it (HIVE-72 — bounded to under 3s in total), so
 * this only fires when that escalation itself has failed, which means the host
 * is wedged rather than the process being slow.
 */
const RESTART_EXIT_TIMEOUT_MS = 10_000;

export function createSessions(options: SessionsOptions): Sessions {
  const {
    supervisor,
    send,
    config,
    maxSessions = MAX_SESSIONS,
    hooks,
    newSessionUuid = randomUUID,
    branchReader,
    ledger,
  } = options;

  const registry: SessionRegistry = createSessionRegistry();
  /**
   * What each session *is*, derived from every hook it has sent (HIVE-83).
   *
   * One instance for the life of this module, not one per event: the whole
   * point is a record that accumulates across a session's hooks, so a sibling
   * tool's `PostToolUse` does not erase a block the same batch is still holding.
   */
  const statusTracker = createStatusTracker();
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
  /**
   * Exit callbacks for command sessions (story 102).
   *
   * Kept out of `exitWaiters` deliberately: those resolve `void` for the
   * restart ordering and may hold several waiters, where this is one owner that
   * needs the *code*. Deleted before it is invoked, so a re-entrant ending
   * cannot fire it twice.
   */
  const commandExit = new Map<string, (result: CommandExit) => void>();

  /**
   * Entities that are commands, not sessions (story 102).
   *
   * Separate from {@link commandExit} because the two have different lifetimes:
   * the callback is deleted the moment it fires, and this must outlive it — the
   * exit path still has to know not to publish a `done` status for an entity
   * the renderer's store has never heard of.
   */
  const commandEntities = new Set<string>();

  function settleCommand(entityId: string, result: CommandExit): void {
    const onExit = commandExit.get(entityId);
    if (!onExit) return;
    commandExit.delete(entityId);
    onExit(result);
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
        /**
         * A command has no activity and no bootstrap (story 102). Feeding the
         * tracker would publish `session:status` for an entity the store does
         * not have, and feeding the bootstrap would type `claude` into it.
         */
        if (!commandEntities.has(entityId)) {
          activity.sawOutput(entityId);
          bootstrap.sawOutput(entityId);
          // A command has no agent, so it has no name to report either.
          readTitle(entityId, data.chunk);
        }
        send(channel, { ...data, sessionId: entityId } satisfies DataEvent);
        return;
      }
      case CH.ptyExit: {
        const data = payload as ExitEvent;
        send(channel, { ...data, sessionId: entityId } satisfies ExitEvent);
        settleCommand(entityId, {
          exitCode: data.exitCode,
          // `0` means no signal, which is also the right reading of an absent
          // one — see `ExitEvent.signal`.
          signal: data.signal ?? 0,
          lost: false,
        });
        settleExit(entityId);
        return;
      }
      case CH.ptyLost: {
        const data = payload as SessionLostEvent;
        send(channel, { ...data, sessionId: entityId } satisfies SessionLostEvent);
        // No code: nothing concluded. `-1` is the sentinel a command caller
        // reads as "did not finish", never as an exit status.
        settleCommand(entityId, { exitCode: -1, signal: 0, lost: true });
        settleExit(entityId);
        return;
      }
      default:
        send(channel, payload);
    }
  }

  /**
   * Sessions whose status a hook has spoken for (HIVE-62).
   *
   * Once a session's own agent has reported, the pty-activity inference stops
   * being an *estimate of the same thing* and becomes a contradiction of it: a
   * session parked on a permission prompt produces no output, so `activity.ts`
   * calls it `idle` two seconds later and overwrites the `waiting` the hook just
   * delivered. The set is what makes the better observer win.
   */
  const hookDriven = new Set<string>();

  /** One OSC-0 reader per session — a partial sequence is per-stream state. */
  const titles = new Map<string, TitleReader>();

  /**
   * Reads `git rev-parse` for a directory, cached and rate-limited (HIVE-78).
   *
   * One reader for the whole layer rather than one per session, because its
   * cache is keyed by **directory** and two sessions in the same repository are
   * asking the same question. A per-session reader would spawn `git` once per
   * session for an answer the first one already had.
   */
  const branches = createBranchReader(
    branchReader ?? {
      /**
       * Resolved against the **config-augmented** environment, not the bare
       * one (HIVE-78).
       *
       * A GUI-launched Electron app on macOS inherits launchd's minimal
       * `PATH`, which frequently has no `git` in it. That is the whole reason
       * `runtime.path` exists in the config, and `gh` and `claude` are already
       * resolved against it.
       *
       * **`process.env` is the base, with the config's env layered over it** —
       * the identical merge `ipc/index.ts` makes for `gh`.
       * `effectiveRuntime().env` holds *only* the project's own overrides and
       * is not a complete environment, so using it alone leaves `PATH`
       * undefined and every branch read answering `null`. Measured, not
       * assumed: the first version of this line omitted the spread and broke
       * `session-branch.spec.ts` — which is exactly what that spec is for.
       *
       * `config()` is read per call rather than captured, so a reload is picked
       * up — the same reason `SessionsOptions.config` is a function at all.
       */
      gitPath: () =>
        resolveGit({ ...process.env, ...effectiveRuntime(config(), null).env }),
    },
  );

  /**
   * The last branch and directory published per session.
   *
   * Not a cache — {@link branches} is the cache. This is what makes the channel
   * quiet: it answers "would the renderer learn anything from this event", and
   * the overwhelming majority of the time it would not.
   */
  const lastBranch = new Map<string, { branch: string | null; cwd: string }>();

  const activity: ActivityTracker = createActivityTracker({
    onStatus: (entityId, status) => {
      /**
       * `terminated` is forwarded even for a hook-driven session.
       *
       * It is not an inference: the process is gone, main watched it go, and no
       * hook can report a session's own death reliably — `SessionEnd` races the
       * exit and loses whenever the agent is killed rather than quitting.
       */
      if (status !== 'terminated' && hookDriven.has(entityId)) return;
      // The process is gone; drop its record rather than leak it (HIVE-83).
      if (status === 'terminated') statusTracker.forget(entityId);
      publishStatus(entityId, status);
    },
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

  /**
   * Start reporting (HIVE-62).
   *
   * Fire-and-forget, and it has to be: `createSessions` is called during app
   * startup and cannot become async without making every caller async too. A
   * session spawned in the window before this resolves gets no `--settings`
   * flag and runs on activity inference — the same state as a build with no
   * hooks at all, which is a state everything downstream already handles.
   *
   * `knowsSession` is the registry rather than a set of ids this module keeps:
   * a hook for a session that has already exited must be refused, and the
   * registry is the thing that already knows.
   */
  void hooks?.start({
    knowsSession: (entityId) => registry.sessionFor(entityId) !== undefined,
    onEvent: (event) => {
      /**
       * The tracker decides, not the event (HIVE-83).
       *
       * `event.status` is the per-event fallback the contract still carries;
       * what reaches the renderer is derived from what the session *is*, which
       * is the only way a sibling tool's completion stops clearing a live
       * permission block.
       */
      const derived = statusTracker.apply({
        entityId: event.entityId,
        event: event.event,
        ...(event.toolUseId === undefined ? {} : { toolUseId: event.toolUseId }),
        ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
        ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
        ...(event.runInBackground === undefined
          ? {}
          : { runInBackground: event.runInBackground }),
        ...(event.notificationType === undefined
          ? {}
          : { notificationType: event.notificationType }),
      });

      publishHookStatus(
        event.entityId,
        derived.status,
        event.event,
        event.notificationType,
        derived.detail,
        event.toolName,
      );
      /**
       * The branch read is deliberately **after** the status (HIVE-78).
       *
       * Status is the reason this channel exists and it is synchronous;
       * resolving a branch may spawn a process. Doing it first would put a
       * `git` spawn between a hook arriving and a status dot moving, on every
       * event, which is the one thing the receiver was careful not to do.
       */
      if (event.cwd !== undefined) {
        /**
         * `Stop` reads **fresh** (HIVE-78).
         *
         * It is the end of a turn — the moment the agent has finished whatever
         * it was doing, and the last event that will fire until the user types
         * again. A `git checkout -b` inside a short turn lands inside the
         * reader's rate-limit floor, so without this the rail keeps showing the
         * old branch until the *next* prompt, which is exactly the window in
         * which the user looks at it. Every other event still pays the floor.
         */
        void publishBranch(event.entityId, event.cwd, event.event === 'Stop');
      }
    },
    onTicketIntent: (event) =>
      send(CH.sessionTicketIntent, {
        entityId: event.entityId,
        key: event.key,
      } satisfies SessionTicketIntentEvent),
    onCleared: (entityId) => {
      /**
       * `/clear` keeps the pty and opens a successor row (HIVE-83).
       *
       * Without this reset the successor inherits the retired conversation's
       * live subagents and sits on `idle (agents)` forever with nothing
       * running.
       */
      statusTracker.reset(entityId);
      /**
       * The uuid no longer names this terminal's conversation (HIVE-88).
       *
       * `/clear` starts a new one under a new id, and the only hook that
       * carries that id — `SessionStart` — never reaches the receiver (see
       * `hook-contract.ts`). So the ledger cannot learn it, and keeping the
       * old one would let a later `--resume` reopen the conversation the user
       * deliberately ended. Dropped, so a restored row for this terminal opens
       * as a fresh session instead.
       */
      ledger?.record(entityId, { sessionUuid: undefined });
      publishCleared(entityId);
    },
    /**
     * Usage, forwarded verbatim (HIVE-79).
     *
     * No `lastMetrics` guard, unlike `publishBranch` next door, and the
     * asymmetry is deliberate. A branch is observed by *main* on every hook
     * boundary and is almost always unchanged, so suppressing the no-op there
     * is what makes a chatty observation affordable. These arrive only when
     * Claude Code's own status line fires — an assistant message, a `/compact`,
     * a 30-second idle tick — which is already the cadence at which the numbers
     * genuinely move. The store drops an unchanged patch on arrival, so the
     * one place that would benefit from the comparison already makes it, with
     * the previous value in hand rather than a copy kept here.
     */
    onMetrics: (entityId, metrics) =>
      send(CH.sessionMetrics, {
        entityId,
        metrics,
      } satisfies SessionMetricsEvent),
  });

  /**
   * A host error for a command session is that command's ending (story 102).
   *
   * `node-pty` failing to spawn emits `{ type: 'error' }` and **no exit**, so
   * for `openCommand` this is the only signal that will ever arrive. A session
   * does not need it — its surface shows an empty terminal and the user can
   * restart — but a clone does: without this, `git` missing from `PATH` leaves
   * the clone view waiting forever on a process that was never created.
   */
  const disposeErrors = supervisor.onError((event) => {
    if (event.sessionId === undefined) return;
    const entityId = registry.entityFor(event.sessionId);
    if (entityId === undefined) return;
    if (!commandExit.has(entityId)) return;

    settleCommand(entityId, {
      exitCode: -1,
      signal: 0,
      lost: false,
      message: event.message,
    });
    settleExit(entityId);
  });

  function publishStatus(
    entityId: string,
    status: ObservedStatus,
    /**
     * The hook that produced this status, when one did (HIVE-75).
     *
     * Passed straight through rather than interpreted here. The session layer's
     * job is to say what a session is doing; deciding that a `PermissionRequest`
     * deserves a different notification than an `Elicitation` is the hub's, and
     * putting that judgement here would give the sessions layer an opinion
     * about the inbox it has managed to avoid having so far.
     */
    event?: StatusHookEvent,
    /**
     * What kind of interruption, when `event` is `Notification`.
     *
     * Passed through for the reason `event` is: the hub decides that a
     * `permission_prompt` is already covered by the `PermissionRequest` ahead of
     * it and an `idle_prompt` is not, and that judgement has no business here.
     */
    notificationType?: HookNotificationType,
    /**
     * What is still running while the main agent is not (HIVE-83).
     *
     * Passed through for the same reason `event` is: the session layer says
     * what a session is doing, and the renderer decides how to draw it.
     */
    idleDetail?: IdleDetail,
    /**
     * The tool a `PermissionRequest` named, when it named one (HIVE-83).
     *
     * Passed through for the same reason `event` is: telling `AskUserQuestion`
     * apart from any other blocking tool is the notification hub's judgement,
     * not the session layer's.
     */
    toolName?: string,
  ): void {
    /**
     * The ledger's `status` is documented as the *last known* one, and until
     * HIVE-88 it was the first: `begin` wrote `working` and nothing touched it
     * again before `settleExit`. That was enough for a fresh launch, which
     * rewrites every live status to `closed` anyway. It is not enough for a
     * renderer that starts in front of running ptys — the row it hydrates as
     * live should say what the session is doing, not what it was doing when
     * it started. `terminated` stays with `settleExit`, which also owns
     * `endedAt`.
     */
    if (status !== 'terminated') ledger?.record(entityId, { status });

    send(CH.sessionStatus, {
      entityId,
      status,
      ...(event === undefined ? {} : { event }),
      ...(notificationType === undefined ? {} : { notificationType }),
      ...(idleDetail === undefined ? {} : { idleDetail }),
      ...(toolName === undefined ? {} : { toolName }),
    } satisfies SessionStatusEvent);
  }

  /**
   * The conversation in this terminal ended; the terminal did not.
   *
   * Nothing is torn down here on purpose. The pty keeps running, the registry
   * entry stands, and `hookDriven` keeps its membership — the successor the
   * renderer opens is the *same* terminal, so the next hook for this entity id
   * is still authoritative and must not fall back to activity inference.
   *
   * Main does not mint the successor's id. Entity ids are the renderer's to
   * allocate (`spawnSession` owns the counter), and having two processes both
   * able to name rows is how ids drift apart.
   */
  function publishCleared(entityId: string): void {
    send(CH.sessionCleared, { entityId } satisfies SessionClearedEvent);
  }

  /**
   * Where this session is working, and what is checked out there (HIVE-78).
   *
   * ## Only on a change
   *
   * `lastBranch` is what makes a hook boundary an affordable cadence. Hook
   * events arrive several times a turn and the answer changes maybe twice a
   * day, so without this every `Stop` would push an identical event into the
   * renderer and every session row would re-render for nothing — the exact cost
   * the four-store split exists to avoid.
   *
   * The key is the entity, and the compared value includes the **cwd**: an
   * agent that moves from one worktree to another on the same branch name has
   * changed something the explorer needs to know about, even though the branch
   * string is identical.
   *
   * ## Never rejects
   *
   * Called fire-and-forget from a hook callback, where a rejection would be an
   * unhandled promise on the main process. `BranchReader.read` already answers
   * `null` rather than throwing for every failure it can see; this catch is for
   * the ones it cannot.
   */
  async function publishBranch(
    entityId: string,
    cwd: string,
    fresh = false,
  ): Promise<void> {
    let branch: string | null;
    try {
      branch = await branches.read(cwd, fresh);
    } catch {
      return;
    }

    /**
     * Checked after the await, not before.
     *
     * The read is asynchronous, so a session can exit while it is in flight —
     * and publishing then would push a branch for a row the renderer has
     * already retired.
     */
    if (registry.sessionFor(entityId) === undefined) return;

    const seen = lastBranch.get(entityId);
    if (seen !== undefined && seen.branch === branch && seen.cwd === cwd) return;

    lastBranch.set(entityId, { branch, cwd });
    /*
      HIVE-87. The same fact the renderer is about to be told, kept where it
      survives a quit. `branch` is nullable here and the record's is optional,
      so a `null` omits the key rather than storing "known to be nothing" — the
      store renders an em dash for both, and the ledger should not invent a
      distinction the app does not draw.
    */
    ledger?.record(entityId, { ...(branch === null ? {} : { branch }), cwd });
    send(CH.sessionBranch, { entityId, branch, cwd } satisfies SessionBranchEvent);
  }

  /**
   * A hook reported. Its verdict is authoritative from here on.
   *
   * Registered as hook-driven *before* publishing, so the activity tracker's
   * next tick — which may already be scheduled — is suppressed rather than
   * racing this event.
   */
  function publishHookStatus(
    entityId: string,
    status: ObservedStatus,
    event?: StatusHookEvent,
    notificationType?: HookNotificationType,
    idleDetail?: IdleDetail,
    toolName?: string,
  ): void {
    hookDriven.add(entityId);
    publishStatus(entityId, status, event, notificationType, idleDetail, toolName);
  }

  /**
   * Read any renamed session out of a chunk and tell the renderer (HIVE-61).
   *
   * Called on the raw chunk before batching, because the title sequence is a
   * property of the byte stream and the batcher is free to reshape it.
   */
  function readTitle(entityId: string, chunk: string): void {
    /**
     * **Only once the agent is up.** A session's pty is a login shell first,
     * and shells set titles too — `zsh` writes `user@host:~/repo`, and so do
     * `vim`, `ssh`, `tmux` and `htop`. Reading titles from spawn onward meant
     * the prompt renamed the row before `claude` had even started, and
     * `renameSession` deliberately does not validate, so nothing downstream
     * caught it.
     *
     * `bootstrap.isPending` is exactly the window in which the shell is the
     * only thing running, which makes it the gate. A session whose `claude`
     * exits non-zero leaves the shell up and can still rename its row — that is
     * a session already visibly broken, and inferring "the agent died" from a
     * title is precisely the guesswork this change removed.
     */
    if (bootstrap.isPending(entityId)) return;

    let reader = titles.get(entityId);
    if (reader === undefined) {
      reader = createTitleReader();
      titles.set(entityId, reader);
    }
    for (const name of reader.read(chunk)) {
      /**
       * Capped, because nothing upstream caps it. The reader abandons a
       * sequence at 2048 characters, which is a bound on memory rather than on
       * what belongs in a rail 130px wide.
       */
      if (name.length > SESSION_NAME_DISPLAY_MAX) continue;
      // HIVE-87. A restored row should read as whatever the agent last called
      // itself, not as the `sess-07` it was born as.
      ledger?.record(entityId, { name });
      send(CH.sessionName, { entityId, name } satisfies SessionNameEvent);
    }
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
    /**
     * Both are per-*generation* state, and a restart reuses the entity id.
     *
     * A retained title reader would carry a half-parsed sequence from the dead
     * process into the new one; a retained `hookDriven` mark would suppress the
     * new generation's activity status before its first hook ever arrives,
     * leaving a freshly restarted session showing nothing.
     */
    titles.delete(entityId);
    hookDriven.delete(entityId);
    /**
     * Per-generation too, and for a sharper reason than the other two: a
     * restarted session reuses the entity id, and a retained entry would make
     * the *first* branch read of the new generation look like a repeat of the
     * last one from the old — so the row would keep the dead session's branch
     * until something else happened to change it.
     */
    /**
     * The directory cache goes with it, so it is not append-only for the life
     * of the app — an agent that works through several worktrees would leave an
     * entry per directory behind it otherwise.
     */
    const seenBranch = lastBranch.get(entityId);
    if (seenBranch !== undefined) branches.forget(seenBranch.cwd);
    lastBranch.delete(entityId);
    // Same reason as the data path: a command's ending is not a session's.
    if (commandEntities.delete(entityId)) {
      // Nothing to tell the store about.
    } else {
      activity.exited(entityId);
      /**
       * The ending, recorded where it is actually known (HIVE-87).
       *
       * Deliberately here and not in a shutdown hook. `runShutdown()` invokes
       * every hook body synchronously and then awaits them together, so a
       * flush registered there races the pty teardown instead of following it
       * — and a crash or a SIGKILL runs no hook at all. This is the one place
       * that sees an ending however it arrived, `ptyExit` or `ptyLost`, so it
       * is the only place the fact can be captured rather than inferred.
       */
      ledger?.record(entityId, { status: 'terminated', endedAt: Date.now() });
    }
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
         * The host escalates SIGHUP to SIGKILL and the supervisor's heartbeat
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

  /**
   * Mint a session id and start a process. The one place a PTY is spawned.
   *
   * Both entry points funnel through here so there is no second way to start
   * one: the capacity check and the host-blocked check must apply to a clone
   * exactly as they apply to a session, and two copies of them would drift.
   */
  function startProcess(request: {
    entityId: string;
    cwd: string;
    file: string;
    args: string[];
    cols: number;
    rows: number;
    /** Per-project environment (story 104). Empty for a clone. */
    env?: Record<string, string>;
    /** Names the host must drop from the inherited environment (HIVE-79). */
    stripEnv?: readonly string[];
  }): void {
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

    const sessionId = registry.open(request.entityId);

    ptyIpc.spawn({
      sessionId,
      shell: request.file,
      args: request.args,
      cwd: request.cwd,
      /**
       * The host builds the environment (story 092); a session inherits the
       * user's, which is the only environment in which their `claude` and their
       * tooling behave the way they do outside this app.
       *
       * Story 104 adds one thing on top: the project's own variables. They are
       * *merged* by `buildEnv` in the host, which then forces `TERM`,
       * `COLORTERM` and `PWD` — which is why those three are refused at the
       * guard rather than accepted and silently overwritten.
       */
      env: request.env ?? {},
      /**
       * The credentials a session must **not** inherit (HIVE-79).
       *
       * Decided here rather than in the host because the host has no config: it
       * is told the names on each spawn. Empty when the user has turned
       * `subscriptionAuth` off, which restores exactly the pre-HIVE-79
       * environment.
       */
      ...(request.stripEnv === undefined ? {} : { stripEnv: request.stripEnv }),
      cols: request.cols,
      rows: request.rows,
    });
  }

  /** Refuse with a message the user can act on, never a generic failure. */
  function spawn(request: OpenRequest): void {
    const snapshot = config();

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

    /**
     * Per-project overrides win over the top-level values (story 104).
     *
     * Resolved through the same `effectiveRuntime` the PATH diagnostic uses, so
     * what the diagnostic explains is exactly what this spawns — a diagnostic
     * that computed its own answer would eventually reassure the user about an
     * environment no session runs in.
     */
    const runtime = effectiveRuntime(snapshot, project);

    startProcess({
      entityId: request.entityId,
      cwd: project.path,
      file: runtime.shell,
      args: LOGIN_SHELL_ARGS,
      cols: request.cols,
      rows: request.rows,
      /**
       * The hook environment is merged **over** the project's (HIVE-62).
       *
       * Project env is the user's to control and wins everywhere else, but not
       * here: these two variables are how a hook proves which row it speaks
       * for, so a project able to set `HIVE_SESSION_ID` could point another
       * session's status at a row of its choosing. Attribution is the app's
       * claim about its own sessions, not a value under configuration.
       *
       * This is the *only* thing enforcing it. `config-contract.ts` has
       * `RESERVED_ENV_KEYS` and `UNSAFE_ENV_KEYS`, and neither lists the two
       * Hive variables — so the spread order here is the whole guarantee rather
       * than a second layer behind a list. Adding them to that list as well
       * would be belt and braces; leaving this comment claiming a protection
       * that does not exist would not.
       */
      env: { ...runtime.env, ...hooks?.envFor(request.entityId) },
      /*
        A session, unlike a clone, runs `claude` — so it is the one spawn whose
        authentication matters. `snapshot` is the config already read for this
        spawn, so this costs no extra read.
      */
      stripEnv: snapshot.subscriptionAuth ? AUTH_ENV_KEYS : [],
    });

    /*
      Resolved before the command is assembled, because it is the one argument
      that depends on something the renderer told us about *itself* rather than
      about the session.
    */
    const settingsPath = hooks?.settingsPathFor(request.theme);

    /**
     * Hoisted out of the `sessionCommand` call it used to sit inside (HIVE-87).
     *
     * It has to reach two places now — the command line, and the ledger — and
     * calling `newSessionUuid()` twice would put a different uuid in each. The
     * ledger's copy would then name a transcript that does not exist, which is
     * precisely the thing recording it is meant to make possible.
     */
    /**
     * A resumed conversation keeps the uuid it already has (HIVE-88): that is
     * the transcript `--resume` opens, and minting a new one here would name
     * a session that was never started. `undefined` from the ledger means
     * there is nothing to pick up — no ledger, no record, no uuid, or an id
     * this run began — and the request degrades to the plain spawn it would
     * otherwise have been. The renderer asked to resume; main decides whether
     * it can.
     */
    const resumeUuid =
      request.resume === true ? ledger?.resumable(request.entityId) : undefined;
    const resume = resumeUuid !== undefined;
    const sessionUuid = resumeUuid ?? newSessionUuid();

    /**
     * Written down before the process starts, not after (HIVE-87).
     *
     * A spawn that throws below still happened as far as the user is concerned
     * — they asked for a session and something went wrong — and a record of it
     * is more useful than silence. The uuid especially: it cannot be assigned
     * retroactively to a session that has already started, so the only moment
     * it can be captured is this one.
     */
    ledger?.begin(
      request.entityId,
      {
        project: request.projectId,
        // A resumed row keeps the task it was opened with; see `resume` below.
        ...(resume ? {} : { task: request.task ?? '' }),
        status: 'working',
        sessionUuid,
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.effort === undefined ? {} : { effort: request.effort }),
      },
      { resume },
    );

    /**
     * `sessionCommand` wraps the configured binary so a clean `/exit` takes the
     * login shell with it and the session settles to `done`. See its own
     * comment for why that reverses story 096, and why it is `&&`.
     */
    bootstrap.arm(
      request.entityId,
      /**
       * The picker's model and effort become flags on that command
       * (story 109). They were recorded on the entity and shown on its chip
       * from the first story that offered them, and reached the process in no
       * story at all — so a session started as Haiku with low effort opened as
       * Opus and said so on the meta bar.
       */
      sessionCommand(runtime.claudeCommand, {
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.effort === undefined ? {} : { effort: request.effort }),
        /**
         * The session is named after the row it belongs to (HIVE-61), so the
         * agent's own prompt box, `/resume` picker and terminal title all agree
         * with the rail instead of inventing an auto-title from whatever the
         * first message happened to be.
         *
         * A rename *inside* Claude is not a conflict with this: the new name
         * comes straight back out on the title stream and becomes the row's
         * name. This only decides what the session is called to begin with.
         *
         * HIVE-78 lets the renderer say what that name is, and it does so for
         * exactly one case: a session started from a ticket card, which is
         * called `HIVE-73` rather than `sess-07`. The **id** is untouched —
         * it is the entities-map key and appears in every console line — so
         * this is the display name and nothing more. Falling back to the id
         * keeps every other spawn byte-identical to what HIVE-61 shipped.
         */
        name: request.name ?? request.entityId,
        sessionUuid,
        resume,
        /*
          The theme rides in from the renderer, which is the only side that
          knows it, and picks which of the two settings files this session
          reads. Absent means dark — `settingsPathFor`'s own default — so a
          spawn from main's own paths is byte-identical to what it was.
        */
        ...(settingsPath == null ? {} : { settingsPath }),
        /*
          Belt *and* braces, deliberately. `stripEnv` above covers the ambient
          environment and a project's own `env` block; this covers the login
          shell's profile, which re-exports whatever the user put in `~/.zshrc`
          after the host has already sanitised. Neither one is sufficient alone.
        */
        subscriptionAuth: snapshot.subscriptionAuth,
        /**
         * The opening instruction becomes `claude`'s initial prompt, on this
         * command line, rather than a second write into the pty afterwards
         * (HIVE-91).
         *
         * It moved *into* `sessionCommand` from `arm`'s third argument. The old
         * shape waited for the TUI to settle and then typed the task in, which
         * meant a `claude` that failed to start handed the user's instruction to
         * the login shell to run as a command. See `sessionCommand`'s own
         * comment for the transcript that produced.
         */
        /*
          Not on a resume (HIVE-88): the conversation being picked up has
          already heard its opening instruction, and a ledger record carries
          the task precisely so the row can display it — not so it can be
          said twice.
        */
        ...(request.task === undefined || resume ? {} : { task: request.task }),
      }),
    );

    /**
     * The branch this session opens on (HIVE-78).
     *
     * **After the process exists**, because `publishBranch` refuses to speak for
     * an entity the registry does not hold — a guard that earns its keep on the
     * hook path, where a read can outlive the session that triggered it, and
     * which would silently swallow this call if it ran before `startProcess`.
     *
     * Without a read here a session shows an em dash until its first hook lands
     * — which, for a session the user opens and reads before typing into, is the
     * whole time they are looking at it. `project.path` is the pty's cwd, so at
     * this instant it is exactly right, and it stays right for a session with no
     * hooks at all. That is the honest floor for this feature: the branch the
     * session started on, never a branch nobody created.
     *
     * Fire-and-forget — a spawn must not wait on `git`, and this cannot reject.
     */
    void publishBranch(request.entityId, project.path);
  }

  return {
    openCommand(request) {
      /**
       * Registered *before* the spawn, because a failure to start is reported
       * asynchronously and could otherwise land before there was anything to
       * settle.
       */
      commandExit.set(request.entityId, request.onExit);
      commandEntities.add(request.entityId);
      try {
        startProcess(request);
      } catch (cause) {
        /**
         * The callback owns every ending *except* this one. A caller that had
         * to handle a throw **and** a callback would have two cleanup paths and
         * would eventually only implement one — so a refusal to start stays a
         * throw, and the registration is undone rather than left dangling.
         */
        commandExit.delete(request.entityId);
        commandEntities.delete(request.entityId);
        throw cause;
      }
    },

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
      disposeErrors();
      /**
       * The socket goes down with everything else.
       *
       * Awaiting it would make `dispose` async for a close that has nothing
       * left to deliver — every session's process is already being torn down,
       * so any hook still in flight is about a session that no longer exists.
       */
      void hooks?.stop();
      titles.clear();
      hookDriven.clear();
      heldInput.clear();
      registry.clear();
      restarting.clear();
      exitWaiters.clear();
      commandExit.clear();
      commandEntities.clear();
    },
  };
}
