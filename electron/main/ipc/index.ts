import { homedir } from 'node:os';
import { join } from 'node:path';

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
  WriteFileResult,
} from '@shared/fs-contract';
import type { GhResult, PrsSnapshot } from '@shared/github-contract';
import {
  parseAckRequest,
  parseAddProjectRequest,
  parseCloneRequest,
  parseDiagnoseCommandRequest,
  parseReadDirRequest,
  parseReadFileRequest,
  parseWatchRequest,
  parseWriteFileRequest,
  parseDiagnoseEnvRequest,
  parseSpawnRequest,
  parseKillRequest,
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
  parseSessionNoteRequest,
  parseSkillNameRequest,
  parseSkillWriteRequest,
  parseWriteRequest,
} from '@shared/guards';
import {
  CH,
  type AppInfo,
  type IntegrationsStatus,
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
import {
  SESSION_HISTORY_FILE,
  type SessionHistoryEntry,
} from '@shared/session-history-contract';
import type { UpdateStatus } from '@shared/update-contract';

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
  readDirectory,
  readFileContent,
  writeFileContent,
  type FsWatchLayer,
} from '../fs';
import { createHookRuntime } from '../hooks';
import { readGhStatus, runCommand } from '../integrations/gh';
import { createGithub } from '../integrations/github';
import { runAsync } from '../integrations/github/run';
import { createJira } from '../integrations/jira';
import { credentialFile } from '../integrations/jira/auth';
import { createNotificationHub, createNotifier } from '../notifications';
import { registerPtyHost } from '../pty-host';
import { createSessions, type Sessions } from '../sessions';
import {
  createSessionLedger,
  type SessionLedger,
} from '../sessions/ledger';
import { onShutdown } from '../shutdown';
import { createSkillsRuntime, type SkillsRuntime } from '../skills';
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
 * The session ledger (HIVE-87), or `null` before registration.
 *
 * Held here rather than reached through `sessions` because two unrelated things
 * need it: the session layer writes to it, and `session:history` reads from it.
 * Routing the read through the session layer would mean widening that layer's
 * surface with a verb it does not otherwise need.
 */
let ledger: SessionLedger | null = null;
/**
 * The custom-skills runtime (HIVE-96), or `null` before registration.
 *
 * Held here for the reason `ledger` is: two unrelated callers need it. The
 * session layer syncs it before every spawn and reads its path, and the four
 * `skills:*` handlers below read and write the tree it manages.
 */
let skills: SkillsRuntime | null = null;
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

      if (action.type !== 'session') return;

      send(CH.notificationsActivate, {
        entityId: action.entityId,
      } satisfies NotificationActivateEvent);
    },
    now: () => Date.now(),
    isForeground: (action) =>
      action.type === 'session' && isForeground(action.entityId),
  });

  const notifier = createNotifier({ hub, isForeground });

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
   * The ledger, beside `window-state.json` in the app's own directory (HIVE-87).
   *
   * Constructed before the session layer because that layer takes it as an
   * option. Nothing about it touches `~/.claude` — it records what The Hive
   * knows about its own rows, not anything Claude wrote.
   */
  ledger = createSessionLedger(
    join(app.getPath('userData'), SESSION_HISTORY_FILE),
  );

  /*
    Constructed before the session layer, which takes it as an option and syncs
    it on every spawn (HIVE-96). `app.getVersion()` is read here rather than
    inside the runtime so that module's tests can run under plain Node — the
    same reason `userDataPath` is passed in rather than resolved there.
  */
  skills = createSkillsRuntime({
    userDataPath: app.getPath('userData'),
    version: app.getVersion(),
  });

  sessions = createSessions({
    supervisor,
    config: getConfig,
    send,
    skills,
    hooks: createHookRuntime({
      userDataPath: app.getPath('userData'),
      // Read per call, so a config reload is picked up (HIVE-79).
      sessionMetrics: () => getConfig().sessionMetrics,
    }),
    ledger,
  });

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
    ledger?.flush();
  });

  /**
   * The fleet as it was when the app last closed (HIVE-87).
   *
   * Answers from memory rather than re-reading the file: the ledger loaded it at
   * construction and is the only thing that writes to it, so a second read could
   * only ever return something staler than what is already held.
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
     * gives the same fresh store in front of the same running ptys. The ledger
     * holds those sessions as `working` — true, and exactly the problem — so
     * the renderer would restore them as last run's fleet and their own hooks
     * would then prove otherwise. The registry is the one authority on "has a
     * process now": a session this run began and already lost is history too.
     */
    const live = new Set(sessions?.entities() ?? []);
    return (ledger?.all() ?? []).map((record) =>
      live.has(record.id) ? { ...record, live: true } : record,
    );
  });

  /**
   * The renderer naming a ticket for a session (HIVE-87).
   *
   * Guarded like every other payload that crosses the bridge. It cannot create
   * a record — `record` merges into whatever is already there, and a note for
   * an entity main never spawned would create a row for a session that never
   * existed. Hence the `all()` check: main writes only what it already knows
   * about.
   */
  handle(CH.sessionNote, (_event, raw: unknown): void => {
    const request = parseSessionNoteRequest(raw);
    if (!ledger?.all().some((record) => record.id === request.entityId)) return;
    ledger.record(request.entityId, { ticket: request.ticket });
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
  handle(CH.configReload, (): ConfigSnapshot => reloadConfig());

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
   * `watch` resolves once the watcher is up, and rejects if the project cannot
   * be watched — the one fs verb that does throw, because there is no view to
   * render its failure into. The explorer treats a rejection as "no live
   * updates" and keeps its manual refresh, which is the honest degradation.
   */
  handle(CH.fsWatch, async (_event, payload): Promise<void> => {
    await fsWatch?.watchProject(parseWatchRequest(payload).projectId);
  });

  handle(CH.fsUnwatch, (): void => {
    fsWatch?.unwatch();
  });

  /**
   * Custom skills (HIVE-96).
   *
   * The `fs` block above validates twice — a string-shape guard here, then real
   * containment in `fs/paths.ts` — because it accepts a path. These four
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
    sessions?.open({
      entityId: request.sessionId,
      projectId: request.projectId,
      cols: request.cols,
      rows: request.rows,
      task: request.task,
      model: request.model,
      effort: request.effort,
      name: request.name,
      /**
       * The app's theme, which decides which settings file `claude` is started
       * with and therefore how it paints its own UI inside the terminal.
       */
      theme: request.theme,
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
      /**
       * Forwarded too, and a restart is the one moment a *running* session can
       * change theme: `claude` reads its settings file once, at startup, so a
       * session started before a theme toggle keeps its old chrome until this.
       */
      theme: request.theme,
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
    HIVE-87. Dropped without flushing: a test's ledger points at whatever
    `app.getPath` was stubbed to return, and writing there on teardown is how a
    unit test comes to leave a file behind.

    `dispose()` rather than just dropping the reference — the debounce timer
    closes over the write directly, so an unreferenced ledger still fires one
    last `writeFileSync` at that stubbed path.
  */
  ledger?.dispose();
  ledger = null;
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
