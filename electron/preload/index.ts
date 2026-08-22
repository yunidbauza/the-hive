import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';


import type {
  AddProjectRequest,
  CloneDoneEvent,
  CloneRequest,
  CloneStartResult,
  CommandDiagnostic,
  ConfigSnapshot,
  DiagnoseCommandRequest,
  DiagnoseEnvRequest,
  EnvDiagnostic,
  RemoveProjectRequest,
  RenameProjectRequest,
  ReorderProjectsRequest,
  AddJiraCommentRequest,
  ApplyJiraTransitionRequest,
  JiraConversationRequest,
  JiraIssueRequest,
  JiraSearchRequest,
  JiraTransitionsRequest,
  RepointProjectRequest,
  SetJiraRequest,
  SetJiraTokenRequest,
  SetNotificationsRequest,
  SetProjectRuntimeRequest,
  SetRuntimeRequest,
} from '@shared/config-contract';
import type {
  DirEntry,
  FileContent,
  FsChangedEvent,
  FsRefusal,
  FsResult,
  ReadDirRequest,
  ReadFileRequest,
  WatchRequest,
  WriteFileRequest,
  WriteFileResult,
} from '@shared/fs-contract';
import type { GhResult, PrsSnapshot } from '@shared/github-contract';
import {
  CH,
  type AckRequest,
  type AppInfo,
  type DataEvent,
  type ExitEvent,
  type ForegroundReport,
  type HiveBridge,
  type IntegrationsStatus,
  type NotificationActivateEvent,
  type NotificationDeliveryStatus,
  type NotificationDismissedEvent,
  type NotificationReadEvent,
  type ResizeRequest,
  type SessionLostEvent,
  type SpawnRequest,
  type WriteRequest,
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
import type { SessionMetricsEvent } from '@shared/metrics-contract';
import type {
  HiveNotification,
  NotificationAction,
} from '@shared/notification-contract';
import type {
  SessionBranchEvent,
  SessionClearedEvent,
  SessionNameEvent,
  SessionStatusEvent,
  SessionTicketIntentEvent,
} from '@shared/session-contract';
import type {
  SessionNoteRequest,
  SessionRecord,
} from '@shared/session-history-contract';
import type { PickedTheme, SaveThemeRequest } from '@shared/theme-contract';
import type { UpdateStatus } from '@shared/update-contract';

/**
 * The bridge (story 082).
 *
 * Three rules the review must enforce, all of them load-bearing:
 *
 * 1. **`ipcRenderer` is never exposed**, in whole or in part. Not as
 *    `ipcRenderer.invoke` bound to a channel argument, not behind a wrapper
 *    that takes a channel name. The renderer gets *verbs*, and the set of verbs
 *    is the allowlist. Adding a capability later is a deliberate edit to the
 *    contract rather than an incremental widening of what a web page can do to
 *    this machine.
 *
 * 2. **Every subscription returns its own unsubscribe.** This mirrors
 *    `TerminalTransport.onData`'s contract exactly (story 042), which is what
 *    lets `PtyTransport` (story 094) be a thin adapter rather than a
 *    translation layer.
 *
 * 3. **The raw `IpcRendererEvent` never crosses the bridge.** Passing the event
 *    hands the renderer a `sender` handle and defeats the isolation entirely.
 *
 * `sandbox: true` constrains this file too: it may require only `electron` and
 * a small polyfill set — no `fs`, no `child_process`, no `process.env`. Any
 * temptation to do real work here is a signal the work belongs in main behind
 * a channel.
 */

/**
 * Thirteen live terminals mean thirteen `pty:data` subscriptions on one
 * channel, and Node's default cap of 10 would log a MaxListenersExceeded
 * warning that is entirely legitimate here.
 *
 * Raised explicitly rather than left to fire, because a warning everyone has
 * learned to ignore is a warning that will not be read when it means something.
 * The number is generous but finite — an unbounded cap would hide a real
 * listener leak, which the disposer discipline above exists to prevent.
 */
ipcRenderer.setMaxListeners(64);

/**
 * Subscribe to a main → renderer channel.
 *
 * Invokes the callback with the **payload only**, and returns a disposer that
 * removes exactly this listener. A surface that unmounts without unsubscribing
 * leaks a listener per mount/unmount cycle, and tab switching is frequent.
 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const bridge: HiveBridge = {
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke(CH.appInfo),
  config: {
    get: (): Promise<ConfigSnapshot> => ipcRenderer.invoke(CH.configGet),
    reload: (): Promise<ConfigSnapshot> => ipcRenderer.invoke(CH.configReload),
    // Story 101's mutating verbs. All `invoke`: the dialog needs its result,
    // and the other two return the fresh snapshot so the renderer never has to
    // follow a write with a reload.
    chooseDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke(CH.configChooseDirectory),
    addProject: (request: AddProjectRequest): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configAddProject, request),
    removeProject: (request: RemoveProjectRequest): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configRemoveProject, request),
    // Story 103. Like 101's verbs, each returns the fresh snapshot, so the
    // renderer never has to follow a write with a reload.
    renameProject: (request: RenameProjectRequest): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configRenameProject, request),
    repointProject: (request: RepointProjectRequest): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configRepointProject, request),
    reorderProjects: (
      request: ReorderProjectsRequest,
    ): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configReorderProjects, request),
    // Story 104. Two mutating verbs returning the fresh snapshot like the
    // rest, plus a read-only diagnostic that writes nothing.
    setRuntime: (request: SetRuntimeRequest): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configSetRuntime, request),
    setProjectRuntime: (
      request: SetProjectRuntimeRequest,
    ): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configSetProjectRuntime, request),
    diagnoseCommand: (
      request: DiagnoseCommandRequest,
    ): Promise<CommandDiagnostic> =>
      ipcRenderer.invoke(CH.configDiagnoseCommand, request),
    // Story 108. Read-only, like `diagnoseCommand` just above.
    diagnoseEnv: (request: DiagnoseEnvRequest): Promise<EnvDiagnostic> =>
      ipcRenderer.invoke(CH.configDiagnoseEnv, request),
    // Story 106. One more mutating verb, returning the fresh snapshot.
    setNotifications: (
      request: SetNotificationsRequest,
    ): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configSetNotifications, request),
    // HIVE-67. The site and the account email. The token is not a config value
    // and is deliberately on its own namespace below.
    setJira: (request: SetJiraRequest): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configSetJira, request),
    /*
      Story 107. Neither takes an argument — see the contract for why that is
      the security design and not an oversight. Written with no parameter list
      at all rather than one that is ignored, so a caller that tried to smuggle
      a path in cannot have it forwarded by a later careless edit.
    */
    revealConfig: (): Promise<void> => ipcRenderer.invoke(CH.configReveal),
    resetConfig: (): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configReset),
    // Story 102. `startClone` resolves on the pre-flight verdict, not on the
    // clone — the terminal streams in between and `onCloneDone` concludes it.
    startClone: (request: CloneRequest): Promise<CloneStartResult> =>
      ipcRenderer.invoke(CH.configCloneStart, request),
    cancelClone: (): Promise<void> => ipcRenderer.invoke(CH.configCloneCancel),
    onCloneDone: (callback: (event: CloneDoneEvent) => void) =>
      subscribe<CloneDoneEvent>(CH.configCloneDone, callback),
  },
  pty: {
    spawn: (request: SpawnRequest): Promise<void> =>
      ipcRenderer.invoke(CH.ptySpawn, request),
    // `send`, not `invoke`: keystrokes and resizes are fire-and-forget, and
    // awaiting a round-trip per keypress would put the main process in the
    // typing latency path.
    write: (request: WriteRequest): void => ipcRenderer.send(CH.ptyWrite, request),
    resize: (request: ResizeRequest): void =>
      ipcRenderer.send(CH.ptyResize, request),
    kill: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(CH.ptyKill, sessionId),
    // `send`: an ack is a report, not a question. Awaiting one would put the
    // main process in the path of the backpressure it is measuring.
    ack: (request: AckRequest): void => ipcRenderer.send(CH.ptyAck, request),
    onData: (callback: (event: DataEvent) => void) =>
      subscribe<DataEvent>(CH.ptyData, callback),
    onExit: (callback: (event: ExitEvent) => void) =>
      subscribe<ExitEvent>(CH.ptyExit, callback),
    onLost: (callback: (event: SessionLostEvent) => void) =>
      subscribe<SessionLostEvent>(CH.ptyLost, callback),
    restart: (request: SpawnRequest): Promise<void> =>
      ipcRenderer.invoke(CH.ptyRestart, request),
  },
  /*
    The project filesystem — the explorer and the editor.

    Pure forwarding, like everything else here: the preload adds no validation
    and makes no decisions. Every one of these takes a `projectId` and a
    relative path, never a path, so there is nothing here that could be widened
    by accident — a verb that accepted an absolute path would have to be written
    into the contract first, and that is where a reviewer would see it.
  */
  fs: {
    readDir: (request: ReadDirRequest): Promise<FsResult<DirEntry[]>> =>
      ipcRenderer.invoke(CH.fsReadDir, request),
    readFile: (
      request: ReadFileRequest,
    ): Promise<FsResult<FileContent | FsRefusal>> =>
      ipcRenderer.invoke(CH.fsReadFile, request),
    writeFile: (request: WriteFileRequest): Promise<WriteFileResult> =>
      ipcRenderer.invoke(CH.fsWriteFile, request),
    watch: (request: WatchRequest): Promise<void> =>
      ipcRenderer.invoke(CH.fsWatch, request),
    unwatch: (): Promise<void> => ipcRenderer.invoke(CH.fsUnwatch),
    onChanged: (callback: (event: FsChangedEvent) => void) =>
      subscribe<FsChangedEvent>(CH.fsChanged, callback),
  },
  // Story 106. `status` takes no argument — see the contract for why that is
  // the security design and not an oversight.
  integrations: {
    status: (): Promise<IntegrationsStatus> =>
      ipcRenderer.invoke(CH.integrationsStatus),
  },
  // One verb, no argument. Like `integrations.status`, the absent parameter
  // list is what makes a handler that executes a binary safe to expose.
  github: {
    prs: (): Promise<GhResult<PrsSnapshot>> => ipcRenderer.invoke(CH.githubPrs),
  },
  /*
    HIVE-67. Four verbs, and none of them returns a token — see the contract for
    why the count is the security design. `status`, `clearToken` and `test` take
    no argument at all; `setToken` takes the one payload in the whole bridge
    that carries a secret, and it only travels toward main.
  */
  jira: {
    status: (): Promise<JiraStatus> => ipcRenderer.invoke(CH.jiraStatus),
    setToken: (request: SetJiraTokenRequest): Promise<JiraStatus> =>
      ipcRenderer.invoke(CH.jiraSetToken, request),
    clearToken: (): Promise<JiraStatus> => ipcRenderer.invoke(CH.jiraClearToken),
    test: (): Promise<JiraResult<JiraIdentity>> =>
      ipcRenderer.invoke(CH.jiraTest),
    // HIVE-68. The first Jira verbs that carry a payload — a JQL string and an
    // issue key, both guarded in main before they reach a URL.
    search: (
      request: JiraSearchRequest,
    ): Promise<JiraResult<JiraSearchResult>> =>
      ipcRenderer.invoke(CH.jiraSearch, request),
    issue: (request: JiraIssueRequest): Promise<JiraResult<JiraIssue>> =>
      ipcRenderer.invoke(CH.jiraIssue, request),
    // HIVE-70. The read, and the epic's one write.
    transitions: (
      request: JiraTransitionsRequest,
    ): Promise<JiraResult<JiraTransition[]>> =>
      ipcRenderer.invoke(CH.jiraTransitions, request),
    applyTransition: (
      request: ApplyJiraTransitionRequest,
    ): Promise<JiraResult<JiraIssue>> =>
      ipcRenderer.invoke(CH.jiraApplyTransition, request),
    // HIVE-71. Two reads, and the one verb that sends free text.
    comments: (
      request: JiraConversationRequest,
    ): Promise<JiraResult<JiraComment[]>> =>
      ipcRenderer.invoke(CH.jiraComments, request),
    links: (
      request: JiraConversationRequest,
    ): Promise<JiraResult<JiraLink[]>> =>
      ipcRenderer.invoke(CH.jiraLinks, request),
    addComment: (
      request: AddJiraCommentRequest,
    ): Promise<JiraResult<JiraComment>> =>
      ipcRenderer.invoke(CH.jiraAddComment, request),
  },
  notifications: {
    onActivate: (callback: (event: NotificationActivateEvent) => void) =>
      subscribe<NotificationActivateEvent>(CH.notificationsActivate, callback),
    /** A notification was raised (HIVE-75). */
    onNew: (callback: (notification: HiveNotification) => void) =>
      subscribe<HiveNotification>(CH.notificationsNew, callback),
    /** The buffer main holds, newest first. Hydration on mount. */
    list: (): Promise<HiveNotification[]> =>
      ipcRenderer.invoke(CH.notificationsList) as Promise<HiveNotification[]>,
    /** Mark one read, or every one when `id` is null. */
    markRead: (id: string | null): Promise<void> =>
      ipcRenderer.invoke(CH.notificationsMarkRead, id) as Promise<void>,
    /** Drop one notification from the hub for good (HIVE-93). */
    dismiss: (id: string) =>
      ipcRenderer.invoke(CH.notificationsDismiss, id) as Promise<void>,
    /** The hub marked something read — including from a desktop toast click. */
    onRead: (callback: (event: NotificationReadEvent) => void) =>
      subscribe<NotificationReadEvent>(CH.notificationsRead, callback),
    /**
     * A notification left the buffer — including from a desktop toast click
     * (HIVE-81).
     */
    onDismissed: (callback: (event: NotificationDismissedEvent) => void) =>
      subscribe<NotificationDismissedEvent>(CH.notificationsDismissed, callback),
    /** Whether the OS is accepting notifications. Cheap — safe to poll. */
    delivery: (): Promise<NotificationDeliveryStatus> =>
      ipcRenderer.invoke(
        CH.notificationsDelivery,
      ) as Promise<NotificationDeliveryStatus>,
    /** Hand a clicked row's action back to main to carry out. */
    act: (action: NotificationAction): Promise<void> =>
      ipcRenderer.invoke(CH.notificationsAct, action) as Promise<void>,
  },
  updates: {
    status: (): Promise<UpdateStatus> =>
      ipcRenderer.invoke(CH.updatesStatus) as Promise<UpdateStatus>,
    check: (): Promise<void> =>
      ipcRenderer.invoke(CH.updatesCheck) as Promise<void>,
  },
  session: {
    onStatus: (callback: (event: SessionStatusEvent) => void) =>
      subscribe<SessionStatusEvent>(CH.sessionStatus, callback),
    onName: (callback: (event: SessionNameEvent) => void) =>
      subscribe<SessionNameEvent>(CH.sessionName, callback),
    onCleared: (callback: (event: SessionClearedEvent) => void) =>
      subscribe<SessionClearedEvent>(CH.sessionCleared, callback),
    onBranch: (callback: (event: SessionBranchEvent) => void) =>
      subscribe<SessionBranchEvent>(CH.sessionBranch, callback),
    onTicketIntent: (callback: (event: SessionTicketIntentEvent) => void) =>
      subscribe<SessionTicketIntentEvent>(CH.sessionTicketIntent, callback),
    onMetrics: (callback: (event: SessionMetricsEvent) => void) =>
      subscribe<SessionMetricsEvent>(CH.sessionMetrics, callback),
    // HIVE-87. The namespace's first two verbs — everything above is a
    // subscription. `history` is read once at boot; `note` carries the one fact
    // about a session that main cannot establish for itself.
    history: (): Promise<SessionRecord[]> =>
      ipcRenderer.invoke(CH.sessionHistory),
    note: (request: SessionNoteRequest): Promise<void> =>
      ipcRenderer.invoke(CH.sessionNote, request),
  },
  // HIVE-80. Neither verb takes a destination path — the dialog chooses it —
  // so this does not widen the bridge into a general file picker.
  theme: {
    pick: (): Promise<PickedTheme | null> => ipcRenderer.invoke(CH.themePick),
    save: (request: SaveThemeRequest): Promise<string | null> =>
      ipcRenderer.invoke(CH.themeSave, request),
  },
  // HIVE-81. `send`, not `invoke`: it fires on every tab switch and overlay
  // toggle and has no answer worth waiting for.
  ui: {
    reportForeground: (terminalId: string | null): void =>
      ipcRenderer.send(CH.uiForeground, {
        terminalId,
      } satisfies ForegroundReport),
  },
};

contextBridge.exposeInMainWorld('hive', bridge);
