import { spawn, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  BrowserWindow,
  Notification,
  app,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';

import {
  formatRunCost,
  type AgentLinesPush,
  type AgentRunResult,
  type AgentStatus,
  type AgentStatusPush,
  type WakeSpec,
} from '@shared/agent-contract';
import { AUTH_ENV_KEYS } from '@shared/config-contract';
import type {
  CloneStartResult,
  CommandDiagnostic,
  ConfigSnapshot,
  EnvDiagnostic,
} from '@shared/config-contract';
import type {
  DirEntry,
  FileContent,
  FsChangedEvent,
  FsRefusal,
  FsResult,
  RootInfo,
  SearchResults,
  WriteFileResult,
} from '@shared/fs-contract';
import type { GhResult, PrRecord, PrsSnapshot } from '@shared/github-contract';
import {
  parseAckRequest,
  parseAgentNameRequest,
  parseAgentRenameRequest,
  parseAgentRunRequest,
  parseAgentWriteRequest,
  parseAddProjectRequest,
  parseCloneRequest,
  parseDiagnoseCommandRequest,
  parseReadDirRequest,
  parseReadFileRequest,
  parseRootRequest,
  parseSearchRequest,
  parseWatchRequest,
  parseWriteFileRequest,
  parseDiagnoseEnvRequest,
  parseSpawnRequest,
  parseKillRequest,
  parseLedgerAnswerRequest,
  parseLedgerPostBody,
  parseLedgerReadQuery,
  parseRemoveProjectRequest,
  parseRenameProjectRequest,
  parseSetProjectKeyRequest,
  parseReorderProjectsRequest,
  parseRepointProjectRequest,
  parseResizeRequest,
  parseAddJiraCommentRequest,
  parseApplyJiraTransitionRequest,
  parseJiraConversationRequest,
  parseJiraIssueRequest,
  parseJiraSearchRequest,
  parseJiraTransitionsRequest,
  parseSetJiraRequest,
  parseSetJiraTokenRequest,
  parseDismissRequest,
  parseMarkReadRequest,
  parseNotificationAction,
  parseSetNotificationsRequest,
  parseSetProjectRuntimeRequest,
  parseSetRuntimeRequest,
  parseSearchPrsRequest,
  parseSessionNoteRequest,
  parseSessionPrRequest,
  parseSkillNameRequest,
  parseSkillRenameRequest,
  parseSkillWriteRequest,
  parseWriteRequest,
} from '@shared/guards';
import {
  CH,
  type AppInfo,
  type IntegrationsStatus,
  type LoginEnvStatus,
  type NotificationActivateEvent,
  type NotificationDeliveryStatus,
  type NotificationDismissedEvent,
  type NotificationReadEvent,
} from '@shared/ipc-contract';
import type {
  JiraComment,
  JiraIdentity,
  JiraIssue,
  JiraLink,
  JiraResult,
  JiraSearchResult,
  JiraStatus,
  JiraTransition,
} from '@shared/jira-contract';
import { LEDGER_DIR, OVERMIND } from '@shared/ledger-contract';
import { SESSION_NAME_DISPLAY_MAX } from '@shared/session-contract';
import {
  SESSION_HISTORY_FILE,
  type SessionHistoryEntry,
} from '@shared/session-history-contract';
import type { UpdateStatus } from '@shared/update-contract';

import { createAgentsRuntime, type AgentRegistry } from '../agents';
import {
  agentPromptFile,
  agentStateFile,
  agentWorkdir,
  agentsRoot,
} from '../agents/paths';
import { createPermissions, type Permissions } from '../agents/permissions';
import { createAgentRunFiles } from '../agents/run-files';
import {
  createRunTracker,
  type ChildLike,
  type RunTracker,
} from '../agents/runs';
import { createScheduler, type Scheduler } from '../agents/scheduler';
import { createAgentState, type AgentState } from '../agents/state';
import { mergeRunState } from '../agents/summary';
import { createWakeCommand } from '../agents/wake-command';
import { createCloneFlow, type CloneFlow } from '../clone';
import {
  addProject,
  configPath,
  getConfig,
  reloadConfig,
  removeProject,
  renameProject,
  reorderProjects,
  repointProject,
  resetConfig,
  setJira,
  setNotifications,
  setProjectKey,
  setProjectRuntime,
  setRuntime,
} from '../config';
import { diagnoseEnv } from '../config/env-diagnostic';
import { loginEnvStatus } from '../config/login-env';
import { diagnoseCommand, effectiveRuntime } from '../config/runtime';
import { isSafeExternalUrl } from '../external-links';
import {
  createFsWatchLayer,
  forgetProbedRoots,
  readDirectory,
  readFileContent,
  readRoot,
  setSessionCwdLookup,
  searchProject,
  writeFileContent,
  type FsWatchLayer,
} from '../fs';
import { createHookRuntime } from '../hooks';
import { readGhStatus, runCommand } from '../integrations/gh';
import { createGithub } from '../integrations/github';
import { runAsync } from '../integrations/github/run';
import { createJira } from '../integrations/jira';
import { credentialFile } from '../integrations/jira/auth';
import { createLedger } from '../ledger';
import { createDeliver } from '../ledger/deliver';
import { createLedgerNotifier } from '../ledger/notify';
import { createMcpRuntime } from '../mcp';
import {
  createNotificationHub,
  createNotifier,
  createSessionNames,
} from '../notifications';
import { registerPtyHost } from '../pty-host';
import { createSessions, type Sessions } from '../sessions';
import {
  createSessionHistory,
  type SessionHistory,
} from '../sessions/history';
import { onShutdown } from '../shutdown';
import { createSkillsRuntime, type SkillsRuntime } from '../skills';
import { PLUGIN_DIR } from '../skills/paths';
import { parseSaveThemeRequest, pickTheme, saveTheme } from '../theme';
import {
  checkForUpdatesInteractively,
  downloadUpdate,
  installUpdate,
  setUpdateNotificationSink,
  updateStatus,
} from '../updates';

import { assertSender } from './sender';

/**
 * Channel handlers (story 082).
 *
 * Every handler validates before acting: `assertSender` first, then the payload
 * guard. The renderer is untrusted input because terminal output is untrusted
 * input and it renders there.
 *
 * `app:info` proved the path in story 082; `config:*` landed in 090; the PTY
 * channels and their flow control are story 093's.
 */

/**
 * Fire-and-forget channels (story 093).
 *
 * `send`, not `invoke`, for keystrokes, resizes and acks: awaiting a round trip
 * per character would put the main process in the typing-latency path, and
 * ordering is already guaranteed on a single channel — which is what actually
 * matters.
 */
function on(
  channel: string,
  handler: (event: IpcMainEvent, payload: unknown) => void,
): void {
  ipcMain.on(channel, (event, payload: unknown) => {
    assertSender(event);
    try {
      handler(event, payload);
    } catch (cause) {
      // A `send` channel has no reply, so a throw here would be an unhandled
      // rejection in main rather than an error the renderer sees. Rejected
      // input is logged and dropped — never acted on.
      console.error(`[hive] rejected ${channel}:`, cause);
    }
  });
}

/** Wrap a handler so sender validation cannot be forgotten on a new channel. */
function handle<T>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, payload: unknown) => T,
): void {
  ipcMain.handle(channel, (event, payload: unknown) => {
    assertSender(event);
    return handler(event, payload);
  });
}

/**
 * Why the OS last refused a desktop notification, or `null`.
 *
 * Module scope rather than a field on the hub, because it is not a fact about
 * notifications — it is a fact about **this operating system's answer to this
 * process**, learned the only way it can be learned, by trying. The hub is
 * deliberately ignorant of how a notification is presented, and giving it
 * somewhere to store a macOS authorization error would be the first crack in
 * that.
 *
 * Never reset. A refusal is not transient in the case that produces it — an
 * unsigned bundle stays unsigned for the life of the process — and clearing it
 * on the next successful send would mean the settings pane flickered between
 * two accounts of the same system.
 */
let systemNotificationRefusal: string | null = null;

let sessions: Sessions | null = null;
/**
 * The session history (HIVE-87), or `null` before registration.
 *
 * Held here rather than reached through `sessions` because two unrelated things
 * need it: the session layer writes to it, and `session:history` reads from it.
 * Routing the read through the session layer would mean widening that layer's
 * surface with a verb it does not otherwise need.
 */
let history: SessionHistory | null = null;
/**
 * The custom-skills runtime (HIVE-96), or `null` before registration.
 *
 * Held here for the reason `history` is: two unrelated callers need it. The
 * session layer syncs it before every spawn and reads its path, and the four
 * `skills:*` handlers below read and write the tree it manages.
 */
let skills: SkillsRuntime | null = null;
let agents: AgentRegistry | null = null;
/**
 * `~/.hive/ledger/agents.json`, or `null` before registration (HIVE-115).
 *
 * Held beside `agents` rather than inside it because they are two different
 * kinds of fact about the same names — the registry owns what the user wrote,
 * this owns what the app has since done — and three unrelated callers need
 * this one: `agents:list` merges it, the run tracker writes it, and the
 * shutdown hook flushes it.
 */
let agentState: AgentState | null = null;
/**
 * Live agent runs, or `null` before registration (HIVE-115).
 *
 * Module scope, like `sessions`, and for the same reason: it is reached from
 * two places that never see each other. The `agents:run` / `agents:kill`
 * handlers below drive it, and the hook receiver's agent route calls
 * `noteTurnEnded` on it when a turn ends (HIVE-115, task 8).
 */
let runs: RunTracker | null = null;
/**
 * Ledger-addressed wakes, or `null` before registration (HIVE-120).
 *
 * Module scope for the same reason as `runs`, and reached lazily by the tracker
 * that it in turn drives: `onRunClosed` is a dependency of `createRunTracker`,
 * and the scheduler cannot be built until the tracker it calls exists. One of
 * the two has to reach the other through a binding rather than an argument, and
 * this is the one whose consumers already tolerate `null`.
 */
let scheduler: Scheduler | null = null;
/**
 * Answers become grants, or `null` before registration (HIVE-119).
 *
 * Module scope for the same reason as `scheduler`, and armed at the same
 * point in the composition: it neither spawns nor needs `mcp.start()`
 * itself, but `ledger.onChange` is wired far above where `agents` and
 * `ledger` exist, so the dispatch there reaches this the same way it reaches
 * `scheduler` — through a binding read at call time, not a value closed over
 * at registration.
 */
let permissions: Permissions | null = null;
/**
 * The agent names the ledger will accept as a party.
 *
 * A `Set` rather than an `await agents.list()` because `knowsParty` is
 * synchronous — it is consulted inside `Ledger.append`, which the receiver
 * calls on a request it must answer. It is refreshed from the registry at boot
 * and on every folder change, and a name is also added the moment a wake
 * command is successfully built for it: building one means main read that
 * agent's definition off its own disk, which is a stronger proof of existence
 * than a listing that may be a few hundred milliseconds old.
 */
const knownAgents = new Set<string>();
/**
 * The subset of {@link knownAgents} whose definitions take ledger wakes.
 *
 * A second set rather than a lookup through the registry, for the reason
 * `knownAgents` is a set at all: the scheduler is consulted synchronously from
 * inside `Ledger.append`, and `agents.list()` is a promise that re-reads and
 * re-parses every definition on disk.
 *
 * Deliberately **not** widened by a live run the way `knownAgents` is. That
 * exception exists so a run already going keeps its right to write to the log
 * when its file stops parsing mid-edit; it says nothing about whether its author
 * asked for ledger wakes, and inferring one from the other would wake an agent
 * on a setting nobody chose.
 */
const ledgerAgents = new Set<string>();
/**
 * Every valid agent's schedule, for the scheduler's tick (HIVE-121).
 *
 * A third cache beside the two above, filled in the same pass and for the same
 * reason: the tick runs every sixty seconds and `agents.list()` is a promise
 * that re-reads and re-parses every definition on disk. Doing that on a timer
 * would put a folder walk between the clock and every wake.
 *
 * It being *rebuilt* on every folder change is what makes "a definition change
 * re-arms the schedule" need no code: there is no armed timer to re-arm, only
 * a map the next tick reads again. An `invalid` definition is left out, which
 * is what keeps a broken file off the timer while it stays listed to be fixed.
 */
const agentSchedules = new Map<string, { wake: WakeSpec; dailyUsd?: number }>();
/**
 * Whether {@link agentSchedules} has been filled at least once.
 *
 * An empty map means two very different things, and the scheduler must not
 * confuse them: "this machine has no scheduled agents" and "the folder walk has
 * not finished yet". The second is the common case at boot — `agents.list()`
 * reads and parses every `AGENT.md`, while `scheduler.start()` ticks
 * synchronously — and reading it as the first would have the tick clear every
 * agent's overdue `nextRunAt` on the launch right after a missed window.
 */
let agentsListed = false;

/**
 * Re-read the folder into {@link knownAgents}.
 *
 * Fire-and-forget, and a failure is swallowed on purpose: this is the *cache*
 * of a fact, and the authoritative path — `command()` adding the name it just
 * read a definition for — does not depend on it. A rejected `list()` here means
 * an unrun agent cannot post to the ledger until the next folder change, which
 * is a far smaller failure than an unhandled rejection at startup.
 *
 * A folder listed as `invalid` is left out. It cannot be woken, so nothing can
 * legitimately write to the ledger as that name.
 *
 * A **live run** is the exception, and it is the epic's own premise rather than
 * a defensive edge case: an agent is meant to be edited in a text editor while
 * it works, and a save mid-edit routinely lands a file that does not parse. The
 * watcher fires, the rebuild drops the name, and everything the running child
 * does next is refused as an unknown party — its hooks 404, its `ledger_*` tool
 * calls come back refused, and at close the tracker's own `run.ended` append is
 * rejected, leaving a `run.started` with no end in the log that is supposed to
 * be the record of what happened. A run that is already going was authorised
 * when it started, so it keeps its name until it ends.
 */
