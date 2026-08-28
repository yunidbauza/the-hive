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
  SESSION_NAME_DISPLAY_MAX,
  type SessionBranchEvent,
  type SessionClearedEvent,
  type SessionFinishedEvent,
  type SessionReadyEvent,
  type SessionNameEvent,
  type SessionStatusEvent,
  type SessionTicketIntentEvent,
} from '@shared/session-contract';

import { effectiveRuntime } from '../config/runtime';
import type { HookRuntime } from '../hooks';
import { ticketKeysFromBranch } from '../hooks/ticket-intent';
import { createStatusTracker } from '../hooks/tracker';
import { createPtyIpc, type PtyIpc } from '../ipc/pty';
import type { PtyHostSupervisor } from '../pty-host/supervisor';
import type { SkillsRuntime } from '../skills';

import { createActivityTracker, type ActivityTracker } from './activity';
import { createBootstrap, sessionCommand, type Bootstrap } from './bootstrap';
import { createBranchReader, resolveGit, type BranchReaderOptions } from './git';
import type { SessionHistory } from './history';
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
   * The custom-skills pipeline, when the app has one (HIVE-96).
   *
   * Optional for the same reason `hooks` is, and absent is likewise supported
   * rather than degraded: a session with no injected skills is an ordinary
   * `claude`. Nothing downstream distinguishes "no skills runtime" from "the
   * plugin could not be written" — both omit the flag.
   */
  skills?: SkillsRuntime;
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
   * below is `history?.record(…)`, so passing nothing costs exactly that
   * tracking and nothing else.
   *
   * Injected rather than constructed in here for the reason `newSessionUuid`
   * and `branchReader` are: the real one writes a file in the user's
   * `userData`, and a unit test that did so would leave state behind and answer
   * differently on the second run.
   */
  history?: SessionHistory;
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
   * Continue the conversation a previous run left under this id (HIVE-88).
   *
   * Honoured only when the history can name that conversation —
   * `SessionHistory.resumable` — and ignored otherwise, so a restored row whose
   * record predates uuids, or a build with no history at all, gets the ordinary
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
  /**
   * The working directory this session was last observed in, or `undefined`.
   *
   * **Main's own observation**, taken from that session's hook payloads — never
   * anything the renderer said. That provenance is the reason the explorer's
   * root may follow it: `fs/session-roots.ts` widens the read boundary on the
   * strength of this value, and a renderer-supplied path would have made that
   * a hole rather than a feature.
   *
   * `undefined` until the first hook carrying a cwd arrives, which is the
   * ordinary state for a session that has just spawned — and answered correctly
   * for one that has since **exited**, because its editor tabs outlive it and
   * re-rooting them at the project would put the wrong bytes in front of the
   * user under the right filename.
   */
  observedCwd(entityId: string): string | undefined;
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
    skills,
    newSessionUuid = randomUUID,
    branchReader,
    history,
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
  /**
   * Where each session was last observed working — **kept after it exits**.
   *
   * Separate from {@link lastBranch}, which `settleExit` deletes so that a
   * restarted session reusing the same entity id does not have its first branch
   * read suppressed as a repeat. That deletion is right for branch publishing
   * and wrong for this: the explorer's root and every editor buffer opened from
   * a session resolve through `observedCwd`, and a session ending does not close
   * its tabs. Forgetting the cwd there would silently re-root those buffers at
   * the project — so a file opened from a worktree would reload the project's
   * copy of itself, and a save would then be offered as an overwrite of the
   * wrong file.
   *
   * Bounded by the number of sessions opened in one run, which is the same
   * bound the history already carries, and each entry is one short string.
   */
  const lastCwd = new Map<string, string>();

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
      /**
       * A declared finish leaves on its own channel, not as a status (HIVE-93).
       *
       * Swapped here, at the one place an ending reaches the renderer, rather
       * than by teaching `activity.ts` a fourth status: that module derives what
       * a *pty* shows, and "the work is finished" is not derivable from one. It
       * is a fact this layer holds and that one has no business knowing, so
       * `DerivedStatus` stays three members wide and the tracker stays honest.
       *
       * `instead of`, not `as well as`. The renderer's response to a finish is
       * structural — end the row, mint no successor, fall back to the
       * orchestrator if this was the visible tab — and a `terminated` status
       * arriving beside it would overwrite the ending the user asked for with
       * the mechanism that delivered it.
       */
      if (status === 'terminated' && declaredDone(entityId)) {
        publishFinished(entityId);
        return;
      }
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
  /**
   * Generate the skills plugin once at startup (HIVE-96).
   *
   * Every path that needs it — both spawn handlers, and the Settings pane's
   * first `list()` — syncs first, so this is not load-bearing. It is here
   * because the directory should exist from launch rather than appearing at the
   * first spawn: `<userData>/hive/plugin` is then inspectable by anyone
   * debugging a session, in the same state the next session will get, and the
   * documented "regenerated at launch and before every spawn" is true of the
   * code rather than only of the second half.
   *
   * Fire-and-forget for the same reason `hooks.start` below is: nothing waits
   * on it, and its own failure path is non-fatal.
   */
  void skills?.sync();

  void hooks?.start({
    knowsSession: (entityId) => registry.sessionFor(entityId) !== undefined,
    /*
      The declaration, recorded and nothing more (HIVE-93). Acting on it here
      would write `/exit` into a pty in the middle of the turn that is asking
      for it — see `armFinish`.
    */
    onDone: (entityId) => armFinish(entityId),
    /*
      Forwarded, and nothing more (HIVE-101). Main has no opinion about the
      boot overlay: the renderer owns the cover, the timeout and the keystroke
      that lift it, because all three are about what is on screen. What main
      knows and the renderer cannot is that a real `SessionStart` arrived.
    */
    onReady: (entityId) => publishReady(entityId),
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
        ...(event.backgroundShells === undefined
          ? {}
          : { backgroundShells: event.backgroundShells }),
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
       * `/done`'s two turning points, both of them events on this stream
       * (HIVE-93).
       *
       * `Stop` is the end of a turn, and the app's only reliable signal that the
       * REPL is back at an empty prompt — so it is when a declared finish is
       * acted on. `SubagentStop` deliberately is not: a helper agent finishing
       * says nothing about the session.
       *
       * `UserPromptSubmit` is the opposite turning point — the user went back to
       * work, which withdraws a declaration nothing has acted on yet.
       *
       * Both sit after the status publish so a session that is closing still
       * reports the turn it just finished; its last live status stays truthful
       * right up until the exit replaces it.
       */
      if (event.event === 'Stop') closeFinished(event.entityId);
      else if (event.event === 'UserPromptSubmit') disarmFinish(event.entityId);
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
        keys: [event.key],
        source: event.source,
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
      /*
        A declaration belongs to the conversation that made it (HIVE-93).
        `/clear` retires that conversation and opens a successor on the same
        terminal, so a finish still armed here would close a session the user
        has only just started — and the row it closed would not even be the one
        that asked.
      */
      forgetFinish(entityId);
      /**
       * The uuid no longer names this terminal's conversation (HIVE-88).
       *
       * `/clear` starts a new one under a new id, and the only hook that
       * carries that id — `SessionStart` — never reaches the receiver (see
       * `hook-contract.ts`). So the history cannot learn it, and keeping the
       * old one would let a later `--resume` reopen the conversation the user
       * deliberately ended. Dropped, so a restored row for this terminal opens
       * as a fresh session instead.
       */
      history?.record(entityId, { sessionUuid: undefined });
      /**
       * The branch dedupe is primed for a row that no longer exists.
       *
       * `publishBranch` suppresses a read whose `{branch, cwd}` it has already
       * published, and `lastBranch` is only ever cleared in `settleExit` — which
       * `/clear` does not reach, because the pty is still running. The successor
       * row therefore inherits a dedupe entry it never earned: its branch never
       * publishes, and so no ticket candidate is ever offered for it.
       *
       * That lands squarely on the case the branch signal exists for — a session
       * cleared and continued on `feat/hive-111-ledger` would never reach the
       * HIVE-111 card unless the user said the key out loud again. Forgetting
       * here costs one `git` read on the successor's first hook.
       */
      lastBranch.delete(entityId);
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
     * The history's `status` is documented as the *last known* one, and until
     * HIVE-88 it was the first: `begin` wrote `working` and nothing touched it
     * again before `settleExit`. That was enough for a fresh launch, which
     * rewrites every live status to `closed` anyway. It is not enough for a
     * renderer that starts in front of running ptys — the row it hydrates as
     * live should say what the session is doing, not what it was doing when
     * it started. The *ending* stays with `settleExit`, which also owns
     * `endedAt`: a status written here would land without the timestamp that
     * makes it sortable, and retention sorts on `endedAt`. `done` never reaches
     * this function at all — a declared finish leaves on its own channel.
     */
    if (status !== 'terminated') history?.record(entityId, { status });

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
   * The session finished on purpose and its terminal is gone (HIVE-93).
   *
   * The mirror of {@link publishCleared}, and everything is torn down here where
   * nothing is torn down there — the pty has already exited by the time this
   * runs, because it is the exit that triggers it. What the two share is the
   * shape of the answer: a boundary the renderer responds to structurally,
   * carrying only the entity, leaving the renderer to decide what a finished row
   * looks like and whether it was the tab in front of the user.
   */
  /**
   * Claude is up (HIVE-101).
   *
   * The thinnest publisher in this file, and deliberately so — there is no
   * state to settle, nothing to tear down, and no race to arbitrate. It is
   * also **not idempotent here on purpose**: `/clear` produces a second
   * `SessionStart` and therefore a second one of these, and suppressing the
   * repeat would mean main keeping a per-session flag to answer a question the
   * renderer can answer for free.
   */
  function publishReady(entityId: string): void {
    send(CH.sessionReady, { entityId } satisfies SessionReadyEvent);
  }

  function publishFinished(entityId: string): void {
    /*
      Asked rather than assumed. `history.resumable` is the only thing that knows
      whether a uuid still names this terminal's conversation — a `/clear`
      withdraws it, and nothing can recover the successor's — so a finish after
      a clear is honestly not resumable even though every other finish is.
    */
    send(CH.sessionFinished, {
      entityId,
      resumable: history?.resumable(entityId) !== undefined,
    } satisfies SessionFinishedEvent);
  }

  /**
   * How long `/exit` gets to take before the pty is killed instead (HIVE-93).
   *
   * A backstop for a `/exit` that was written but never acted on — an agent
   * wedged mid-turn, a REPL that never returned to its prompt. Not a bound on
   * the *turn*: the write only happens at `Stop`, which is already the end of
   * one, so anything after it is a session that is not going to close on its
   * own.
   *
   * Ten seconds because the honest outcomes are "immediately" and "never". A
   * healthy `claude` handling `/exit` at an empty prompt takes milliseconds, and
   * every extra second here is a row the user asked to close still sitting in
   * the rail. Killing is not lossy: the transcript stays readable either way,
   * and the ending is still recorded as `done` because the *declaration* is what
   * decides that, not which of the two mechanisms got there.
   */
  const DONE_EXIT_TIMEOUT_MS = 10_000;

  /** What `/done` writes into the pty. See {@link closeFinished}. */
  const EXIT_COMMAND = '/exit\r';

  /**
   * Sessions that have declared themselves finished (HIVE-93).
   *
   * Presence means `/done` was invoked and the app owes this terminal an exit.
   * The value is the kill timer, `null` until `/exit` has actually been written
   * — so the map carries both halves of the state in one entry, and the
   * distinction between "armed" and "closing" is a value check rather than a
   * second collection that could disagree with this one.
   *
   * **This flag is the only thing that separates `done` from `terminated`.**
   * After the write, the app's `/exit` and a user's are the same bytes in the
   * same pty; nothing downstream can tell them apart, and nothing should try.
   * What is recorded depends on whether somebody said the work was finished
   * before the process went — which is exactly the judgement story 108 said a
   * pty cannot make, now supplied by whoever typed `/done`.
   */
  const finishing = new Map<string, ReturnType<typeof setTimeout> | null>();

  /** Whether this session has declared itself finished. */
  const declaredDone = (entityId: string): boolean => finishing.has(entityId);

  /**
   * `/done` was invoked in this session.
   *
   * Nothing happens to the terminal yet. The POST arrives *during* a turn — it
   * is a tool call the agent is in the middle of — and writing `/exit` into a
   * pty whose REPL is still working would put five characters somewhere nobody
   * can predict. The close waits for `Stop`, which is the app's only reliable
   * signal that the prompt is empty again.
   */
  function armFinish(entityId: string): void {
    if (registry.sessionFor(entityId) === undefined) return;
    // Re-invoking `/done` in a session already closing changes nothing, and
    // must not restart the timer or write a second `/exit`.
    if (finishing.has(entityId)) return;
    finishing.set(entityId, null);
  }

  /**
   * The user kept working after `/done`, so the session is not finished.
   *
   * Without this the *next* `Stop` would close a session that had gone back to
   * work — the user runs `/done`, changes their mind, types a new prompt, and
   * the terminal shuts on them at the end of that turn. A typed prompt is the
   * clearest possible statement that the declaration no longer holds.
   *
   * **Including one already closing**, which an earlier draft refused on the
   * reasoning that the exit was in flight and there was nothing left to call
   * off. There is: `/exit\r` is written into a pty, not handed to a REPL that
   * has promised to act on it. If the user had a half-typed draft at the
   * prompt, those five characters append to it and submit it as an ordinary
   * prompt — the session goes back to work, and `UserPromptSubmit` is the proof
   * that it did. Left armed, the force-kill lands ten seconds later, in the
   * middle of a turn, and files it as `done`.
   *
   * So a typed prompt withdraws the declaration in either state, and the kill
   * timer goes with it. The backstop's premise — "anything after `Stop` is a
   * session that is not going to close on its own" — stops holding the moment a
   * new turn starts.
   */
  function disarmFinish(entityId: string): void {
    if (finishing.has(entityId)) forgetFinish(entityId);
  }

  /**
   * The turn ended in a session that declared itself finished — close it.
   *
   * `/exit` rather than a signal, and that is the whole reason this is written
   * into the pty instead of killed from outside. `bootstrap.ts` starts sessions
   * as `claude … && exit`, so the login shell leaves **only** on a clean exit:
   * a `SIGTERM` makes `claude` exit non-zero, the `&&` short-circuits, and the
   * user is left with a live shell wrapped around a dead agent — the one
   * outcome nobody asked for. `/exit` exits 0, the `&&` fires, the shell goes,
   * and the pty closes on its own.
   *
   * Written straight to the pty rather than through `write`, deliberately: that
   * path holds input while the bootstrap is pending, and this can only run for a
   * session whose agent is far enough along to have called a tool. Holding it
   * would mean queueing an exit behind a bootstrap that has already finished.
   */
  function closeFinished(entityId: string): void {
    if (finishing.get(entityId) !== null) return;

    const sessionId = registry.sessionFor(entityId);
    if (sessionId === undefined) {
      finishing.delete(entityId);
      return;
    }

    ptyIpc.write(sessionId, EXIT_COMMAND);

    finishing.set(
      entityId,
      setTimeout(() => {
        const live = registry.sessionFor(entityId);
        if (live === undefined) return;
        console.info(
          `[hive] ${entityId} did not exit after /done — killing the terminal`,
        );
        ptyIpc.kill(live);
      }, DONE_EXIT_TIMEOUT_MS),
    );
  }

  /** Drop a session's finish state, timer included. */
  function forgetFinish(entityId: string): void {
    const timer = finishing.get(entityId);
    if (timer !== undefined && timer !== null) clearTimeout(timer);
    finishing.delete(entityId);
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
    lastCwd.set(entityId, cwd);
    /*
      HIVE-87. The same fact the renderer is about to be told, kept where it
      survives a quit. `branch` is nullable here and the record's is optional,
      so a `null` omits the key rather than storing "known to be nothing" — the
      store renders an em dash for both, and the history should not invent a
      distinction the app does not draw.
    */
    history?.record(entityId, { ...(branch === null ? {} : { branch }), cwd });
    send(CH.sessionBranch, { entityId, branch, cwd } satisfies SessionBranchEvent);

    /**
     * The branch is also a ticket candidate — the second signal.
     *
     * A prompt says which ticket a session is for exactly once, and only if the
     * user phrased it in a way the scanner recognises. A branch says it for as
     * long as the work lasts, which is what covers the session resumed the next
     * morning onto `feat/hive-111-ledger` having never spoken the key here.
     *
     * ## Why it costs no extra Jira calls to speak of
     *
     * This sits after the dedupe above, not before it. `publishBranch` returns
     * early unless the branch or cwd actually *changed*, so a candidate is
     * emitted once per distinct branch per session — not once per hook event,
     * which on a busy turn would be dozens. The renderer confirms each one with
     * Jira, so that dedupe is the thing standing between this feature and a
     * network call on every tool call the agent makes.
     *
     * ## Why it is still only a candidate
     *
     * Same reason the prompt's is: main does not know what is real. The branch
     * scanner is looser than the prompt's by design — it has no grammar to read
     * — so `release-2024-11` arrives here as `RELEASE-2024`, and the renderer's
     * Jira check is what discards it. Nothing is associated or renamed on
     * main's say-so.
     */
    /*
      A command entity is not a session and can never hold a ticket, so a
      candidate for one is a Jira read the store is guaranteed to throw away.
      `openCommand` routes through `startProcess` like everything else, which is
      the only reason this is reachable at all.
    */
    if (commandEntities.has(entityId)) return;

    const candidates = ticketKeysFromBranch(branch);
    if (candidates.length > 0) {
      send(CH.sessionTicketIntent, {
        entityId,
        keys: candidates,
        source: 'branch',
      } satisfies SessionTicketIntentEvent);
    }
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
      history?.record(entityId, { name });
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
      /**
       * The ending, recorded where it is actually known (HIVE-87).
       *
       * Deliberately here and not in a shutdown hook. `runShutdown()` invokes
       * every hook body synchronously and then awaits them together, so a
       * flush registered there races the pty teardown instead of following it
       * — and a crash or a SIGKILL runs no hook at all. This is the one place
       * that sees an ending however it arrived, `ptyExit` or `ptyLost`, so it
       * is the only place the fact can be captured rather than inferred.
       *
       * **Before `activity.exited`, and that ordering is load-bearing**
       * (HIVE-93). `exited()` publishes synchronously, so for a declared finish
       * it reaches `publishFinished` — which asks the history whether this
       * conversation can be resumed — inside this very statement. Recorded
       * second, that question arrived at a record still claiming to be live and
       * carrying no `endedAt`, so `resumable` answered "no" for **every** `/done`
       * and the Resume control never appeared on the rows the feature exists
       * for. The history has to know the session is over before anything asks it
       * what that means.
       */
      /**
       * `done` when the session said so first, `terminated` otherwise
       * (HIVE-93).
       *
       * Read here rather than passed in, because every caller of `settleExit`
       * reaches it the same way — a pty exited — and none of them knows why.
       * That is the point: a deliberate `/exit`, the `/exit` this app wrote
       * after `/done`, and a kill are indistinguishable by the time they get
       * here, so the only honest input is whether a declaration was on file.
       */
      history?.record(
        entityId,
        declaredDone(entityId)
          ? { status: 'done', endedBy: 'finished', endedAt: Date.now() }
          : { status: 'terminated', endedAt: Date.now() },
      );
      activity.exited(entityId);
    }
    registry.close(entityId);
    /*
      After `activity.exited` and the record above, both of which read it. The
      kill timer goes with it — the pty is gone, so a pending force-kill has
      nothing left to reach and would fire against a closed registry entry.
    */
    forgetFinish(entityId);

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
    /*
      Before the kill, not after it (HIVE-93). A restart while a `/done` is
      still armed would otherwise reach `settleExit` with the declaration on
      file, and a generation the user *interrupted* would be recorded as one
      that finished — the row flashing `done` on its way to respawning. A
      restart is not an ending; withdrawing here is what keeps the two apart.
    */
    forgetFinish(request.entityId);

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
    /*
      No `forgetFinish` beside this one, deliberately (HIVE-93). The tracker
      needs clearing here because it keeps its entry past an exit; the finish map
      does not, because `settleExit` drops it on every ending — and a live
      session cannot be re-opened, so there is no path that reaches a spawn with
      a declaration still standing. A defensive call here would be a branch no
      test could reach.
    */

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
    const settingsPath = hooks?.settingsPathFor();

    /**
     * The generated plugin, read but **not** regenerated here (HIVE-96).
     *
     * `spawn` is synchronous on purpose: its "attach, never respawn" guard and
     * the registration that satisfies it must not be separated by an await, or
     * two rapid opens of the same entity both pass the guard and both spawn —
     * which is the single most destructive thing this layer can do.
     *
     * So the regeneration happens one level up, in the `session:open` handler,
     * which is already asynchronous and runs before this is reached. See
     * `ipc/index.ts`.
     */
    const pluginDir = skills?.pluginDirPath() ?? null;

    /**
     * Hoisted out of the `sessionCommand` call it used to sit inside (HIVE-87).
     *
     * It has to reach two places now — the command line, and the history — and
     * calling `newSessionUuid()` twice would put a different uuid in each. The
     * history's copy would then name a transcript that does not exist, which is
     * precisely the thing recording it is meant to make possible.
     */
    /**
     * A resumed conversation keeps the uuid it already has (HIVE-88): that is
     * the transcript `--resume` opens, and minting a new one here would name
     * a session that was never started. `undefined` from the history means
     * there is nothing to pick up — no history, no record, no uuid, or an id
     * this run began — and the request degrades to the plain spawn it would
     * otherwise have been. The renderer asked to resume; main decides whether
     * it can.
     */
    const resumeUuid =
      request.resume === true ? history?.resumable(request.entityId) : undefined;
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
    history?.begin(
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
         * **Nothing is named here any more, and that is the feature** (HIVE-108).
         *
         * HIVE-61 sent the row's own id — `--name sess-07` — so that the agent's
         * prompt box, its `/resume` picker and the terminal title all agreed with
         * the rail. The cost of that agreement turned out to be the name itself:
         * **`--name` suppresses Claude Code's own titling entirely.** Two arms of
         * a real `claude`, same prompt, same moment, differing in nothing else:
         *
         * ```
         * --name sess-probe   ai-title: (none)               OSC: "✳ sess-probe"
         * (no flag)           ai-title: "Mutex explanation"  OSC: "✳ Claude Code"
         *                                                    → "◐ Mutex explanation"
         * ```
         *
         * Every session this app has ever spawned carries a `custom-title` and no
         * `ai-title` for exactly this reason — 25+ transcripts, some 3,000 lines
         * long, all of them mute. The Hive was not failing to infer names; it was
         * stopping Claude from inferring them.
         *
         * So the id fallback is gone. A session opens unnamed, Claude titles it
         * from the conversation once there is one, and the title arrives on the
         * OSC-0 stream `readTitle` has parsed since HIVE-61 — no new transport,
         * no prompt scraping, no second inference engine. `hiveNameFromTitle`
         * spells it the way the rail spells names.
         *
         * What is given up is the opening frame: until Claude has titled it, the
         * label on its input box is simply **absent**, where it used to read
         * `sess-07`. Measured against a real `claude` — the name is drawn into
         * the box's top border, and with no name the border is unlabelled:
         *
         * ```
         * named    ────────────────────── sess-probe ─
         * unnamed  ──────────────────────────────────
         * ```
         *
         * (HIVE-108 first recorded this as "the prompt box says `Claude Code`".
         * It does not. `Claude Code` is the *terminal title* Claude writes while
         * unnamed, and the splash banner — which prints either way and names the
         * product, not the session.)
         *
         * The row is untouched: `nameFromTitle` maps that title to the *absence*
         * of a name, so the rail goes on saying `sess-07` until a real one lands.
         *
         * **This subsumes HIVE-107.** That fix carved `--resume` out of the id
         * fallback, because `--name` on a resume renames the stored conversation
         * rather than labelling a new one. With no fallback left there is nothing
         * to carve: a resume sends no flag because *no spawn does*.
         *
         * An explicit `request.name` still survives, because that is a caller
         * saying something the transcript cannot: *call it this from now on*.
         * Nothing asks for it today — a ticket session is named by the store,
         * which pins `HIVE-73` in front of whatever Claude infers, rather than by
         * a flag that would cost it the inference.
         */
        ...(request.name === undefined ? {} : { name: request.name }),
        sessionUuid,
        resume,
        /*
          One file for every session since HIVE-82: nothing in it varies by
          theme any more, because Claude's is pinned to `dark-ansi` and the
          colours resolve against the terminal's palette at paint time.
        */
        ...(settingsPath == null ? {} : { settingsPath }),
        /*
          The generated plugin, when there is one (HIVE-96). Resolved above for
          the same reason `settingsPath` is: it is main's own path, chosen at
          spawn, and it never crosses IPC — `parseSpawnRequest` has no field for
          it and deliberately never will.
        */
        ...(pluginDir == null ? {} : { pluginDir }),
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
          already heard its opening instruction, and a history record carries
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
    observedCwd: (entityId) => lastCwd.get(entityId),
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
      /*
        Timers first, then the map. These are the only ones in this layer that
        can outlive a session by design — a force-kill scheduled ten seconds out
        — and this hook exists precisely so nothing holds `before-quit` open
        after the processes are gone (HIVE-93).
      */
      for (const entityId of [...finishing.keys()]) forgetFinish(entityId);
      registry.clear();
      restarting.clear();
      exitWaiters.clear();
      commandExit.clear();
      commandEntities.clear();
    },
  };
}