function refreshKnownAgents(): void {
  void agents
    ?.list()
    .then((snapshot) => {
      knownAgents.clear();
      ledgerAgents.clear();
      agentSchedules.clear();

      for (const agent of snapshot.agents) {
        if (agent.invalid !== undefined) continue;

        knownAgents.add(agent.name);
        // The definition's own gate, cached beside the party register because
        // the scheduler is asked synchronously, from inside `Ledger.append`.
        if (agent.wake.on.includes('ledger')) ledgerAgents.add(agent.name);
        // And the schedule, for the tick — which is asked just as
        // synchronously, sixty seconds at a time.
        agentSchedules.set(agent.name, {
          wake: agent.wake,
          ...(agent.dailyUsd === undefined ? {} : { dailyUsd: agent.dailyUsd }),
        });
      }

      for (const name of runs?.live() ?? []) knownAgents.add(name);

      // Only now may the tick trust an absence — see `agentsListed`.
      agentsListed = true;
    })
    .catch(() => {
      // Keep whatever we already knew — including, deliberately, whether the
      // schedules have ever been read. A failed listing must not license the
      // tick to clear the times a previous one established.
    });
}
/** The clone flow (story 102), or `null` before registration. */
let cloneFlow: CloneFlow | null = null;
/** The single project watcher, or `null` before registration. */
let fsWatch: FsWatchLayer | null = null;

/** A plain object, for the payload guards below. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The terminal on the centre stage, as the renderer last reported it (HIVE-81).
 *
 * Module scope for the reason `systemNotificationRefusal` is: it is a fact
 * about this process's window, not about notifications, and the hub is
 * deliberately ignorant of what the user is looking at. The hub asks a
 * predicate; it never holds this.
 */
let foregroundTerminalId: string | null = null;

/**
 * Whether **any** window of this app has focus right now.
 *
 * Read from `BrowserWindow` rather than published by the renderer, and that
 * asymmetry is the whole design. A renderer-published focus boolean goes stale
 * in exactly the case the feature exists for — the window hidden, the app in
 * the background — because the renderer stops running to update it.
 *
 * ## "Any window", not "the main window", and that is on purpose
 *
 * The app creates three (`window.ts`, `splash.ts`, `about.ts`), so with the
 * About panel focused over the main window this still answers `true` and the
 * session on the stage still reads as foreground. That is the right answer,
 * not a leak: About is a small frameless panel, the terminal is visible behind
 * it, and the user is a keystroke from the window they were already watching.
 * The question the gate asks is "is this session on the user's screen and in
 * front of them", and it is.
 *
 * The failure mode worth avoiding is the opposite one — going quiet when the
 * user cannot see anything — and no window of ours being focused is exactly
 * that. Narrowing this to the main window would instead make the About panel
 * (or the splash, during startup) turn every foreground session into an
 * interruption about something on screen.
 */
const windowFocused = (): boolean =>
  BrowserWindow.getAllWindows().some(
    (window) => !window.isDestroyed() && window.isFocused(),
  );

/**
 * Is this terminal the one the user is already looking at?
 *
 * Both halves, and neither alone is the question. A matching id with every
 * window of ours behind another app is precisely when the notification is
 * worth raising. See {@link windowFocused} for what "focused" counts as.
 */
export const isForeground = (terminalId: string): boolean =>
  windowFocused() && foregroundTerminalId === terminalId;

/** Told when foreground state changes, so the re-arm can run (HIVE-81). */
const foregroundListeners = new Set<() => void>();

/**
 * Window focus changed, or the renderer reported a different terminal
 * (HIVE-81). Called from the `CH.uiForeground` handler below, and — via
 * {@link scheduleForegroundChange} — from the app-level window focus events.
 */
export const notifyForegroundChange = (): void => {
  for (const listener of foregroundListeners) {
    try {
      listener();
    } catch (cause) {
      console.error('[hive] foreground listener failed:', cause);
    }
  }
};

/**
 * Subscribe to foreground changes (HIVE-81's re-arm).
 *
 * The only way into `foregroundListeners`, which stays private: the notifier's
 * subscription in `registerIpcHandlers` goes through here, so the path a test
 * exercises is the path production runs.
 *
 * Answers a disposer. Nothing in the shipped app unsubscribes today — the one
 * subscription lives as long as the process — but a subscribe with no way out
 * is a leak waiting for its second caller, and the set was otherwise emptied
 * only by the test-only `resetIpcHandlers`.
 */
export function onForegroundChange(listener: () => void): () => void {
  foregroundListeners.add(listener);
  return () => {
    foregroundListeners.delete(listener);
  };
}

/**
 * A deferred re-evaluation, or `null`.
 *
 * See {@link scheduleForegroundChange} for why the deferral exists at all.
 */
let foregroundTick: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-evaluate foreground state **after the current focus shuffle settles**
 * (HIVE-81 review).
 *
 * ## Why the app-level events, and not the window's own
 *
 * This was wired as `focus`/`blur` on the main window, in `window.ts`, while
 * {@link windowFocused} counts *every* window of ours. The mismatch loses a
 * real notification: main focused with a gated pending row, the user opens the
 * About panel (main blurs, About focuses — still foreground, correctly nothing
 * promoted), then switches to another application. It is **About** that blurs,
 * and nothing was listening to it, so the re-arm never ran. The still-blocked
 * session kept its silent, already-read row for as long as the user was away —
 * exactly the failure the gate exists to prevent.
 *
 * `app.on('browser-window-blur' | 'browser-window-focus')` fires for every
 * window, which is the same set the predicate reads. Wiring the two per-window
 * instead — About, splash, and whatever comes next — is three sites to
 * remember and is the mistake `aux-windows.ts` was written about.
 *
 * ## Why it is deferred by a tick
 *
 * Because the app-level events walk straight into the opposite bug. On macOS
 * `blur` on the outgoing window fires **before** `focus` on the incoming one,
 * so switching from the main window to About passes through a moment in which
 * no window of ours is focused. Evaluating synchronously there promotes a
 * gated row and shows a toast about a session the user can see behind the
 * panel — contradicting {@link windowFocused}'s own reason for counting About
 * as foreground.
 *
 * One timer, coalescing every event that lands before it runs, so the burst of
 * a window switch becomes a single evaluation of the settled state. The re-arm
 * is a decision about whether to interrupt someone who has walked away; a tick
 * of latency is not a cost it can notice.
 *
 * ## The alternative that was rejected
 *
 * Narrowing {@link windowFocused} to `appWindows()` — the non-auxiliary
 * windows — was the other candidate. It *removes* the ordering hazard, and it
 * gets the answer wrong: with About focused no app window is focused, so every
 * gated row would promote with a toast about a terminal visible right behind a
 * small frameless panel. `isAuxiliary` answers "which windows are the app",
 * which is the question `activate` and the updater's dialogs ask. It is not
 * the question "is the app in front of the user", and this is that one.
 */
const scheduleForegroundChange = (): void => {
  if (foregroundTick !== null) return;
  foregroundTick = setTimeout(() => {
    foregroundTick = null;
    notifyForegroundChange();
  }, 0);
  // Never a reason to hold the process open; the app's own windows do that.
  foregroundTick.unref?.();
};

/** Undo {@link watchWindowFocus}, or a no-op before it has run. */
let unwatchWindowFocus: (() => void) | null = null;

/**
 * Wire the app-level focus events. Idempotent: a second call replaces the
 * first rather than doubling the listeners.
 */
function watchWindowFocus(): void {
  unwatchWindowFocus?.();
  app.on('browser-window-blur', scheduleForegroundChange);
  app.on('browser-window-focus', scheduleForegroundChange);
  unwatchWindowFocus = () => {
    app.removeListener('browser-window-blur', scheduleForegroundChange);
    app.removeListener('browser-window-focus', scheduleForegroundChange);
    unwatchWindowFocus = null;
  };
}

/**
 * Guards the env diagnostic against concurrent invokes (story 108's fix
 * round).
 *
 * Every invoke spawns a full interactive login shell that executes the
 * user's rc file, held up to 5s with 512 KiB of buffering — the same shape
 * of cost the pty spawn path caps with `maxSessions`
 * (`pty-host/session-manager.ts`), and this channel had no equivalent cap.
 * The renderer already disables its button while a probe is in flight
 * (`envDiagnosticPending` in `runtime-section.tsx`), but that is renderer
 * state and story 082's posture is that the renderer is untrusted input — a
 * compromised or merely buggy renderer must not be able to multiply this
 * into unbounded concurrent rc-file executions.
 *
 * **Refuses rather than shares the in-flight probe.** Sharing looked
 * simpler at first — return the same promise to every caller while one is
 * running — but the two concurrent requests are not necessarily for the
 * same project: a renderer that fired one probe for project A and, before it
 * resolved, another for project B would get project A's verdict back
 * labelled as an answer to its second call. Refusing with a clear `error`
 * (the exact shape a failed probe already uses) never risks handing back the
 * wrong project's environment.
 */
let envDiagnosticInFlight = false;

/** The live sessions layer, or `null` before registration. Test-only reach-in. */
export function sessionsLayer(): Sessions | null {
  return sessions;
}

export function registerIpcHandlers(): void {
  const supervisor = registerPtyHost();

  /**
   * One window by design (story 000), so a broadcast reaches exactly the
   * renderer that owns every session. Resolved per send rather than captured:
   * the window is created after this runs, and on macOS it can be closed and
   * re-created while the app keeps running.
   */
  const send = (channel: string, payload: unknown): void => {
    // Story 106 taps the broadcast here rather than at each source, so an event
    // class added later cannot forget to notify. `observe` never throws — a
    // failed notification must not cost a `pty:data`.
    notifier.observe(channel, payload);

    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send(channel, payload);
    }
  };

  /**
   * OS notifications (story 106).
   *
   * Mutually recursive with `send` — `send` taps the notifier, and the
   * notifier's `activate` broadcasts through `send`. Both references resolve at
   * call time and nothing broadcasts during registration, so the ordering here
   * is a declaration detail rather than a cycle.
   */
  /**
   * What the rail calls each session (HIVE-110). Read by the hub when it
   * presents a toast; the inbox row needs none of it. See `notifications/names.ts`.
   */
  const sessionNames = createSessionNames();

  const hub = createNotificationHub({
    prefs: () => getConfig().notifications,
    present: ({ title, body, onClick }) => {
      // False on a Linux box with no notification daemon. Checked per send
      // rather than once at boot: the daemon can arrive or go away while the
      // app is running, and constructing one when unsupported throws.
      if (!Notification.isSupported()) return;

      const notification = new Notification({ title, body });
      notification.on('click', onClick);
      /**
       * The failure that was being thrown away.
       *
       * `show()` is fire-and-forget and its refusal arrives here, on an event
       * nothing was listening to. Measured on macOS 15 / Electron 43.2.0:
       * `isSupported()` returns `true`, this event fires with `UNErrorDomain
       * error 1` — not authorized — and the app carried on reporting desktop
       * delivery as available. Every "System" notification since has been
       * dropped in silence.
       *
       * Recorded rather than merely logged, because the honest place for it is
       * the settings pane that offers the switch. Logged once per distinct
       * reason so a fleet of blocked sessions cannot fill a terminal with the
       * same line.
       */
      notification.on('failed', (_event, error) => {
        const reason = String(error);
        if (systemNotificationRefusal === reason) return;
        systemNotificationRefusal = reason;
        console.error(
          `[hive] the OS refused a desktop notification — the inbox still has it (${reason})`,
        );
      });
      notification.show();

      /**
       * The dock is what still works when the OS says no.
       *
       * Measured on the same machine that refuses notifications outright:
       * `app.dock.bounce('critical')` and `setBadge` both succeed, because
       * neither needs notification authorization. So the app is not out of ways
       * to reach someone in another window — it was only using the one that was
       * being rejected.
       *
       * Unconditional rather than only on a recorded refusal. A bounce is what
       * `both` already means — *interrupt me* — and gating it on a failure
       * would make the first interruption of every launch the one that gets
       * lost, since the refusal is not known until a send has already failed.
       * `dock` is undefined off macOS, where the badge and bounce have no
       * equivalent and the toast is expected to work.
       *
       * **`informational`, not `critical`.** `critical` maps to
       * `NSCriticalRequest`, which bounces *until the app is activated* — and
       * nothing here ever calls `cancelBounce`. A fleet left overnight would
       * start bouncing at the first session to go quiet and not stop until
       * somebody came back to it, which is not an interruption, it is a fault
       * light. `informational` bounces once, which is the whole of what a
       * notification is entitled to; the **badge** is the part that persists,
       * and it persists honestly because it is a count rather than an alarm.
       */
      app.dock?.bounce('informational');
    },
    /**
     * Straight to the renderer, not through `send` (HIVE-75).
     *
     * `send` taps the notifier, and the notifier produces into the hub — so
     * broadcasting a notification through it would feed the hub's own output
     * back into its input. `observe` ignores the channel, so nothing would
     * actually loop today, but the cycle would be one `if` away from existing
     * and nobody would see it coming.
     */
    broadcast: (notification) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue;
        window.webContents.send(CH.notificationsNew, notification);
      }
    },
    announceRead: (id, unread) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue;
        window.webContents.send(CH.notificationsRead, {
          id,
          unread,
        } satisfies NotificationReadEvent);
      }
    },
    announceDismissed: (id) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue;
        window.webContents.send(CH.notificationsDismissed, {
          id,
        } satisfies NotificationDismissedEvent);
      }
    },
    /**
     * The count on the dock icon.
     *
     * Empty string, not `'0'`, clears it — that is Electron's API, and a badge
     * reading `0` is a worse lie than no badge, because it says the app has
     * something to report and the something is nothing.
     *
     * Off macOS `app.dock` is undefined and this is a no-op. Windows has a
     * taskbar overlay that would serve the same purpose and needs an icon
     * rather than a string, so it is left for whoever ships a Windows build
     * rather than approximated here.
     */
    announceUnread: (count) => {
      app.dock?.setBadge(count > 0 ? String(count) : '');
    },
    activate: (action) => {
      /**
       * Main focuses the window; the renderer opens the session.
       *
       * Split that way because only main can raise a window and only the
       * renderer knows what opening a session means — and a minimised window
       * has to be restored first, or focusing it does nothing visible.
       */
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue;
        if (window.isMinimized()) window.restore();
        window.focus();
      }

      /**
       * A `url` action goes to the user's browser, through the same allowlist
       * every other outbound link uses (story 081).
       *
       * `isSafeExternalUrl` is not optional politeness here: `shell.openExternal`
       * will happily launch a `file:` URL or a custom scheme registered by some
       * other application, and a notification's URL is data rather than a
       * constant. A `none` action has nowhere to go and is satisfied by the
       * focus above.
       */
      if (action.type === 'url') {
        if (isSafeExternalUrl(action.url)) void shell.openExternal(action.url);
        return;
      }

      /**
       * The update actions carry no data at all, which is what makes them safe
       * to accept from a renderer without validating anything beyond the tag.
       * The updater already holds the version it found; these say only "do the
       * thing you offered", and a stale row clicked after the updater has moved
       * on is answered by whatever the updater's state actually is now.
       */
      if (action.type === 'update.download') {
        void downloadUpdate();
        return;
      }

      if (action.type === 'update.install') {
        void installUpdate();
        return;
      }

      /**
       * An `ask` answers nothing from here (HIVE-118) — it *reveals* the card.
       *
       * A desktop toast is a title, a body and one click; there is no room on
       * it for the options an ask card offers, so the only honest thing a
       * click on one can do is bring the user to where the card lives. That is
       * the whole reason an ask toast, alone among the kinds, does **not**
       * dismiss its row on click.
       *
       * The focus loop above is not enough to keep that promise. It restores
       * and focuses the window and stops there, and the card lives on one of
       * three right-rail tabs on a rail the user can collapse. A user sitting
       * on `explorer` clicked a question and got a file tree — the window
       * forward, and no card and no signal anywhere on it.
       *
       * Main cannot fix that itself: only the renderer may touch the rail. So
       * this says *what happened* and lets the other side decide where that
       * goes, the same split `session` and `agent` already use.
       */
      if (action.type === 'ask') {
        send(CH.notificationsActivate, {
          type: 'ask',
        } satisfies NotificationActivateEvent);
        return;
      }

      /**
       * An `agent` reaches the renderer exactly the way `session` does
       * (HIVE-118): same channel, same event shape, because only the renderer
       * knows what "open" means for either kind of row.
       *
       * `entityId` still means *terminal id* for a session — the reason
       * `useNotificationActivate` on the other end resolves it through
       * `currentRowFor`. An agent has no terminal, so there is no resolution
       * to apply here — but sending its name through unchanged is **not**
       * always the identity function on the other side: `hydrateAgents`
       * documents that an agent's name is a legal session id, so an agent can
       * come to share a name with some session's `terminalId`, and
       * `currentRowFor`'s search loop would then resolve straight past the
       * agent to that session. The renderer is what closes this — it checks
       * `isAgentId` before ever calling `currentRowFor`, so what this sends is
       * still what gets opened even on a colliding name.
       */
      if (action.type === 'agent') {
        send(CH.notificationsActivate, {
          type: 'entity',
          entityId: action.name,
        } satisfies NotificationActivateEvent);
        return;
      }

      if (action.type !== 'session') return;

      send(CH.notificationsActivate, {
        type: 'entity',
        entityId: action.entityId,
      } satisfies NotificationActivateEvent);
    },
    now: () => Date.now(),
    isForeground: (action) =>
      action.type === 'session' && isForeground(action.entityId),
    subjectName: (terminalId) => sessionNames.get(terminalId),
  });

  const notifier = createNotifier({ hub, isForeground });

  /**
   * Ledger entries into inbox cards (HIVE-118).
   *
   * Constructed here, alongside the hub, rather than down at `ledger.onChange`
   * — the ledger itself does not exist yet at this point in registration, but
   * the notifier needs none of it: it is pure policy over an entry, called
   * from inside the one listener below.
   *
   * `isAgent` reads `knownAgents`, the same cache `agents:list` fills and
   * `knowsParty` already consults a few lines below — a party id names an
   * agent if that cache has it, and nothing here keeps a second opinion about
   * who is an agent.
   */
  const notifyLedgerEntry = createLedgerNotifier({
    raise: (input) => hub.raise(input),
    markRead: (id) => hub.markRead(id),
    dismiss: (id) => hub.dismiss(id),
    isAgent: (id) => knownAgents.has(id),
  });

  // The re-arm (HIVE-81): whatever is still blocked when the user looks away
  // gets its row promoted back to unread. Through the exported subscriber
  // rather than the set it wraps — one way in, so the set stays private and
  // the function tests reach is the one production runs.
  onForegroundChange(() => {
    notifier.reevaluateForeground();
  });

  // The other half of the same signal: OS window focus, which no renderer can
  // report because a hidden window has stopped running. See
  // `scheduleForegroundChange`.
  watchWindowFocus();

  /**
   * Two property reads and no subprocess, which is the entire point.
   *
   * `integrationsStatus` carries the same two facts and **executes `gh`** to
   * build the rest of its answer. The Notifications pane has to re-ask this
   * while it is open — `systemNotificationRefusal` is only knowable once a
   * delivery has been attempted and turned down — and putting that on the
   * integrations handler would spawn a process every few seconds to read a
   * variable.
   */
  handle(
    CH.notificationsDelivery,
    (): NotificationDeliveryStatus => ({
      supported: Notification.isSupported(),
      refused: systemNotificationRefusal,
    }),
  );

  handle(CH.notificationsList, () => hub.list());
  handle(CH.notificationsMarkRead, (_event, payload) =>
    // Validated, never coerced — the rule every other handler in this file
    // follows. Coercing an accidental `undefined` to `null` would turn a single
    // dismissal into "mark all fifty read", silently and with no error anywhere.
    hub.markRead(parseMarkReadRequest(payload)),
  );
  // Same rule as above, one notch stricter: `parseDismissRequest` refuses
  // `null`, so a lost argument cannot be read as "drop everything".
  handle(CH.notificationsDismiss, (_event, payload) =>
    hub.dismiss(parseDismissRequest(payload)),
  );
  // No payload, so there is nothing to validate and nothing to lose on the way
  // in — which is the whole argument for this being its own verb rather than
  // `dismiss(null)`. See `CH.notificationsClear`.
  handle(CH.notificationsClear, () => {
    hub.clearInbox();
  });

  /**
   * Now the hub exists, the updater has somewhere to raise into.
   *
   * Registered here rather than in `updates/index.ts` because the hub is built
   * in this function and nothing outside it holds a reference. The updater is
   * constructed lazily and may exist before this runs; it drops notifications
   * raised into an empty sink, which can only happen in the moments before the
   * first check is even scheduled.
   */
  setUpdateNotificationSink((input) => {
    hub.raise(input);
  });

  /**
   * Route a clicked row's action, through the same `activate` a desktop toast
   * uses. `parseNotificationAction` is what keeps this from being a hole: the
   * payload is renderer-supplied, and an unrecognised shape is dropped rather
   * than passed along to a switch that might have a permissive default.
   */
  handle(CH.notificationsAct, (_event, payload) => {
    const action = parseNotificationAction(payload);
    if (action !== null) hub.activate(action);
  });

  handle(CH.updatesStatus, (): UpdateStatus => updateStatus());
  handle(CH.updatesCheck, () => checkForUpdatesInteractively());

  /**
   * The hook pipeline is constructed here and started by `createSessions`
   * (HIVE-62).
   *
   * Constructed rather than started, because starting it needs two things only
   * the session layer has: whether an entity is a live session, and where a
   * status event should go. Handing it over unstarted keeps that knowledge in
   * one place instead of duplicating a registry lookup here.
   *
   * `app.getPath('userData')` is the app's own directory. Nothing about this
   * touches `~/.claude`.
   */
  /**
   * The session history, beside `window-state.json` in the app's own directory
   * (HIVE-87).
   *
   * Constructed before the session layer because that layer takes it as an
   * option. Nothing about it touches `~/.claude` — it records what The Hive
   * knows about its own rows, not anything Claude wrote.
   */
  history = createSessionHistory(
    join(app.getPath('userData'), SESSION_HISTORY_FILE),
  );

  /**
   * The ledger lives beside the config, not in `userData` (HIVE-111).
   *
   * `~/.hive/` is the user's own directory — the one they can open, read and
   * back up. A correspondence log between their agents belongs there for the
   * same reason the config does, and `userData` belongs to the app.
   *
   * `knowsParty` closes over `sessions`, which is `null` at this point in
   * startup and assigned below — safe because the closure runs on every read
   * and write, always after registration, never at construction.
   *
   * The `history.resumable` arm is **not** what lets an ended session keep
   * writing, and today nothing reaches it. Every out-of-process caller arrives
   * through the receiver, whose `reject()` answers `404` off the *live* pty
   * registry before `knowsParty` is ever consulted — so an ended session's
   * writes are already refused a layer earlier, and the only caller that gets
   * this far is the overmind over IPC. What the arm does is state the rule
   * this predicate is meant to hold: a party is an *identity*, not a process,
   * so if the gate in front of it is ever widened (a background agent posting
   * for a session that has closed, HIVE-112 onward), the ledger will not be
   * the layer that refuses.
   */
  const ledger = createLedger({
    dir: join(dirname(configPath()), LEDGER_DIR),
    knowsParty: (id) =>
      id === OVERMIND ||
      (sessions?.entities().includes(id) ?? false) ||
      /*
        The widening the comment above anticipated (HIVE-115).

        `PartyKind` has named `'agent'` since HIVE-111 and nothing could be one:
        an agent is not a pty session and never will be, so the two arms above
        refused every ledger write a run makes — including the `run.started`
        and `run.ended` entries that are the *only* durable record that a wake
        happened. A party is an identity, not a process, and this is the arm
        that finally says so.

        It is a set of names read off `~/.hive/agents`, not a pattern: a name
        that is not a folder on this machine is still refused, so the rule is
        no looser than the two above it — it is the same rule applied to a
        second register of identities.
      */
      knownAgents.has(id) ||
      history?.resumable(id) !== undefined,
  });

  /**
   * Delivery — what happens to an entry after it is written (HIVE-113).
   *
   * Lazy accessors rather than the session layer itself, for the reason
   * `knowsParty` above reaches for it through `?.`: `sessions` is a
   * module-level binding initialised *after* this point.
   *
   * `write` reports whether the line landed, and that return value is load
   * bearing rather than defensive — `deliver` records a receipt only on a
   * successful write, and a receipt for a nudge that never reached a terminal
   * would suppress the retry forever.
   */
  const deliver = createDeliver({
    ledger,
    isLive: (id) => sessions?.entities().includes(id) ?? false,
    isIdle: (id) => sessions?.isIdle(id) ?? false,
    // `Sessions.write` reports whether the bytes reached a pty — it answers
    // false for an unknown id and for a session still bootstrapping, where the
    // input is queued and may never be sent. Passed straight through, because
    // `deliver` records a receipt on the strength of it.
    write: (id, text) => sessions?.write(id, text) ?? false,
  });

  /**
   * One entry landed, from any party — pushed the way `notifications:new` is
   * (HIVE-75): straight to every window rather than through `send`, because
   * there is nothing here for a tap to loop back into.
   *
   * One subscription, three jobs (HIVE-113, HIVE-118). The renderer's mirror,
   * the terminal nudge and the inbox notifier read the same entry in the same
   * order; separate subscribers could not be made to disagree about that order
   * today, but registration order is an accident and this states it in code
   * instead — the broadcast lands first, then delivery, then the notifier.
   */
  ledger.onChange((entry) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send(CH.ledgerChanged, entry);
    }
    /**
     * Neither delivery nor the notifier may fail the write that triggered them.
     *
     * This listener runs *inside* `Ledger.append`'s own try/catch, so a throw
     * from the pty on the way to a terminal would be reported to the party who
     * appended as `500 could not write the ledger` — for an entry that is
     * already safely on disk. The console would print a red failure and the
     * user would ask again, producing a duplicate of a question that was in
     * fact recorded. The append succeeded; only the telling failed.
     */
    try {
      deliver.onEntry(entry);
    } catch (cause) {
      console.warn(`[ledger] could not deliver ${entry.id}:`, cause);
    }
    /*
      The third and fourth consumers, sequenced against each other (HIVE-120,
      HIVE-119): an entry addressed to an agent is a wake, and an answer to a
      permission ask is also a grant that has to reach `AGENT.md` before that
      same wake reads the file.

      Every other entry — including an ordinary answer — schedules
      synchronously, exactly as `deliver` above did: there is nothing to write
      first, because an ordinary answer is only ever news arriving. A
      *permission* answer is the one exception, and the exception is
      load-bearing: `onAnswer` may still be writing the granted rule into
      `AGENT.md` when the wake it triggers would otherwise read that same
      file — race it, and a user's "allow for this agent" click retries into
      a second denial. It does not fail every time, because the write is
      fast; that is exactly what makes it easy to ship and hard to notice.
      `permissions.isPermissionAnswer` is what tells the two cases apart, so
      only the answer with a dependency waits for it. Reversing the order
      here — scheduling before the grant is written — silently breaks
      Allow-for-this-agent, and nothing in the types stops it; the live
      conformance suite's fence scenario (HIVE-119) is what would catch it.

      Both keep their own try/catch, for the same reason `deliver` above is
      guarded: a throw here runs inside `Ledger.append`'s own call stack and
      must not be reported to the party who appended, for an entry already
      safely on disk. `.finally`, not `.then`, on the permission path: a
      grant that failed to write must still wake the agent, so it can retry,
      be denied again, and report — not be stranded with no wake at all.
      `permissions` is read through the module binding rather than closed
      over, exactly as `scheduler` is: both are armed later, once `agents`
      and `ledger` exist, not at the point this listener is wired.
    */
    const schedule = () => {
      try {
        scheduler?.onEntry(entry);
      } catch (cause) {
        console.warn(`[ledger] could not schedule ${entry.id}:`, cause);
      }
    };

    if (entry.kind === 'answer' && permissions?.isPermissionAnswer(entry) === true) {
      permissions
        .onAnswer(entry)
        .catch((cause: unknown) => {
          console.warn(`[ledger] could not grant on ${entry.id}:`, cause);
        })
        .finally(schedule);
    } else {
      schedule();
    }
    try {
      notifyLedgerEntry(entry);
    } catch (cause) {
      console.warn(`[ledger] could not notify on ${entry.id}:`, cause);
    }
  });

  handle(CH.ledgerList, (_event, payload) => ledger.read(parseLedgerReadQuery(payload)));
  handle(CH.ledgerPost, (_event, payload) =>
    /*
      `from` is supplied here, never taken from the renderer — the same rule
      the receiver enforces with the session header. The renderer is the
      overmind's only mouth.
    */
    ledger.append({ ...parseLedgerPostBody(payload), from: OVERMIND }),
  );
  handle(CH.ledgerAnswer, (_event, payload) =>
    ledger.answer(parseLedgerAnswerRequest(payload), OVERMIND),
  );

  /*
    Constructed before the session layer, which takes it as an option and syncs
    it on every spawn (HIVE-96). `app.getVersion()` is read here rather than
    inside the runtime so that module's tests can run under plain Node — the
    same reason `userDataPath` is passed in rather than resolved there.
  */
  /*
    Hoisted out of the `createSessions` call it used to be an argument to,
    because the skills runtime now reads one value off it (HIVE-93). The two
    stay independent — `doneUrl` is passed as a getter, not as the runtime —
    and this is the only line where they meet.
  */
  const hooks = createHookRuntime({
    userDataPath: app.getPath('userData'),
    // Read per call, so a config reload is picked up (HIVE-79).
    sessionMetrics: () => getConfig().sessionMetrics,
    ledger,
  });

  skills = createSkillsRuntime({
    userDataPath: app.getPath('userData'),
    version: app.getVersion(),
    /*
      Read at every regeneration rather than captured here: this runs before the
      receiver has bound, so a value read now would be `null` for the life of the
      app. `sync()` happens before every spawn, which is always afterwards.
    */
    doneUrl: () => hooks.doneUrl(),
  });

  /*
    HIVE-115. `agents.json` is opened a few dozen lines below, which is why the
    state is reached through a closure rather than handed over as a value: a
    delete or a rename can only happen once the app is up, by which time
    `agentState` is set.
  */
  agents = createAgentsRuntime({
    runFiles: createAgentRunFiles({
      state: () => agentState,
      workdir: agentWorkdir,
    }),
  });
  /*
    The same non-nullable alias `agentRunState` is, and for the same reason:
    `permissions` is composed well below this line and reads it from inside a
    closure, where TypeScript widens a captured `let` back to its declared
    type regardless of what was just assigned. `agents` is unconditionally set
    the line above, so the value this captures can never actually be `null`.
  */
  const agentRegistry = agents;

  /*
    The folder changed — on disk, or through the pane. Broadcast to every live
    window the way `ledger.onChange` above does, and with no payload: the
    renderer re-`list`s, which keeps this push incapable of carrying anything
    `agents:list` would not already return.
  */
  agents.onChange(() => {
    refreshKnownAgents();

    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send(CH.agentsChanged);
    }
  });

  refreshKnownAgents();

  /*
    The MCP config runtime (HIVE-112). Written once, its content depends only
    on where the app is installed and where its own bundle sits, and neither
    moves while the app runs.

    `import.meta.dirname` is `out/main/` in both dev and a packaged build, which
    is where `mcp-host.js` is emitted — the same resolution `pty-host` uses.

    Fired here, unawaited, so a slow write cannot delay the first window — the
    same reasoning `startLoginEnvImport` gives in `main/index.ts`. That leaves
    a window between construction and the write settling in which
    `configPathFor()` reads `null`; the `ptySpawn` and `ptyRestart` handlers
    close it by `await`-ing the same memoised promise (`mcp.start()`) before a
    session can be spawned, exactly as they already `await loginEnvStatus()`.
  */
  const mcp = createMcpRuntime({
    userDataPath: app.getPath('userData'),
    execPath: process.execPath,
    scriptPath: join(import.meta.dirname, 'mcp-host.js'),
  });
  void mcp.start();

  /**
   * The agent runtime (HIVE-115) — where the six modules under
   * `main/agents/` finally meet something real.
   *
   * It is composed here rather than inside `createAgentsRuntime()` because
   * every dependency it needs belongs to a *different* layer of this file:
   * the hook settings path and the hook environment come from `hooks`, the
   * `--mcp-config` path from `mcp`, the ledger from `ledger`, the binary from
   * `getConfig()`, and the pushes from `send`. A composition root is exactly
   * the place that is allowed to know all of them at once; `agents/index.ts`
   * is not, and would have had to grow five constructor arguments to become
   * one.
   *
   * The ordering is load-bearing in one place only: `mcp` is constructed a few
   * lines above, and this reads its path through a getter rather than a value,
   * because the config is written asynchronously and `configPathFor()` answers
   * `null` until it lands. The `agents:run` handler closes that window the same
   * way `ptySpawn` does — by `await`-ing the memoised `mcp.start()`.
   */
  agentState = createAgentState({ path: agentStateFile() });
  /*
    The same object under a non-nullable name, for the two composition sites
    below that need it as a value rather than as a maybe. The module binding
    stays because handlers registered here run long after this function has
    returned; a `const` is what lets the scheduler take it without a guard that
    could only ever be false.
  */
  const agentRunState = agentState;

  /*
    One generator, two readers. `createWakeCommand` mints the uuid a *first*
    wake starts under; `createRunTracker` mints the one a rotation's next
    session will start under. A second function here would be a second place to
    change if uuids ever stop being `randomUUID()`.
  */
  const newUuid = (): string => randomUUID();

  const buildWakeCommand = createWakeCommand({
    agentsRoot,
    workdir: agentWorkdir,
    promptFile: (name) => agentPromptFile(app.getPath('userData'), name),
    pluginDir: () => join(app.getPath('userData'), PLUGIN_DIR),
    // The agent-space file, never `hooks.settingsPathFor()`: that one carries
    // no `permissions.ask` rule, and a wake started against it would run with
    // no fence at all (HIVE-119).
    agentSettingsPath: () => hooks.agentSettingsPathFor(),
    mcpConfig: () => mcp.configPathFor(),
    hookEnv: (name) => hooks.envFor(name),
    // Read per wake, not captured: a `claudeCommand` edited in Settings must
    // reach the next run without a restart. There is no per-project override
    // to resolve — an agent belongs to no project.
    claudeCommand: () => getConfig().claudeCommand,
    subscriptionAuth: () => getConfig().subscriptionAuth,
    state: agentState,
    env: () => process.env,
    newUuid,
    // `permissions` is armed later, alongside `scheduler` — read through the
    // module binding for the same reason `hooks`/`mcp` are read through
    // getters here rather than closed over as values.
    pendingGrants: (name) => permissions?.grantsFor(name) ?? [],
  });

  /**
   * Did this run leave a question nobody has answered?
   *
   * Read from the **ledger**, which is the design's own instruction: an ask
   * posted through any path counts, and one already answered does not. The run
   * is identified by its own `run.started` entry — appended by the tracker with
   * `meta.run`, and always the first entry carrying that id — so "during this
   * run" becomes an id comparison rather than a clock comparison. Ledger ids
   * sort in write order by construction.
   *
   * Falling back to *any* open ask from this agent when no start entry is found
   * is the safer error: it can only ever mark a run `asking` that was in fact
   * `done`, which parks an agent that would otherwise be woken again — where
   * the opposite mistake would report a question as finished business and
   * silently drop it.
   */
  const openAsksFor = (name: string, run: string): boolean => {
    const { entries, openAsks } = ledger.read({ from: name });
    const started = entries.find(
      (entry) => entry.kind === 'event' && entry.meta?.['run'] === run,
    );

    return openAsks.some(
      (ask) =>
        ask.from === name && (started === undefined || ask.id >= started.id),
    );
  };

  /**
   * What did this run hand over, if anything (HIVE-122)?
   *
   * The same `run.started` id comparison `openAsksFor` uses, for the same
   * reason: the ledger has no notion of which run an entry belongs to, and a
   * clock comparison would be a worse answer to the same question. The **last**
   * handoff wins if the agent wrote several — a second one is a correction of
   * the first, not a competitor to it.
   *
   * Where the two part company is the missing-start-entry case, and they part
   * deliberately: `openAsksFor` fails **open** because its worst error parks an
   * agent that was in fact done, while this one must fail **closed** because
   * its worst error is destructive. Without the guard the predicate collapses
   * to "any handoff this agent ever wrote", so `findLast` returns a *previous*
   * rotation's body — and `finalizeRun` reads that as a successful handover:
   * it zeroes the counter, parks a `pendingSession`, and seeds the next
   * session from an out-of-date summary while abandoning the live
   * conversation. No handoff is the honest answer when we cannot tell which
   * run wrote one; the close then takes a strike, which is recoverable.
   */
  const handoffFor = (name: string, run: string): string | undefined => {
    const { entries } = ledger.read({ from: name });
    const started = entries.find(
      (entry) => entry.kind === 'event' && entry.meta?.['run'] === run,
    );

    if (started === undefined) return undefined;

    return entries.findLast(
      (entry) => entry.kind === 'handoff' && entry.id >= started.id,
    )?.body;
  };

  /**
   * One agent's row changed. Pushed through `send`, so the notifier tap and the
   * destroyed-window guard apply here exactly as they do to a `pty:data`.
   *
   * Built from `agents.json` rather than from arguments: the tracker calls this
   * *after* it has written the state, so reading the file back is what keeps
   * the push and the next `agents:list` from being able to disagree.
   */
  const pushAgentStatus = (name: string): void => {
    const state = agentState?.read(name);

    if (state === undefined) return;

    const last = state.runs[state.runs.length - 1];
    const cost = formatRunCost(last?.costUsd);

    send(CH.agentsStatus, {
      name,
      status: state.status,
      ...(state.lastRunAt === undefined ? {} : { lastRunAt: state.lastRunAt }),
      ...(state.nextRunAt === undefined ? {} : { nextRunAt: state.nextRunAt }),
      /*
        The history rides along (HIVE-116). The view's `Today` tile is a count
        and a sum over the day's runs, and it has to move the moment a run
        closes — the alternative was an `agents:changed` on every close, which
        re-reads and re-parses every definition on disk to learn one number
        this function already has in hand.
      */
      runs: state.runs,
      runsSinceRotate: state.runsSinceRotate,
      ...(state.sessionUuid === undefined ? {} : { sessionUuid: state.sessionUuid }),
      /*
        And the two numbers `runs` cannot answer (HIVE-121): the day's totals,
        which outlive the twenty-run history, and the skip count, which counts
        wakes that deliberately produced no run at all.
      */
      ...(state.today === undefined ? {} : { today: state.today }),
      ...(state.skipsSinceRun === undefined
        ? {}
        : { skipsSinceRun: state.skipsSinceRun }),
      ...(cost === undefined ? {} : { cost }),
    } satisfies AgentStatusPush);
  };

  runs = createRunTracker({
    /*
      `spawn` is injected rather than imported by `runs.ts`, which is what lets
      that module's tests drive a recording fake without a real process. The
      cast is the one place the real signature meets the structural one:
      `ChildProcess.stdout` is `Readable | null`, and it is `null` only for a
      stdio mode this call does not use — `runs.ts` passes
      `['ignore', 'pipe', 'pipe']`, which is what makes both pipes non-null.
    */
    spawn: (file, args, options) =>
      spawn(file, [...args], options as SpawnOptions) as unknown as ChildLike,
    /*
      Handed straight through. The tracker passes the trigger it was called
      with, so the wake prompt and the `run.started` ledger entry are spelled
      from one value rather than from two that could disagree.
    */
    command: (name, trigger, extra) => {
      const built = buildWakeCommand(name, trigger, extra);

      /*
        Proof of existence, taken at the strongest moment there is. Building a
        command meant reading this agent's definition off main's own disk, so
        the ledger may accept it as a party — which it must, or the
        `run.started` entry on the very next line is refused 404 and the log
        has no record that this run ever happened.
      */
      if (!('problem' in built)) knownAgents.add(name);

      return built;
    },
    state: agentState,
    /*
      A run's own entries are `from` the **agent**: a run is the agent's
      activity and the log is read back by name. That is the same rule
      `ledger:post` enforces from the other direction, where the renderer may
      only ever speak as the coordinator.

      The one exception is main's own verdict — the failed-rotation event
      (HIVE-122), which is `from` the overmind precisely because it is a claim
      *about* the agent that the agent must not be able to make about itself.
      The tracker picks the `from`; this only carries it.
    */
    appendLedger: (entry) => {
      const result = ledger.append(entry);

      /*
        Logged, never discarded. The only way this refuses is a party rule —
        an agent whose name is no longer in `knownAgents` — and the entry it
        drops is a `run.started` or a `run.ended`, so the symptom is a log with
        a beginning and no end and no visible cause. Loud here is cheap;
        silence here costs whoever reads that log an afternoon.
      */
      if (!result.ok) {
        console.warn(
          `[hive] ledger refused ${entry.body} for ${entry.from} (${result.status}):`,
          result.reason,
        );
      }
    },
    openAsksFor,
    handoffFor,
    newUuid,
    pushStatus: pushAgentStatus,
    pushLines: (name, lines) => {
      /*
        Sent as they are folded, with no second layer of batching.

        `pty:data` batches because a pty emits bytes at keystroke granularity
        and thirteen of them can be live at once. This is one headless process
        writing whole `stream-json` events, and `foldRunLog` has already
        collapsed each one into at most a few lines — so a batching timer here
        would add latency and a shutdown-flush obligation to buy nothing.
      */
      send(CH.agentsLines, { name, lines } satisfies AgentLinesPush);
    },
    /*
      The queue's other end (HIVE-120). Reached through the binding because the
      scheduler is built from `runs`, three lines below — and it must be told
      *after* the status is written, which is where `finalizeRun` calls this.
    */
    onRunClosed: (name) => scheduler?.onRunClosed(name),
    now: () => Date.now(),
    newRunId: () => randomUUID(),
  });

  /**
   * Ledger-addressed wakes (HIVE-120).
   *
   * Built after the tracker because it drives it, and handed `knownAgents` —
   * the same register the ledger authenticates a party against and the notifier
   * asks about — rather than a second opinion on who is an agent.
   *
   * `run` goes to the tracker rather than the waker deliberately: that method
   * is the one door every trigger passes through, and it is where a paused
   * agent is refused. A wake reaching the command builder directly would let a
   * ledger entry start an agent the user had just stopped.
   */
  scheduler = createScheduler({
    run: (name, trigger, extra) =>
      runs?.run(name, trigger, extra) ?? { started: false },
    state: agentRunState,
    isAgent: (id) => knownAgents.has(id),
    wakesOnLedger: (id) => ledgerAgents.has(id),
    /*
      The schedule, from the cache the folder watcher rebuilds (HIVE-121).

      Not `agents.list()`: that is a promise which re-reads and re-parses every
      definition on disk, and the tick is synchronous and runs every sixty
      seconds. `agentSchedules` is refreshed by the same pass that maintains
      `knownAgents`, so an edit in Settings or in a text editor reaches the
      scheduler by the same route it already reaches the party register.

      An agent missing from the map once the listing *has* resolved is one with
      no usable definition — a file that stopped parsing mid-edit — and takes
      no scheduled wake. Before it resolves the answer is `undefined`, which
      the tick reads as "ask me again", not as "nobody is scheduled": the two
      are indistinguishable in an empty map and only one of them licenses
      clearing a `nextRunAt`.
    */
    schedules: () => (agentsListed ? agentSchedules : undefined),
    /*
      The same push `RunTracker` uses. The tick changes rows with no run
      attached — a new `nextRunAt`, a skip, a day that hit its ceiling — and
      those are the changes a person watching the row is waiting to see.
    */
    pushStatus: pushAgentStatus,
    ledger: {
      // The whole log, unfiltered: `expiredAsks` needs the closing entries and
      // the expiry events as well as the asks to decide which asks are new.
      read: () => ledger.read({}),
      append: (request) => ledger.append(request),
    },
    now: () => Date.now(),
  });

  /**
   * Answers become grants (HIVE-119).
   *
   * Composed here, next to `scheduler`, not up where `ledger` and `agents`
   * first came into scope. Both are ready well before this point — the
   * ordering constraint isn't about *availability*, it's about matching the
   * one other place in this file that arms something off `ledger.onChange`:
   * `scheduler` is armed here too, so a reader looking for "what fires on a
   * ledger entry" finds both in one place, rather than one at construction
   * and one fifty lines earlier.
   *
   * `entries`/`append` mirror the shape handed to the scheduler's own ledger
   * dep just above; `read`/`write` are the registry's, unmodified — its
   * `AgentRegistry.read`/`write` already match `PermissionDeps` exactly.
   */
  permissions = createPermissions({
    entries: () => ledger.read({}).entries,
    append: (request) => {
      ledger.append(request);
    },
    read: (name) => agentRegistry.read(name),
    write: (name, source) => agentRegistry.write(name, source),
  });

  /*
    Started behind `mcp.start()`, not beside it.

    `start()` flushes whatever a crash left queued, and a wake needs an argv —
    which `buildWakeCommand` refuses to build until the MCP config file is on
    disk, because an agent reads its inbox before anything else. That write is
    in flight from the `void mcp.start()` above, so arming this synchronously
    would put every restored queue through a refusal at the one moment it is
    guaranteed to happen. The call is memoised, so this awaits the same write
    rather than starting a second one.

    A failure still arms the sweep: expiry does not spawn anything, and a queue
    that cannot flush yet is safer standing than dropped.
  */
  void mcp
    .start()
    .catch(() => {
      // Reported where it happens; a wake that cannot be built refuses itself.
    })
    .finally(() => {
      scheduler?.start();
    });

  sessions = createSessions({
    supervisor,
    config: getConfig,
    send,
    skills,
    mcp,
    hooks,
    history,
    /*
      The two moments a held nudge can finally be written (HIVE-113): a prompt
      coming free mid-life, and a session coming back at all.
    */
    onIdle: (entityId) => deliver.onIdle(entityId),
    onReady: (entityId) => deliver.onReady(entityId),
    /*
      The same register the ledger authenticates a party against (HIVE-115),
      and deliberately not a second one: an agent that may write to the log is
      exactly an agent whose hooks the receiver should answer, and two lists
      that could disagree about that would be a bug nobody sees until one of
      them is stale. Passed as the live set rather than a copy, so a name
      `refreshKnownAgents` or `command()` adds is visible on the next hook
      without anything re-registering.
    */
    agentNames: () => knownAgents,
    /*
      The uuid is forwarded, not dropped: `noteTurnEnded` ignores a `Stop`
      whose uuid does not match the run it is holding, which is what keeps a
      late Stop from arming the watchdog on the next run under the same name.
    */
    onAgentTurnEnded: (name, sessionUuid) => runs?.noteTurnEnded(name, sessionUuid),
  });

  /**
   * The explorer may follow a session into a worktree kept outside the mapped
   * project — but only on main's own observation of where that session is.
   *
   * Injected rather than imported, because `fs/` must not depend on
   * `sessions/`: the session layer already reaches the filesystem, so the
   * import would close a cycle. `fs/session-roots.ts` holds the rules that make
   * the widened root safe; this only supplies the fact.
   */
  setSessionCwdLookup((entityId) => sessions?.observedCwd(entityId));

  cloneFlow = createCloneFlow({
    sessions,
    emit: (event) => send(CH.configCloneDone, event),
  });

  /**
   * The project watcher, constructed here for the same reason the clone flow
   * is: it needs `send`, and `send` resolves windows per call rather than
   * capturing one. A watcher holding a stale `webContents` would emit into a
   * destroyed renderer after a window reload.
   */
  fsWatch = createFsWatchLayer((event: FsChangedEvent) =>
    send(CH.fsChanged, event),
  );

  /**
   * Drop this layer's timers on quit.
   *
   * The *processes* are not killed here, and that is deliberate rather than an
   * omission: `pty-host/index.ts` already registers a hook that asks the host to
   * hang up every session's process group, waits, and force-kills what is left
   * — including descendants job control moved into their own groups (HIVE-72).
   * Signalling them twice from two hooks would race, and the second
   * kill would target pids that no longer exist. This hook exists so that the
   * batching and debounce timers cannot outlive the app and hold `before-quit`
   * open after the processes are already gone.
   */
  onShutdown(() => {
    sessions?.dispose();
    /**
     * A clone in flight when the app quits is the likeliest way to strand a
     * half-clone: `git` cleans up after its own failures, but not after the
     * process tree is torn down underneath it.
     */
    cloneFlow?.dispose();
    /**
     * The watcher holds an `FSEvents` stream and a pending debounce timer, and
     * this hook exists precisely so neither outlives the app. `resetIpcHandlers`
     * disposes it too, but that is the test path — leaving it out here meant
     * only production leaked.
     */
    fsWatch?.dispose();
    /**
     * A best-effort flush of anything still inside the debounce (HIVE-87).
     *
     * **Correctness does not depend on this running, and it must not.**
     * `runShutdown` invokes every hook body synchronously and then awaits them
     * together, so this races the pty teardown above rather than following it;
     * and a crash, a SIGKILL or a power cut runs no hook at all. Every fact
     * worth keeping was already written at the moment it was known — this only
     * saves the last few hundred milliseconds of a quiet quit.
     */
    history?.flush();
    /**
     * Agent runs, which — unlike the ptys above — nothing else signals.
     *
     * `pty-host/index.ts` owns the teardown of every *session's* process group,
     * which is why this hook deliberately does not touch those. A headless
     * agent is not in that registry: it was spawned from this process with
     * `child_process.spawn`, and if nobody kills it here it outlives the app
     * that started it, still writing to a ledger nobody is reading.
     *
     * `closeAll` rather than `killAll`, because this hook is synchronous and
     * the run's own finalizer is not reachable from it. A run closes on the
     * child's `'close'` event, which cannot arrive before this process is
     * gone — so signalling alone would leave `agents.json` saying `working`
     * about a process that no longer exists, a `run.started` with no matching
     * `run.ended` in the log forever, no summary in `runs[]`, and a
     * `runsSinceRotate` that under-counts until session rotation drifts.
     * `closeAll` records each live run `failed (app-closed)` on the spot, which
     * is what `flush()` on the next line then writes. Their `sessionUuid` is
     * untouched, so the next wake resumes the conversation.
     */
    /*
      Before `closeAll`, and that order is the whole point (HIVE-120).

      `closeAll` finalizes each live run synchronously, and `finalizeRun` ends by
      telling the scheduler the run closed — which would flush that agent's queue
      into a brand-new `claude`, spawned after `closeAll` had finished iterating
      the runs it knew about. Nothing would be left to signal it: the exact
      orphan this hook exists to prevent.
    */
    scheduler?.stop();
    runs?.closeAll('app-closed');
    agentState?.flush();
  });

  /**
   * The fleet as it was when the app last closed (HIVE-87).
   *
   * Answers from memory rather than re-reading the file: the history loaded it
   * at construction and is the only thing that writes to it, so a second read
   * could only ever return something staler than what is already held.
   *
   * `?? []` is not a fallback so much as the browser-shaped case in main's
   * clothing — a renderer that asks before registration completed gets "no
   * history", which is exactly what it would get from an empty file.
   */
  handle(CH.sessionHistory, (): SessionHistoryEntry[] => {
    /**
     * Marked live against the registry, not against `startedThisRun`
     * (HIVE-88).
     *
     * The renderer asking may not be the first of this run: on macOS the
     * window closes and the app lives on, and a reload or a renderer crash
     * gives the same fresh store in front of the same running ptys. The
     * history holds those sessions as `working` — true, and exactly the
     * problem — so the renderer would restore them as last run's fleet and
     * their own hooks would then prove otherwise. The registry is the one
     * authority on "has a process now": a session this run began and already
     * lost is history too.
     */
    const live = new Set(sessions?.entities() ?? []);
    return (history?.all() ?? []).map((record) => {
      /*
        Both marks are computed here rather than stored, because both are only
        true of this moment (HIVE-93). `resumable` asks the history rather than
        reading `sessionUuid` off the record: a session *this run* started holds
        a uuid naming a conversation that is already open, and offering Resume
        for it would start a second `claude` against one transcript.
      */
      const marked = live.has(record.id)
        ? { ...record, live: true as const }
        : record;
      return history?.resumable(record.id) === undefined
        ? marked
        : { ...marked, resumable: true as const };
    });
  });

  /**
   * The renderer naming a ticket for a session (HIVE-87).
   *
   * Guarded like every other payload that crosses the bridge. It cannot create
   * a record — `record` merges into whatever is already there, and a note for
   * an entity main never spawned would create a row for a session that never
   * existed. Hence the `all()` check: main writes only what it already knows
   * about.
   *
   * A name on the note is **pinned by arriving** (HIVE-107). The store sends
   * one only where it renamed the row itself — the mid-session association,
   * which Claude is never told about and which therefore never comes back on
   * the title stream `readTitle` reads. So this is main's only chance to learn
   * that name, and the flag is what stops `readTitle` overwriting it a moment
   * later with the id the agent still thinks the session is called.
   */
  handle(CH.sessionNote, (_event, raw: unknown): void => {
    const request = parseSessionNoteRequest(raw);
    if (!history?.all().some((record) => record.id === request.entityId)) return;
    history.record(request.entityId, {
      ticket: request.ticket,
      ...(request.name === undefined
        ? {}
        : { name: request.name, namePinned: true }),
    });
  });

  /**
   * The renderer naming the pull request a session produced.
   *
   * The same two rules as `session:note` above, and for the same reasons: the
   * payload is guarded, and it may not *create* a record. A sweep answers about
   * every branch the user has open, including branches belonging to sessions
   * this app never ran, so without the `all()` check one poll tick could invent
   * fleet rows out of GitHub's answer.
   */
  handle(CH.sessionPr, (_event, raw: unknown): void => {
    const request = parseSessionPrRequest(raw);
    if (!history?.all().some((record) => record.id === request.entityId)) return;
    history.record(request.entityId, { pr: request.pr });
  });

  handle(CH.appInfo, (): AppInfo => {
    const { electron, chrome, node } = process.versions;
    const diagnostics = sessions?.diagnostics() ?? [];
    return {
      version: app.getVersion(),
      electron: electron ?? 'unknown',
      chrome: chrome ?? 'unknown',
      node: node ?? 'unknown',
      platform: process.platform,
      // Reported, never written to — this app logs to stdout. See `AppInfo`.
      logPath: app.getPath('logs'),
      // Omitted rather than empty when nothing has run, so the field's presence
      // means something.
      ...(diagnostics.length > 0 ? { pty: diagnostics } : {}),
    };
  });

  /**
   * The workspace config (story 090).
   *
   * Both channels take no payload, so there is no guard to run — the sender
   * check `handle` applies is the whole validation. The snapshot they return
   * is already validated: every path in it was resolved and checked in the
   * main process, and the renderer is trusted with the *verdict* precisely
   * because it was never trusted with the input.
   */
  handle(CH.configGet, (): ConfigSnapshot => getConfig());
  handle(CH.configReload, (): ConfigSnapshot => {
    /*
      A reload can repoint, add or remove a project, which changes which
      repository a directory should be measured against. `session-roots` caches
      git's answer per directory *including refusals*, so without this a project
      fixed in Settings would keep answering from the setup that caused the
      refusal for the rest of the app's life.

      Here rather than inside `reloadConfig`, so the config layer does not have
      to know that a filesystem cache exists. This handler already owns both.
    */
    forgetProbedRoots();
    return reloadConfig();
  });

  /**
   * Config mutation (story 101).
   *
   * `chooseDirectory` takes no payload, so — like `get` and `reload` — the
   * sender check `handle` applies is its whole validation. The other two carry
   * a payload, are guarded here, and are then re-validated inside `addProject`
   * from scratch: the guard proves the *shape*, main proves the *path*.
   */
  handle(CH.configChooseDirectory, async (event): Promise<string | null> => {
    /**
     * The parent window is resolved from the event rather than captured.
     *
     * There is no `mainWindow` singleton in this process, deliberately: on
     * macOS the window can be closed and re-created while the app keeps
     * running, so a held reference goes stale. `send` above resolves windows
     * per call for the same reason. `assertSender` has already proven this
     * sender is the main frame, so its window is the one that asked.
     */
    const window = BrowserWindow.fromWebContents(event.sender);
    // Destroyed between the invoke and here. Nothing to attach a sheet to, and
    // treating it as a cancelled dialog is what the caller already handles.
    if (!window) return null;

    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  handle(
    CH.configAddProject,
    (_event, payload): ConfigSnapshot => addProject(parseAddProjectRequest(payload)),
  );

  handle(
    CH.configRemoveProject,
    (_event, payload): ConfigSnapshot =>
      removeProject(parseRemoveProjectRequest(payload)),
  );

  /**
   * Managing projects (story 103).
   *
   * Same contract as story 101's mutating verbs: the guard proves the *shape*,
   * and main proves the *value*. `repointProject` re-runs the full path
   * resolution, and `reorderProjects` re-reads the file before deciding whether
   * the ordering it was handed still describes it.
   */
  handle(
    CH.configRenameProject,
    (_event, payload): ConfigSnapshot =>
      renameProject(parseRenameProjectRequest(payload)),
  );

  handle(
    CH.configRepointProject,
    (_event, payload): ConfigSnapshot =>
      repointProject(parseRepointProjectRequest(payload)),
  );

  /*
    HIVE-94's key editor. The guard proves the shape — 2–4 lowercase letters —
    and main proves the value, because whether a key is free is a fact about the
    file rather than about the payload.
  */
  handle(
    CH.configSetProjectKey,
    (_event, payload): ConfigSnapshot =>
      setProjectKey(parseSetProjectKeyRequest(payload)),
  );

  handle(
    CH.configReorderProjects,
    (_event, payload): ConfigSnapshot =>
      reorderProjects(parseReorderProjectsRequest(payload)),
  );

  /**
   * Runtime settings (story 104).
   *
   * The two mutating verbs follow every other config channel exactly — guard
   * first, verb second, fresh `ConfigSnapshot` back.
   */
  handle(
    CH.configSetRuntime,
    (_event, payload): ConfigSnapshot => setRuntime(parseSetRuntimeRequest(payload)),
  );

  handle(
    CH.configSetProjectRuntime,
    (_event, payload): ConfigSnapshot =>
      setProjectRuntime(parseSetProjectRuntimeRequest(payload)),
  );

  /**
   * The PATH diagnostic (story 104) — read-only, so no write path.
   *
   * Resolved through the *same* `effectiveRuntime` the spawn path uses, which
   * is the whole point: a diagnostic that computed its own answer would
   * eventually describe an environment no session runs in.
   *
   * An unknown id is not an error. The renderer can ask about a project that a
   * concurrent hand-edit has since removed, and answering for the top-level
   * command is more useful than throwing at a user who only pressed a button.
   */
  handle(
    CH.configDiagnoseCommand,
    async (_event, payload): Promise<CommandDiagnostic> => {
      const request = parseDiagnoseCommandRequest(payload);
      // The same wait `integrations:status` makes, for the same reason: a
      // diagnostic whose whole job is to report the `PATH` that was searched
      // must not report the one that was about to be replaced (HIVE-84).
      await loginEnvStatus();
      const snapshot = getConfig();
      const project =
        request.id === undefined
          ? null
          : (snapshot.projects.find((entry) => entry.id === request.id) ?? null);

      return diagnoseCommand(
        effectiveRuntime(snapshot, project),
        project?.id ?? null,
      );
    },
  );

  /**
   * The environment diagnostic (story 108) — read-only, so no write path.
   *
   * Resolved through the same `effectiveRuntime` as `configDiagnoseCommand`,
   * for the identical reason: the shell probed must be the shell that
   * project's sessions would actually spawn, or the diagnostic answers for an
   * environment nobody is running in. An unknown id falls back to the
   * top-level env rather than throwing, matching `configDiagnoseCommand`.
   *
   * **`cwd`** (story 108's second fix round): a real session for this project
   * runs in `project.path` (`sessions/index.ts`), so the probe must too, or
   * anything an rc file keys on the directory — direnv's `.envrc`,
   * `asdf`/`nodenv`/`pyenv` version files — diverges from what a real session
   * would see. When there is no such directory — no project selected
   * (`project` is `null`), or a selected project whose `path` is `null`
   * (broken: missing, not a directory, …) — a session could never actually
   * spawn there either (`sessions/index.ts` refuses unless `status === 'ok'
   * && path !== null`), so there is no "real session" to match. `homedir()`
   * is the fallback: it is where a login shell opened outside this app would
   * normally find itself, and it is a fixed, meaningful location rather than
   * main's own `cwd` (unrelated to any project — `/` in a packaged build,
   * the app bundle in dev).
   */
  handle(CH.configDiagnoseEnv, (_event, payload): Promise<EnvDiagnostic> => {
    const request = parseDiagnoseEnvRequest(payload);
    const snapshot = getConfig();
    const project =
      request.id === undefined
        ? null
        : (snapshot.projects.find((entry) => entry.id === request.id) ?? null);
    const projectId = project?.id ?? null;
    const runtime = effectiveRuntime(snapshot, project);
    const cwd = project?.path ?? homedir();

    if (envDiagnosticInFlight) {
      return Promise.resolve({
        projectId,
        shell: runtime.shell,
        error:
          'another environment check is already running — wait for it to finish and try again',
        vars: [],
      });
    }

    envDiagnosticInFlight = true;
    /**
     * The same `stripEnv` a real session for this project would get
     * (`sessions/index.ts`). Without it the probe reports `ANTHROPIC_API_KEY`
     * as present in an environment every real session has it removed from —
     * the divergence class story 108's fix round exists to close, one level up
     * from `buildSessionEnv`.
     */
    const stripEnv = snapshot.subscriptionAuth ? AUTH_ENV_KEYS : [];
    return diagnoseEnv(
      runtime,
      projectId,
      cwd,
      process.env,
      stripEnv,
    ).finally(() => {
      envDiagnosticInFlight = false;
    });
  });

  /**
   * Notification preferences (story 106).
   *
   * A mutating verb like every other: guard first, verb second, fresh
   * `ConfigSnapshot` back.
   */
  handle(
    CH.configSetNotifications,
    (_event, payload): ConfigSnapshot =>
      setNotifications(parseSetNotificationsRequest(payload)),
  );

  /**
   * Story 107's two verbs. **Neither takes a payload**, so — exactly like
   * `config:get` and `config:reload` — the sender check `handle` applies is
   * their whole validation. There is no guard to write because there is no
   * input: main reveals and rewrites the file *it* resolved from
   * `configPath()`, which is what keeps the epic's "no verb takes a destination
   * path" rule true by construction rather than by a check that could be
   * forgotten.
   *
   * `showItemInFolder` rather than `openPath`: it selects the file in a folder
   * window instead of handing it to whatever application claims `.json`, and
   * it is the one of the two that cannot launch a program.
   */
  handle(CH.configReveal, (): void => {
    shell.showItemInFolder(configPath());
  });

  handle(CH.configReset, (): ConfigSnapshot => resetConfig());

  /**
   * Integrations status (story 106) — read-only, and **takes no payload**.
   *
   * The absent parameter list is the security design rather than an omission.
   * This is the first handler in main that executes another program, and the
   * reason it is safe to is that nothing from the renderer reaches the argv:
   * there is no path, no flag and no name to guard, so there is nothing to
   * inject into. See `integrations/gh.ts` for the rest of the execution rules.
   *
   * The `PATH` searched is the one the *spawn* path would use, not this
   * process's raw environment — the same discipline story 104's diagnostic
   * applies, so what is reported is what would actually run.
   */
  handle(CH.integrationsStatus, async (): Promise<IntegrationsStatus> => {
    /**
     * Wait for the login-shell import before looking for `gh` (HIVE-84).
     *
     * This is the whole point of the memoised promise: the probe was started
     * at boot, so by the time a settings pane is open it has almost always
     * resolved and this `await` costs nothing. What it buys is that the answer
     * can never be the *pre-import* `PATH` — a race that would report "gh was
     * not found" on a machine where it is about to be found, which is exactly
     * the confusing half-truth this story exists to remove.
     */
    const loginEnv = await loginEnvStatus();

    // Merged the way `diagnoseCommand` merges: the config's env wins, and
    // `process.env` supplies the `PATH` when it names none. `gh` is a
    // workspace-level tool, so the top-level runtime is the right scope — there
    // is no project selected when the section opens.
    const env = { ...process.env, ...effectiveRuntime(getConfig(), null).env };

    return {
      gh: readGhStatus(env, runCommand),
      loginEnv,
      notificationsSupported: Notification.isSupported(),
    };
  });

  /**
   * The environment half, without the binary.
   *
   * `integrations:status` above waits on the same memoised promise and then
   * spends two `spawnSync` calls looking for `gh`. Settings → Runtime wants the
   * `PATH` this app searched and has no interest in `gh`, so it gets the wait
   * and none of the subprocesses — which, since the promise was started at
   * boot, makes this handler a variable read that cannot block main.
   */
  handle(CH.integrationsLoginEnv, async (): Promise<LoginEnvStatus> => {
    return await loginEnvStatus();
  });

  /**
   * Jira (HIVE-67) — the app's first stored credential, and its first outbound
   * HTTP request.
   *
   * Built once, here, because this is the composition root: `auth.ts` and
   * `client.ts` take every dependency by injection so their unit tests can
   * answer without a keychain or a network, which means somebody has to supply
   * the real ones exactly once, and that somebody is this file.
   *
   * `safeStorage` is passed rather than imported inside `auth.ts` for the same
   * reason `gh.ts` takes its `RunCommand`: a module that reaches for an Electron
   * global is a module no unit test can answer for.
   *
   * `globalThis.fetch` rather than a dependency — Node is pinned `>=22` and
   * Electron is 43, so it is there. Wrapped rather than passed by reference so
   * `this` cannot matter and the seam stays a plain function.
   */
  const jira = createJira({
    store: safeStorage,
    file: credentialFile(join(app.getPath('userData'), 'jira-credential.bin')),
    env: process.env,
    config: getConfig,
    fetch: (url, init) => globalThis.fetch(url, init),
  });

  /**
   * The PR poller's read — the app's second handler that executes a binary,
   * and the first that does so on a timer.
   *
   * Same security design as `integrations:status`: **no payload**, so there is
   * no argv to inject into. What it adds is a cwd and a set of GraphQL
   * variables, and both come from the config file rather than the renderer —
   * see `integrations/github/query.ts` for why the repository names are bound
   * variables and never concatenated into the document.
   *
   * Asynchronous, unlike `integrations:status`. That one runs when a settings
   * pane opens; this one runs every minute for as long as the app is open, and
   * a `spawnSync` on that schedule would stall every pty chunk and every window
   * event behind it.
   */
  const github = createGithub({
    config: getConfig,
    // The same merge `integrations:status` makes, for the same reason: what is
    // reported has to be what would actually run.
    env: () => ({ ...process.env, ...effectiveRuntime(getConfig(), null).env }),
    run: runAsync,
    now: () => Date.now(),
  });

  handle(CH.githubPrs, async (): Promise<GhResult<PrsSnapshot>> => {
    // The poller's first tick can land before the boot-time import resolves,
    // and a `gh` "not found" cached from that tick would outlive the race
    // (HIVE-84). The `env` thunk above is lazy precisely so this await is all
    // that is needed.
    await loginEnvStatus();
    return github.prs();
  });

  handle(
    CH.githubSearchPrs,
    async (_event, payload): Promise<GhResult<PrRecord[]>> => {
      const request = parseSearchPrsRequest(payload);
      // Same race as `github:prs` — see the note there.
      await loginEnvStatus();
      return github.searchPrs(request.term, request.projectId);
    },
  );

  handle(CH.jiraStatus, (): JiraStatus => jira.status());
  handle(CH.jiraSetToken, (_event, payload): JiraStatus =>
    jira.setToken(parseSetJiraTokenRequest(payload)),
  );
  handle(CH.jiraClearToken, (): JiraStatus => jira.clearToken());
  handle(CH.jiraTest, (): Promise<JiraResult<JiraIdentity>> => jira.test());
  handle(
    CH.jiraSearch,
    (_event, payload): Promise<JiraResult<JiraSearchResult>> =>
      jira.search(parseJiraSearchRequest(payload)),
  );
  handle(
    CH.jiraIssue,
    (_event, payload): Promise<JiraResult<JiraIssue>> =>
      jira.issue(parseJiraIssueRequest(payload)),
  );
  handle(
    CH.jiraTransitions,
    (_event, payload): Promise<JiraResult<JiraTransition[]>> =>
      jira.transitions(parseJiraTransitionsRequest(payload)),
  );
  handle(
    CH.jiraApplyTransition,
    (_event, payload): Promise<JiraResult<JiraIssue>> =>
      jira.applyTransition(parseApplyJiraTransitionRequest(payload)),
  );
  handle(
    CH.jiraComments,
    (_event, payload): Promise<JiraResult<JiraComment[]>> =>
      jira.comments(parseJiraConversationRequest(payload)),
  );
  handle(
    CH.jiraLinks,
    (_event, payload): Promise<JiraResult<JiraLink[]>> =>
      jira.links(parseJiraConversationRequest(payload)),
  );
  handle(
    CH.jiraAddComment,
    (_event, payload): Promise<JiraResult<JiraComment>> =>
      jira.addComment(parseAddJiraCommentRequest(payload)),
  );
  handle(CH.configSetJira, (_event, payload): ConfigSnapshot =>
    setJira(parseSetJiraRequest(payload)),
  );

  /**
   * Cloning a repository (story 102).
   *
   * `startClone` returns a **refusal**, it does not throw: a mistyped URL or a
   * folder that already exists is something the user fixes in a text field, not
   * an exception the renderer has to catch. Guard failures still throw — those
   * are malformed payloads, which are a bug or an attack, not a user mistake.
   */
  handle(CH.configCloneStart, (_event, payload): CloneStartResult => {
    const request = parseCloneRequest(payload);
    return (
      cloneFlow?.start(request) ?? {
        ok: false,
        reason: 'the clone service is not available',
      }
    );
  });

  handle(CH.configCloneCancel, (): void => {
    cloneFlow?.cancel();
  });

  /**
   * The project filesystem (the explorer and the editor).
   *
   * Every one of these validates twice, and the two checks are not redundant.
   * The guard settles what a legal *string* is — relative, no `..` segment, no
   * control bytes — and `electron/main/fs/paths.ts` settles where that string
   * actually lands once symlinks are resolved. Neither can do the other's job:
   * a string check cannot see a symlink, and `realpath` cannot see a `..` on a
   * path that does not exist yet.
   *
   * None of them throws across IPC. Each answers with a result the panel can
   * render, on the same rule the Jira verbs follow — a tree that throws because
   * one directory is unreadable says the app is broken, when one directory is
   * unreadable.
   */
  handle(
    CH.fsReadDir,
    (_event, payload): Promise<FsResult<DirEntry[]>> =>
      readDirectory(parseReadDirRequest(payload)),
  );

  handle(
    CH.fsRoot,
    (_event, payload): Promise<FsResult<RootInfo>> =>
      readRoot(parseRootRequest(payload)),
  );

  handle(
    CH.fsReadFile,
    (_event, payload): Promise<FsResult<FileContent | FsRefusal>> =>
      readFileContent(parseReadFileRequest(payload)),
  );

  handle(
    CH.fsWriteFile,
    (_event, payload): Promise<WriteFileResult> =>
      writeFileContent(parseWriteFileRequest(payload)),
  );

  /**
   * The recursing verb. Answers `FsResult` like every read here —
   * a search that failed must render as a failed search, not as a broken app.
   * Every bound it obeys lives in `fs-contract.ts`, not at this call site.
   */
  handle(
    CH.fsSearch,
    (_event, payload): Promise<FsResult<SearchResults>> =>
      searchProject(parseSearchRequest(payload)),
  );

  /**
   * `watch` resolves once the watcher is up, and rejects if the project cannot
   * be watched — the one fs verb that does throw, because there is no view to
   * render its failure into. The explorer treats a rejection as "no live
   * updates" and keeps its manual refresh, which is the honest degradation.
   */
  handle(CH.fsWatch, async (_event, payload): Promise<void> => {
    const request = parseWatchRequest(payload);
    await fsWatch?.watchProject(request.projectId, request.sessionId);
  });

  handle(CH.fsUnwatch, (): void => {
    fsWatch?.unwatch();
  });

  /**
   * Custom skills (HIVE-96, HIVE-99).
   *
   * The `fs` block above validates twice — a string-shape guard here, then real
   * containment in `fs/paths.ts` — because it accepts a path. These five
   * validate once, and that is not a weaker design: `assertSkillName` admits
   * only `[a-z0-9-]+`, which cannot name a directory other than the one main
   * chooses, so there is no second question to ask. See `skills-contract.ts`.
   *
   * `skills` is non-null from registration onward; the optional chaining is for
   * the window between module load and `registerIpc`, which is the same reason
   * every `sessions?.` call in this file has it.
   */
  handle(CH.skillsList, () => skills?.list());

  handle(CH.skillsRead, (_event, payload) =>
    skills?.readOne(parseSkillNameRequest(payload).name),
  );

  handle(CH.skillsWrite, (_event, payload) => {
    const request = parseSkillWriteRequest(payload);
    return skills?.write(request.name, request.body);
  });

  handle(CH.skillsRemove, (_event, payload) =>
    skills?.remove(parseSkillNameRequest(payload).name),
  );

  handle(CH.skillsRename, (_event, payload) => {
    const request = parseSkillRenameRequest(payload);
    return skills?.rename(request.from, request.to);
  });

  /**
   * Agent definitions (HIVE-114).
   *
   * `agents` is non-null from registration onward; the optional chaining
   * matches every other runtime in this file, for the window between module
   * load and `registerIpc`.
   *
   * `write` and `rename` answer with an `AgentWriteResult` rather than a fresh
   * snapshot, unlike their skills counterparts. A refusal here has structure —
   * problems, each naming its field — and the editor renders them beside the
   * controls they name; the change push is what refreshes the list.
   */
  /*
    The definitions the registry read, joined to what has since happened to
    them (HIVE-115).

    `AgentSummary` gained `sessionUuid`, `runsSinceRotate` and `cost` with the
    run tracker, and the registry cannot fill any of them in — it reads
    `AGENT.md` files and has never seen a process. Merging here rather than in
    the registry keeps that module ignorant of runs, and keeps `agents.json`
    read in exactly one place. Without this the three fields would be part of
    the contract and permanently `undefined`.
  */
  handle(CH.agentsList, async () => {
    const snapshot = await agents?.list();

    if (snapshot === undefined) return undefined;

    return mergeRunState(snapshot, agentState?.all() ?? {});
  });

  handle(CH.agentsRead, (_event, payload) =>
    agents?.read(parseAgentNameRequest(payload).name),
  );

  handle(CH.agentsWrite, (_event, payload) => {
    const request = parseAgentWriteRequest(payload);
    return agents?.write(request.name, request.source);
  });

  handle(CH.agentsRemove, (_event, payload) =>
    agents?.remove(parseAgentNameRequest(payload).name),
  );

  handle(CH.agentsRename, (_event, payload) => {
    const request = parseAgentRenameRequest(payload);
    return agents?.rename(request.from, request.to, request.source);
  });

  /**
   * Wake an agent now (HIVE-115).
   *
   * The trigger is `'manual'` and is written **here**, not taken from the
   * payload — see `parseAgentRunRequest` and `BRIDGE_AGENTS_KEYS`. It is the
   * only trigger this channel could report honestly, and it goes into the
   * ledger entry and the wake prompt, so accepting a renderer's word for it
   * would let the page write history.
   *
   * Two awaits before the spawn, and each closes a window this file already
   * knows about from the pty path:
   *
   * - `loginEnvStatus()` — `claude` is resolved by walking `PATH`, and HIVE-84
   *   replaces this process's `PATH` shortly after launch. Resolving against
   *   the pre-repair value would fail on exactly the machines that import fixed
   *   it for, and the refusal would read as "claude is not installed".
   * - `mcp.start()` — the memoised write of `hive.mcp.json`. Without it, a run
   *   launched in the first moments of the app would be refused for want of a
   *   config path that was about to exist.
   */
  handle(CH.agentsRun, async (_event, payload): Promise<AgentRunResult> => {
    const request = parseAgentRunRequest(payload);

    await loginEnvStatus();
    await mcp.start();

    return (
      runs?.run(request.name, 'manual') ?? {
        started: false,
        refused: 'unknown',
        reason: 'The agent runtime is not running.',
      }
    );
  });

  /**
   * Stop the run in progress, if there is one.
   *
   * Takes the same name guard as `read` and `remove`, and can only ever reach a
   * child this app spawned and still holds: the tracker looks the name up in
   * its own map and answers `false` for anything it does not find. There is no
   * pid on this channel and no way to reach a process The Hive did not start.
   *
   * `false` is not an error. A run can end between the row rendering its stop
   * button and the click arriving, and reporting that as a failure would teach
   * the user to distrust a button that did exactly what they wanted.
   */
  handle(CH.agentsKill, (_event, payload): boolean =>
    // `?? false`, because the channel's declared answer is a boolean and "the
    // runtime is not running" is the same news to the renderer as "there was
    // nothing to stop" — an `undefined` on a `Promise<boolean>` is neither.
    runs?.kill(parseAgentNameRequest(payload).name) ?? false,
  );

  /**
   * Write one status and say what it now is (HIVE-117).
   *
   * Both verbs are this short because neither owns the *consequence*: pausing
   * does not stop anything here, it makes `RunTracker.run` refuse — which is
   * the one door every trigger passes through, today's `agents:run` and the
   * wakes HIVE-120 and HIVE-121 will add alike.
   *
   * `agentState` rather than `runs` is what they need, so both keep working
   * when an agent has never run: there is no tracker entry to pause.
   *
   * The answer is **read back** from the state rather than echoed from the
   * argument, for `pushAgentStatus`'s own reason: a reply and the next
   * `agents:list` must not be able to disagree.
   *
   * A missing state throws rather than answering. `run` and `kill` can both
   * report "the runtime is not up" inside their return types — `refused:
   * 'unknown'` and `false` — and this one cannot, since every member of
   * {@link AgentStatus} is a claim that something was written. Answering
   * `paused` for a pause that reached no file is the one outcome worth a
   * rejected promise.
   */
  const setAgentStatus = (name: string, status: AgentStatus): AgentStatus => {
    if (agentState === null) {
      throw new Error('The agent runtime is not running.');
    }

    const next = agentState.patch(name, { status });

    pushAgentStatus(name);

    return next.status;
  };

  /**
   * Refuse a name that is not an agent this machine has a definition for.
   *
   * `parseAgentNameRequest` validates the name's *shape* and nothing else, and
   * `AgentState.patch` creates an entry for whatever it is handed. Without this
   * check, `pause` on an unknown name writes `{"ghost": {"status": "paused"}}`
   * into `agents.json` permanently — and an agent later created under that name
   * would be born paused, refusing every trigger for a reason nothing on screen
   * explains. `BRIDGE_AGENTS_KEYS` claims these two verbs cannot create an
   * agent; this is what makes that true of its run state as well.
   *
   * HIVE-122's `rotate` is the third caller, for exactly this reason: it too
   * patches state before anything reads a definition.
   *
   * `run` needs no equivalent: it reaches `deps.command`, which reads the
   * definition off disk and refuses `invalid` when there is none.
   */
  const requireAgent = async (name: string): Promise<string> => {
    const snapshot = await agents?.list();

    if (!snapshot?.agents.some((agent) => agent.name === name)) {
      throw new Error(`No such agent: ${name}`);
    }

    return name;
  };

  /**
   * Force a handoff wake now (HIVE-122).
   *
   * `agents:run` with one field armed first, and the ordering is the point: the
   * flag is written to **state**, then the run goes through the ordinary door.
   * If the agent is busy or paused the run is refused exactly as `agents:run`
   * would refuse it — and the flag stays armed, so the wake that does happen is
   * the handoff wake. A rotation the user asked for is never silently dropped.
   *
   * `requireAgent` for `pause`'s reason and not `run`'s: this writes to
   * `agents.json` before it reaches anything that reads a definition, so
   * without the check a typo would leave `{"ghost": {"forceRotate": true}}` on
   * disk permanently — and an agent later created under that name would be
   * born owing a handoff for a conversation it never had.
   *
   * `agentState`, not the tracker, is what carries the flag, so arming a
   * rotation works on an agent that has never run: there is no tracker entry to
   * arm. `wake-command.ts` gives that case an ordinary first wake rather than a
   * last turn on a session that does not exist yet.
   *
   * The same two awaits as `run`, for the same two reasons, since this reaches
   * the same spawn: `PATH` may still be the pre-repair one, and `hive.mcp.json`
   * may not have been written yet.
   */
  handle(CH.agentsRotate, async (_event, payload): Promise<AgentRunResult> => {
    const name = await requireAgent(parseAgentNameRequest(payload).name);

    if (agentState === null) {
      throw new Error('The agent runtime is not running.');
    }

    agentState.patch(name, { forceRotate: true });

    await loginEnvStatus();
    await mcp.start();

    return (
      runs?.run(name, 'manual') ?? {
        started: false,
        refused: 'unknown',
        reason: 'The agent runtime is not running.',
      }
    );
  });

  handle(CH.agentsPause, async (_event, payload): Promise<AgentStatus> =>
    // No `kill`. A pause lets the turn in flight finish — see the contract, and
    // `finalizeRun`, which is what stops that turn writing the pause back out.
    setAgentStatus(await requireAgent(parseAgentNameRequest(payload).name), 'paused'),
  );

  /**
   * Resume **recomputes** the resting status rather than restoring a
   * remembered one.
   *
   * Nothing records what an agent was before it was paused, and deliberately:
   * `AgentRunState` has no second representation of a status, and a remembered
   * `sleeping` would be wrong the moment the agent asked something while
   * paused — which is exactly when it can, since a turn in flight is allowed
   * to finish.
   *
   * The rule is `finalizeRun`'s, reused: an unanswered ask outranks everything
   * else, because status is about what the user must do next — with one term
   * `finalizeRun` does not need, because it only ever runs when the child is
   * already gone: a **live run outranks the ledger**. Pausing mid-turn does not
   * kill the child, so `paused` and "a process is running" are not exclusive,
   * and resuming into `sleeping` there would put a resting word on a row whose
   * agent is working — which `run` would then contradict by refusing.
   */
  handle(CH.agentsResume, async (_event, payload): Promise<AgentStatus> => {
    const name = await requireAgent(parseAgentNameRequest(payload).name);

    if (agentState === null) {
      throw new Error('The agent runtime is not running.');
    }

    /*
      Only a paused agent resumes.

      Without this the verb is destructive on every other status: a `working`
      agent resumed mid-turn would have its row rewritten to `sleeping` while
      its process is still running, and the next `finalizeRun` would be the
      only thing to put it right. Resume is the inverse of pause and nothing
      else, so anything not paused is already resumed — answer what it is.

      Read after the null check rather than through `?.`: answering `sleeping`
      for a resume that reached no file is exactly the lie the docblock above
      rejects for `pause`, and it is no more true here.
    */
    const current = agentState.read(name).status;

    if (current !== 'paused') return current;

    if (runs?.live().includes(name) === true) {
      /*
        No flush on this arm, deliberately (HIVE-120).

        A run is still in flight, so the agent cannot take a wake — and the
        queue is about to be flushed by the `onRunClosed` that run is going to
        fire, which will find the agent no longer paused and deliver it then.
        Flushing here would reach `refused: 'working'` and, having already
        cleared the queue, lose it.
      */
      return setAgentStatus(name, 'working');
    }

    const asking = ledger.read({}).openAsks.some((ask) => ask.from === name);

    setAgentStatus(name, asking ? 'asking' : 'sleeping');

    /*
      What the pause was holding (HIVE-120): entries that arrived while this
      agent was stopped, delivered as one wake now that it is not. After the
      status is written, because the scheduler wakes through `RunTracker.run`
      and a `paused` still on disk would refuse it.
    */
    scheduler?.onResume(name);

    /*
      Read back **after** the flush, not captured before it.

      A queue standing at this moment starts a run inside `onResume`, which
      patches the status to `working` and pushes it. Answering with the value
      from before that would hand the renderer a `sleeping` the push it is about
      to receive already contradicts — the same disagreement `pushAgentStatus`
      re-reads the file to avoid.
    */
    return agentState.read(name).status;
  });

  /**
   * Getting a theme file on and off disk (HIVE-80).
   *
   * Neither verb takes a payload that names a destination: `pick` returns
   * whatever the open dialog chose, and `save`'s only renderer-supplied fields
   * are the file's contents and a suggested name for the save dialog — see
   * `parseSaveThemeRequest` for why both still need validating even though
   * neither is a path.
   */
  handle(CH.themePick, (event) => pickTheme(event));
  handle(CH.themeSave, (event, payload) =>
    saveTheme(event, parseSaveThemeRequest(payload)),
  );

  /**
   * What the renderer is showing (HIVE-81). Guarded to reject rather than
   * sanitise: a malformed payload is dropped and logged (see `on()` above),
   * never coerced into `null` — a compromised or buggy renderer must not be
   * able to make a fabricated shape read as "nothing on stage".
   */
  on(CH.uiForeground, (_event, payload) => {
    if (!isRecord(payload)) throw new Error('ui:foreground expects an object');
    const keys = Object.keys(payload);
    if (keys.length !== 1 || keys[0] !== 'terminalId') {
      throw new Error('ui:foreground expects exactly { terminalId }');
    }
    const { terminalId } = payload;
    if (terminalId !== null && typeof terminalId !== 'string') {
      throw new Error('ui:foreground expects a string terminalId or null');
    }

    if (foregroundTerminalId === terminalId) return;
    foregroundTerminalId = terminalId;
    notifyForegroundChange();
  });

  /**
   * What a session is called (HIVE-110). Guarded the same way and for the same
   * reason as `ui:foreground` above: rejected rather than sanitised, so a
   * malformed payload is dropped and logged instead of being coerced into a
   * name that would then appear in a toast.
   *
   * Recorded and nothing more — no notification is raised, nothing is
   * re-rendered. The only reader is the hub, at the moment it presents a toast.
   */
  on(CH.uiSessionName, (_event, payload) => {
    if (!isRecord(payload)) throw new Error('ui:session-name expects an object');
    const keys = Object.keys(payload);
    if (keys.length !== 2 || !keys.includes('terminalId') || !keys.includes('name')) {
      throw new Error('ui:session-name expects exactly { terminalId, name }');
    }
    const { terminalId, name } = payload;
    if (typeof terminalId !== 'string' || typeof name !== 'string') {
      throw new Error('ui:session-name expects string terminalId and name');
    }
    /*
      Capped at the same length `readTitle` caps the other name producer at
      (`sessions/index.ts`), and for a sharper reason here: `names.ts` claims its
      map is bounded by the number of sessions this process has spawned, and
      without a bound on either half of the pair that claim would rest on the
      renderer behaving — which this handler's own guard exists not to assume.
      The id is bounded by the same number: `sess-nn` and a `/clear` successor
      are both short, and nothing legitimate reaches this length.
    */
    if (
      terminalId.length > SESSION_NAME_DISPLAY_MAX ||
      name.length > SESSION_NAME_DISPLAY_MAX
    ) {
      throw new Error('ui:session-name expects a terminalId and name within bounds');
    }

    sessionNames.set(terminalId, name);
  });

  /**
   * The PTY channels (story 093).
   *
   * `spawn` and `kill` use `invoke` — both need a result. `write`, `resize`
   * and `ack` use `send`, and every one of them is validated before it reaches
   * process control.
   */
  /**
   * `sessionId` on the wire is an **entity** id.
   *
   * The renderer has always addressed terminals by entity id (story 094) and
   * never sees a pty handle. Story 096 makes the two genuinely different: main
   * mints a session id per generation, and the sessions layer translates in both
   * directions. Project resolution and every refusal message moved there with
   * it, so this handler is now only validation and delegation.
   */
  handle(CH.ptySpawn, async (_event, payload) => {
    const request = parseSpawnRequest(payload);
    /**
     * Wait for the login-shell import before the pty-host can be forked
     * (HIVE-84).
     *
     * This is the one await in this file that is about a *child process's*
     * environment rather than a reply. `forkPtyHost` passes no `env`, so the
     * utility process snapshots `process.env` **at fork time**, and the host is
     * forked lazily on the first spawn and then reused for the life of the app.
     * Without this, a user who clicks a project inside the first second — the
     * machine with the slow rc file, which is exactly the population the 5s
     * timeout exists for — forks the host with launchd's four-entry `PATH` and
     * freezes it there permanently, while Settings correctly reports that the
     * import succeeded.
     *
     * Costs nothing in the ordinary case: the probe starts at boot and has
     * long since resolved by the time anyone opens a session.
     */
    await loginEnvStatus();
    /**
     * Regenerate the skills plugin before the session is started (HIVE-96).
     *
     * Here rather than inside `spawn` because `spawn` is synchronous on
     * purpose — its "attach, never respawn" guard and the registration that
     * satisfies it must not be separated by an await. This handler is already
     * asynchronous and already waits for the login-shell probe, so the
     * regeneration is free of that constraint.
     *
     * Per spawn rather than at launch: a skill saved from Settings, or written
     * by hand into `~/.hive/skills` with the app already running, has to be on
     * *this* command line. A readdir over a handful of small files is cheaper
     * than any protocol that would tell us the tree changed.
     */
    await skills?.sync();
    /**
     * Wait for the MCP config write before a session can be spawned (HIVE-112).
     *
     * `mcp.start()` is fired once, unawaited, at construction so a slow write
     * cannot delay the first window — but `sessions.open()` calls `spawn()`
     * synchronously below, and `spawn()` reads `mcp.configPathFor()` the same
     * instant. Without this await, a session opened inside that window would
     * see `null` and start silently and permanently without ledger tools. The
     * promise is memoised, so this either resolves immediately (the ordinary
     * case, long since settled by the time anyone opens a session) or joins
     * the one write already in flight — never a second one.
     */
    await mcp.start();
    sessions?.open({
      entityId: request.sessionId,
      projectId: request.projectId,
      cols: request.cols,
      rows: request.rows,
      task: request.task,
      model: request.model,
      effort: request.effort,
      name: request.name,
      // HIVE-88. Forwarded only here — a restart is never a resume.
      resume: request.resume,
    });
  });

  handle(CH.ptyRestart, async (_event, payload) => {
    const request = parseSpawnRequest(payload);
    // Same fork race as `ptySpawn` above: a restart can be the call that first
    // brings the host up, so it has to wait for the same reason.
    await loginEnvStatus();
    // And the same regeneration, for the same reason: a restart builds a fresh
    // command line, so it must see the skills the user has now (HIVE-96).
    await skills?.sync();
    // Same wait as `ptySpawn` above, for the same reason: a restart's `spawn()`
    // reads `mcp.configPathFor()` synchronously too (HIVE-112).
    await mcp.start();
    /**
     * The task is deliberately **not** forwarded (story 097).
     *
     * A restart discards a running agent's context and starts a fresh process.
     * Re-delivering an instruction the previous generation may already have
     * acted on — edited files, opened a PR — is worse than delivering nothing:
     * the user asked for a clean slate, not for the work to be redone.
     *
     * `model` and `effort` **are** forwarded, and the asymmetry is the point
     * (story 109): they describe the session, not the turn. Dropping them would
     * restart a Haiku session as whatever `claude` defaults to while its row
     * went on saying Haiku.
     */
    await sessions?.restart({
      entityId: request.sessionId,
      projectId: request.projectId,
      cols: request.cols,
      rows: request.rows,
      model: request.model,
      effort: request.effort,
      /**
       * Forwarded with `model` and `effort`, for their reason (HIVE-78): a name
       * describes the session, not the turn. A restarted `HIVE-73` that came
       * back as `sess-07` would rename a row the user has been watching.
       */
      name: request.name,
    });
  });

  handle(CH.ptyKill, (_event, payload) => {
    sessions?.kill(parseKillRequest(payload));
  });

  on(CH.ptyWrite, (_event, payload) => {
    const request = parseWriteRequest(payload);
    sessions?.write(request.sessionId, request.data);
  });

  on(CH.ptyResize, (_event, payload) => {
    const request = parseResizeRequest(payload);
    sessions?.resize(request.sessionId, request.cols, request.rows);
  });

  on(CH.ptyAck, (_event, payload) => {
    const request = parseAckRequest(payload);
    sessions?.ack(request.sessionId, request.seq);
  });
}

/** Test-only: drop the sessions layer and its timers. */
export function resetIpcHandlers(): void {
  sessions?.dispose();
  sessions = null;
  cloneFlow?.dispose();
  cloneFlow = null;
  fsWatch?.dispose();
  fsWatch = null;
  /*
    HIVE-87. Dropped without flushing: a test's history points at whatever
    `app.getPath` was stubbed to return, and writing there on teardown is how a
    unit test comes to leave a file behind.

    `dispose()` rather than just dropping the reference — the debounce timer
    closes over the write directly, so an unreferenced history still fires one
    last `writeFileSync` at that stubbed path.
  */
  history?.dispose();
  history = null;
  /*
    HIVE-115. Killed rather than dropped: a spec that let a real run leak would
    leave a `claude -p` process running after the test that started it, and the
    registry holds an `fs.watch` handle and a debounce timer that would
    otherwise fire into the next test's handlers.

    `closeAll`, not `killAll`, and the ordering with `dispose()` on the next
    line is the whole reason. `killAll` only signals: the `'close'` events land
    afterwards, run `finalizeRun` → `recordRun` → `schedule()`, and arm a *new*
    400 ms timer against a state that has already been disposed — writing
    `agents.json` at whatever `configPath()` was stubbed to, which is precisely
    the leak `dispose()` exists to cancel, and pushing status into a torn-down
    IPC layer on the way. `closeAll` finalizes each run synchronously, so
    everything it schedules is scheduled *before* the dispose that cancels it.

    `agentState` is **disposed**, exactly as `history` is and for the same
    reason — a test's state file points at whatever `configPath` was stubbed to
    return, and writing there on teardown is how a unit test comes to leave a
    file behind. `dispose()` rather than dropping the reference, and rather
    than `flush()`: the debounce timer closes over the write directly, so an
    unreferenced state still fires one last `writeFileSync` at that stubbed
    path 400 ms later, into a directory the test that owned it has finished
    with.
  */
  /*
    Disarmed for the same reason `agentState` is disposed (HIVE-120): the sweep
    is a live interval closing over this registration's ledger, and one left
    running would fire into a torn-down composition — and, in a test, at a path
    the case that owned it has finished with.

    **Before `closeAll`**, which finalizes every live run synchronously and so
    reaches `onRunClosed` from inside this teardown. A flush there would spawn a
    real `claude` out of a unit test, and its finalizer would then write through
    an `agentState` disposed a few lines below.
  */
  scheduler?.stop();
  scheduler = null;
  // Holds no resources of its own — no `.stop()` — but a stale reference
  // here would let a next test's `ledger.onChange` reach a `permissions`
  // built against this test's disposed `agents`/`ledger`.
  permissions = null;
  runs?.closeAll('reset');
  runs = null;
  agentState?.dispose();
  agentState = null;
  agents?.close();
  agents = null;
  knownAgents.clear();
  ledgerAgents.clear();
  agentSchedules.clear();
  // Back to "nothing has been listed", not "nothing is scheduled": the next
  // registration must earn the right to clear a `nextRunAt` all over again.
  agentsListed = false;
  // HIVE-81. Test-only: a fresh registration starts with nothing on stage and
  // no listeners left over from a previous test — including the app-level
  // focus wiring and any tick it has already scheduled, which would otherwise
  // fire into the next test's handlers.
  foregroundTerminalId = null;
  foregroundListeners.clear();
  unwatchWindowFocus?.();
  if (foregroundTick !== null) {
    clearTimeout(foregroundTick);
    foregroundTick = null;
  }
}

export { assertSender, isTrustedSender, IpcSenderError } from './sender';
