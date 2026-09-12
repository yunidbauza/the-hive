import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';


import type {
  AgentLinesPush,
  AgentNameRequest,
  AgentRenameRequest,
  AgentRotateResult,
  AgentRunRequest,
  AgentRunResult,
  AgentsSnapshot,
  AgentStatus,
  AgentStatusPush,
  AgentWriteRequest,
  AgentWriteResult,
} from '@shared/agent-contract';
import type {
  AddProjectRequest,
  BrowseDirRequest,
  BrowseListing,
  CloneDoneEvent,
  CloneRequest,
  CloneStartResult,
  CommandDiagnostic,
  ConfigSnapshot,
  DeviceNameRequest,
  DiagnoseCommandRequest,
  DiagnoseEnvRequest,
  EnvDiagnostic,
  RemoveProjectRequest,
  RemotePairRequest,
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
  SetSessionPluginRequest,
  SetProjectAutoMergeRequest,
  SetProjectKeyRequest,
  SetProjectRuntimeRequest,
  SetReceiverRequest,
  SetRemoteRequest,
  SetRemoteResult,
  SetRuntimeRequest,
  SetServerRequest,
  SetSlackRequest,
  SetSlackTokensRequest,
} from '@shared/config-contract';
import type {
  DirEntry,
  FileContent,
  FsChangedEvent,
  FsRefusal,
  FsResult,
  ReadDirRequest,
  ReadFileRequest,
  RootInfo,
  RootRequest,
  SearchRequest,
  SearchResults,
  WatchRequest,
  WriteFileRequest,
  WriteFileResult,
} from '@shared/fs-contract';
import type { GhResult, PrRecord, PrsSnapshot } from '@shared/github-contract';
import {
  CH,
  type AckRequest,
  type AppInfo,
  type DataEvent,
  type ExitEvent,
  type ForegroundReport,
  type HiveBridge,
  type IntegrationsStatus,
  type LoginEnvStatus,
  type NotificationActivateEvent,
  type NotificationDeliveryStatus,
  type NotificationDismissedEvent,
  type NotificationReadEvent,
  type PromptReport,
  type RemoteLinkStatus,
  type ResizeRequest,
  type SessionLostEvent,
  type SessionNameReport,
  type SpawnRequest,
  type SpawnTerminalRequest,
  type WriteRequest,
  type LocalRemoteState,
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
import type {
  LedgerAnswerRequest,
  LedgerEntry,
  LedgerPostRequest,
  LedgerReadQuery,
  LedgerResult,
  LedgerSnapshot,
} from '@shared/ledger-contract';
import type { SessionMetricsEvent } from '@shared/metrics-contract';
import type {
  HiveNotification,
  NotificationAction,
} from '@shared/notification-contract';
import type {
  SessionBranchEvent,
  SessionClearedEvent,
  SessionFinishedEvent,
  SessionForegroundEvent,
  SessionReadyEvent,
  SessionNameEvent,
  SessionStatusEvent,
  SessionTerminalEndedEvent,
  SessionTicketIntentEvent,
} from '@shared/session-contract';
import type {
  SessionHistoryEntry,
  SessionNoteRequest,
  SessionPrRequest,
} from '@shared/session-history-contract';
import type {
  SkillDropRequest,
  SkillFile,
  SkillFileRead,
  SkillFileWriteRequest,
  SkillImportRequest,
  SkillMoveRequest,
  SkillNameRequest,
  SkillPathRequest,
  SkillRenameRequest,
  SkillWriteRequest,
  SkillsSnapshot,
} from '@shared/skills-contract';
import type {
  SlackSocketState,
  SlackSocketStatus,
  SlackSocketTestResult,
  SlackStatus,
  SlackTokensState,
} from '@shared/slack-contract';
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

/**
 * Paths the browser gave us, keyed by an id the renderer can hold (HIVE-148).
 *
 * `skills.fileDrop` has to reach real files, and the renderer must not be able
 * to name one. `webUtils.getPathForFile` answers only for a `File` the browser
 * itself produced from a drop and returns `''` for one the page constructed, so
 * preload is the only place a real path can appear. Keeping the path *here* and
 * handing out an opaque id means a renderer that invents an id gets nothing —
 * the difference between a bounded verb and a read-anywhere primitive.
 *
 * Entries are consumed on use, so an id is a one-shot ticket rather than a
 * durable handle to a file the user has since moved on from.
 */
const droppedPaths = new Map<string, string>();

/**
 * An id, from the **Web** Crypto global rather than `node:crypto`.
 *
 * This preload runs with `sandbox: true` (`electron/main/window.ts:176`), and a
 * sandboxed preload has no Node APIs at all. `import { randomUUID } from
 * 'node:crypto'` therefore throws while the module is still loading, which
 * takes down the *entire* bridge — every feature in the app, not just this one
 * — and leaves the renderer in its no-bridge browser-demo state with no error
 * anyone would connect to skills. It shipped that way once; the unit suites
 * could not see it, because they mock this module, and only the built app
 * shows it. `globalThis.crypto` is a browser global and is present.
 */
const mintId = (): string => globalThis.crypto.randomUUID();

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
    // HIVE-146. Directories only, never a file's contents, and every path it
    // returns has been contained under home by main before it leaves.
    browseDirectory: (
      request: BrowseDirRequest,
    ): Promise<FsResult<BrowseListing>> =>
      ipcRenderer.invoke(CH.configBrowseDirectory, request),
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
    // HIVE-94. The key is an alias, so this is a sibling of `renameProject`
    // rather than of anything that touches identity.
    setProjectKey: (request: SetProjectKeyRequest): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configSetProjectKey, request),
    // HIVE-166. A boolean on the entry, the way `key` is a string on it.
    setProjectAutoMerge: (request: SetProjectAutoMergeRequest): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configSetProjectAutoMerge, request),
    // HIVE-176. The whole list, as the Settings switches show it.
    setSessionPlugin: (
      request: SetSessionPluginRequest,
    ): Promise<ConfigSnapshot> => ipcRenderer.invoke(CH.configSetSessionPlugin, request),
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
    // HIVE-124. The socket-mode switch and the commander allow-list. The two
    // tokens are secrets and are on the `slack` namespace below, for the same
    // reason Jira's token is on its own.
    setSlack: (request: SetSlackRequest): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configSetSlack, request),
    // HIVE-131. The name a container resolves to reach this host.
    setReceiver: (request: SetReceiverRequest): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configSetReceiver, request),
    // HIVE-142. Whether server mode is on, and where it listens. No
    // credential here — pairing is the `server` namespace's job, below.
    setServer: (request: SetServerRequest): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configSetServer, request),
    // HIVE-144. Whether this window is a client and where it attaches. No
    // credential here either — storing one is the `remote` namespace's job,
    // below, and is a deliberately different verb from `server.pair` above:
    // that one mints a credential this machine hands out; this one stores
    // one this machine was handed.
    setRemote: (request: SetRemoteRequest): Promise<SetRemoteResult> =>
      ipcRenderer.invoke(CH.configSetRemote, request),
    /*
      HIVE-149. `setRemote`'s read half, and written with no parameter list at
      all for the reason `revealConfig` below is: nothing arrives from the
      renderer, so there is nothing a later careless edit could forward.

      It answers the question `get` above cannot while attached — that channel
      is proxied, so its `remote` block is the server's. The credential is not
      in the answer, because `RemoteConfig` has never held one.
    */
    getRemote: (): Promise<LocalRemoteState> => ipcRenderer.invoke(CH.configGetRemote),
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
  // HIVE-142. Pairing and revoking a device for server mode — its own
  // namespace because neither verb is an ordinary settings write; see the
  // contract for why.
  server: {
    pair: (
      request: DeviceNameRequest,
    ): Promise<{ token: string; deviceId: string } | { error: string }> =>
      ipcRenderer.invoke(CH.serverPair, request),
    revoke: (
      request: DeviceNameRequest,
    ): Promise<{ revoked: true } | { error: string }> =>
      ipcRenderer.invoke(CH.serverRevoke, request),
  },
  // HIVE-144. Storing and forgetting the credential this machine was handed
  // to attach outward, as a client, to someone else's server. Its own
  // namespace and not `server` above, on purpose: `server.pair`/`.revoke`
  // mint or destroy a credential this machine hands out to devices it
  // admits; `remote.pair`/`.forget` hold a credential this machine was
  // given, in the opposite direction. Two verbs named "pair" pointing
  // opposite ways would read as one feature — they are two.
  remote: {
    pair: (
      request: RemotePairRequest,
    ): Promise<{ paired: true } | { error: string }> =>
      ipcRenderer.invoke(CH.remotePair, request),
    forget: (): Promise<void> => ipcRenderer.invoke(CH.remoteForget),
    /**
     * What this window's attachment is doing (HIVE-150).
     *
     * A subscription rather than a read because the socket changes state on its
     * own — the same reason `slack.onSocketStatus` beside it is one.
     */
    onLinkStatus: (callback: (status: RemoteLinkStatus | null) => void) =>
      subscribe<RemoteLinkStatus | null>(CH.remoteLinkStatus, callback),
  },
  pty: {
    spawn: (request: SpawnRequest): Promise<void> =>
      ipcRenderer.invoke(CH.ptySpawn, request),
    spawnTerminal: (request: SpawnTerminalRequest): Promise<void> =>
      ipcRenderer.invoke(CH.ptySpawnTerminal, request),
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
    // `send`, for the same reason as `ack`: a report, never a round trip.
    prompt: (report: PromptReport): void => ipcRenderer.send(CH.ptyPrompt, report),
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
    root: (request: RootRequest): Promise<FsResult<RootInfo>> =>
      ipcRenderer.invoke(CH.fsRoot, request) as Promise<FsResult<RootInfo>>,
    readDir: (request: ReadDirRequest): Promise<FsResult<DirEntry[]>> =>
      ipcRenderer.invoke(CH.fsReadDir, request),
    readFile: (
      request: ReadFileRequest,
    ): Promise<FsResult<FileContent | FsRefusal>> =>
      ipcRenderer.invoke(CH.fsReadFile, request),
    writeFile: (request: WriteFileRequest): Promise<WriteFileResult> =>
      ipcRenderer.invoke(CH.fsWriteFile, request),
    search: (request: SearchRequest): Promise<FsResult<SearchResults>> =>
      ipcRenderer.invoke(CH.fsSearch, request),
    watch: (request: WatchRequest): Promise<void> =>
      ipcRenderer.invoke(CH.fsWatch, request),
    unwatch: (): Promise<void> => ipcRenderer.invoke(CH.fsUnwatch),
    onChanged: (callback: (event: FsChangedEvent) => void) =>
      subscribe<FsChangedEvent>(CH.fsChanged, callback),
  },
  /*
    HIVE-96, HIVE-99's `rename`, and HIVE-148's eight bundle verbs. The
    original five still name only a skill, never a path — `rename` names two
    of them, which is still none. The eight `file*` verbs carry a
    skill-relative path (`assertSkillPath`/`assertSkillDir` at the boundary,
    `resolveInSkill`'s `realpath` containment behind it), except `fileDrop`,
    whose `sources` are absolute — and the only reason that is safe is
    `pathToken` below, which is the one verb here that never touches IPC at
    all. See `skills-contract.ts` and `BRIDGE_SKILLS_KEYS` for the full
    argument. There is no `onChanged` here on purpose: the pane is the only
    writer, and every mutating verb answers with the fresh snapshot.
  */
  skills: {
    list: (): Promise<SkillsSnapshot> => ipcRenderer.invoke(CH.skillsList),
    read: (request: SkillNameRequest): Promise<SkillFile> =>
      ipcRenderer.invoke(CH.skillsRead, request),
    write: (request: SkillWriteRequest): Promise<SkillsSnapshot> =>
      ipcRenderer.invoke(CH.skillsWrite, request),
    remove: (request: SkillNameRequest): Promise<SkillsSnapshot> =>
      ipcRenderer.invoke(CH.skillsRemove, request),
    rename: (request: SkillRenameRequest): Promise<SkillsSnapshot> =>
      ipcRenderer.invoke(CH.skillsRename, request),
    /**
     * Mint an opaque, one-shot id for a `File` a real drop produced (HIVE-148).
     *
     * `webUtils.getPathForFile` answers a real path only for a `File` the
     * browser itself built from a drop, and `''` for one a web page
     * constructed — so this is the one place a real path can appear at all.
     * The path is kept in {@link droppedPaths} and never returned; only the id
     * crosses back to the renderer, which is what keeps `fileDrop` from being
     * a read-anywhere primitive.
     */
    pathToken: (file: File): string | null => {
      const path = webUtils.getPathForFile(file);
      if (path === '') return null;
      const id = mintId();
      droppedPaths.set(id, path);
      return id;
    },
    fileRead: (request: SkillPathRequest): Promise<SkillFileRead> =>
      ipcRenderer.invoke(CH.skillsFileRead, request),
    fileWrite: (request: SkillFileWriteRequest): Promise<SkillsSnapshot> =>
      ipcRenderer.invoke(CH.skillsFileWrite, request),
    fileMkdir: (request: SkillPathRequest): Promise<SkillsSnapshot> =>
      ipcRenderer.invoke(CH.skillsFileMkdir, request),
    fileRemove: (request: SkillPathRequest): Promise<SkillsSnapshot> =>
      ipcRenderer.invoke(CH.skillsFileRemove, request),
    fileMove: (request: SkillMoveRequest): Promise<SkillsSnapshot> =>
      ipcRenderer.invoke(CH.skillsFileMove, request),
    fileImport: (request: SkillImportRequest): Promise<SkillsSnapshot> =>
      ipcRenderer.invoke(CH.skillsFileImport, request),
    import: (): Promise<SkillsSnapshot> => ipcRenderer.invoke(CH.skillsImport),
    /**
     * Resolve each token back to the real path it was minted for, consuming
     * it, and only then call main (HIVE-148).
     *
     * A token that is not in the map — already consumed, or never minted —
     * is silently dropped rather than turned into a request-shaped hole: the
     * request main receives holds only paths this process actually vouches
     * for.
     */
    fileDrop: (request: { name: string; dir: string; tokens: string[] }): Promise<SkillsSnapshot> => {
      const sources: string[] = [];
      for (const token of request.tokens) {
        const path = droppedPaths.get(token);
        if (path === undefined) continue;
        droppedPaths.delete(token);
        sources.push(path);
      }
      /*
        Every token named was already consumed, or never minted. Invoking main
        with `sources: []` would answer with a fresh snapshot indistinguishable
        from a drop that actually copied something — refusing here, before the
        round trip, is what makes "nothing happened" visible rather than
        looking like success. A *partial* resolution still proceeds with
        whatever did resolve; this is only the case where none did.
      */
      if (sources.length === 0 && request.tokens.length > 0) {
        return Promise.reject(
          new Error('Nothing to drop — every file had already been used or was never received.'),
        );
      }
      return ipcRenderer.invoke(CH.skillsFileDrop, {
        name: request.name,
        dir: request.dir,
        sources,
      } satisfies SkillDropRequest);
    },
  },
  /*
    HIVE-114. The same five path-free verbs as `skills`, plus `onChanged` —
    which skills deliberately lack. The difference is that main is a second
    writer here: an AGENT.md is a file the user is invited to edit outside the
    app, so the pane cannot learn about every change from its own responses.

    `onChanged` carries no payload. The renderer is poked and re-`list`s, which
    keeps this listener incapable of leaking anything `list` would not already
    have handed over.
  */
  agents: {
    list: (): Promise<AgentsSnapshot> => ipcRenderer.invoke(CH.agentsList),
    read: (request: AgentNameRequest): Promise<string | null> =>
      ipcRenderer.invoke(CH.agentsRead, request),
    write: (request: AgentWriteRequest): Promise<AgentWriteResult> =>
      ipcRenderer.invoke(CH.agentsWrite, request),
    remove: (request: AgentNameRequest): Promise<void> =>
      ipcRenderer.invoke(CH.agentsRemove, request),
    rename: (request: AgentRenameRequest): Promise<AgentWriteResult> =>
      ipcRenderer.invoke(CH.agentsRename, request),
    onChanged: (callback: () => void) =>
      subscribe<undefined>(CH.agentsChanged, () => {
        callback();
      }),
    /*
      HIVE-115's two verbs, and the first in this namespace that start and stop
      a process rather than move bytes. `kill` takes a name and nothing else;
      `run` takes a name and, since HIVE-126, optional prose saying *why* a
      person pressed it. Still no flags, no environment and no argv the page
      composed: `extra` is interpolated into the single positional prompt
      argument, so the whole of what the page can express here is which agent
      and what to tell it. `BRIDGE_AGENTS_KEYS` carries the argument;
      `parseAgentRunRequest` is what refuses a payload that tries to say more —
      a `trigger` above all.
    */
    run: (request: AgentRunRequest): Promise<AgentRunResult> =>
      ipcRenderer.invoke(CH.agentsRun, request),
    kill: (request: AgentNameRequest): Promise<boolean> =>
      ipcRenderer.invoke(CH.agentsKill, request),
    /*
      HIVE-117's two, and the narrowest verbs here: they set one field and start
      nothing. They take the same `AgentNameRequest` as `kill`, so the same
      guard refuses the same payloads, and they answer the status now in force
      rather than a boolean — `resume` has two honest answers.
    */
    pause: (request: AgentNameRequest): Promise<AgentStatus> =>
      ipcRenderer.invoke(CH.agentsPause, request),
    resume: (request: AgentNameRequest): Promise<AgentStatus> =>
      ipcRenderer.invoke(CH.agentsResume, request),
    /*
      HIVE-122's, and `run`'s twin: a name, no argv, no flags. It answers an
      `AgentRunResult` because it *is* a run — one field armed first, then the
      ordinary path — and it takes an `AgentNameRequest` rather than a widened
      `AgentRunRequest`, so the closed key set that refuses a renderer-chosen
      trigger stays closed. `BRIDGE_AGENTS_KEYS` carries the argument.
    */
    rotate: (request: AgentNameRequest): Promise<AgentRotateResult> =>
      ipcRenderer.invoke(CH.agentsRotate, request),
    onStatus: (callback: (push: AgentStatusPush) => void) =>
      subscribe<AgentStatusPush>(CH.agentsStatus, callback),
    onLines: (callback: (push: AgentLinesPush) => void) =>
      subscribe<AgentLinesPush>(CH.agentsLines, callback),
  },
  // Story 106. `status` takes no argument — see the contract for why that is
  // the security design and not an oversight.
  integrations: {
    status: (): Promise<IntegrationsStatus> =>
      ipcRenderer.invoke(CH.integrationsStatus),
    // The environment half on its own, for the pane that needs it without
    // needing `gh`. See the contract for why it is a verb rather than a field.
    loginEnv: (): Promise<LoginEnvStatus> =>
      ipcRenderer.invoke(CH.integrationsLoginEnv),
  },
  // One verb, no argument. Like `integrations.status`, the absent parameter
  // list is what makes a handler that executes a binary safe to expose.
  github: {
    prs: (): Promise<GhResult<PrsSnapshot>> => ipcRenderer.invoke(CH.githubPrs),
    /** PRs matching a term, whoever wrote them. See `CH.githubSearchPrs`. */
    searchPrs: (term: string, projectId?: string): Promise<GhResult<PrRecord[]>> =>
      ipcRenderer.invoke(CH.githubSearchPrs, { term, projectId }) as Promise<
        GhResult<PrRecord[]>
      >,
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
  /*
    HIVE-123. Four verbs, none of them returning a credential — see the
    contract for why that is a stronger guarantee than Jira's own. Every one
    of them takes no argument at all, which is what makes a call that spawns
    `claude` safe to expose: there is no argv for a compromised renderer to
    reach.
  */
  slack: {
    status: (): Promise<SlackStatus> => ipcRenderer.invoke(CH.slackStatus),
    signIn: (): Promise<SlackStatus> => ipcRenderer.invoke(CH.slackSignIn),
    signOut: (): Promise<SlackStatus> => ipcRenderer.invoke(CH.slackSignOut),
    test: (): Promise<SlackStatus> => ipcRenderer.invoke(CH.slackTest),
    /*
      HIVE-124. Socket mode's own five: two writes of a secret, one no-argument
      test, one mount-time read of presence and status, and a subscription.
      There is still no verb that returns a token — every one of them answers
      with presence alone, and `SlackTokens.read()` has no channel at all.
    */
    setTokens: (request: SetSlackTokensRequest): Promise<SlackTokensState> =>
      ipcRenderer.invoke(CH.slackSetTokens, request),
    clearTokens: (): Promise<SlackTokensState> =>
      ipcRenderer.invoke(CH.slackClearTokens),
    socketTest: (): Promise<SlackSocketTestResult> =>
      ipcRenderer.invoke(CH.slackSocketTest),
    socketState: (): Promise<SlackSocketState> =>
      ipcRenderer.invoke(CH.slackSocketState),
    onSocketStatus: (callback: (status: SlackSocketStatus) => void) =>
      subscribe<SlackSocketStatus>(CH.slackSocketStatus, callback),
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
    /** Empty the inbox. Deliberately not `dismiss(null)` — see the channel. */
    clear: (): Promise<void> =>
      ipcRenderer.invoke(CH.notificationsClear) as Promise<void>,
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
    /** This window's unread count, for this machine's dock (HIVE-159). */
    badge: (count: number): Promise<void> =>
      ipcRenderer.invoke(CH.notificationsBadge, count) as Promise<void>,
  },
  ledger: {
    /** The log main holds. Hydration on mount. */
    list: (query?: LedgerReadQuery): Promise<LedgerSnapshot> =>
      ipcRenderer.invoke(CH.ledgerList, query ?? {}) as Promise<LedgerSnapshot>,
    /** The overmind writes; main supplies `from`. */
    post: (request: Omit<LedgerPostRequest, 'from'>): Promise<LedgerResult> =>
      ipcRenderer.invoke(CH.ledgerPost, request) as Promise<LedgerResult>,
    /** Close a thread, by canonical id or short ref. */
    answer: (request: LedgerAnswerRequest): Promise<LedgerResult> =>
      ipcRenderer.invoke(CH.ledgerAnswer, request) as Promise<LedgerResult>,
    /** One entry landed, from any party. */
    onChanged: (callback: (entry: LedgerEntry) => void) =>
      subscribe<LedgerEntry>(CH.ledgerChanged, callback),
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
    onFinished: (callback: (event: SessionFinishedEvent) => void) =>
      subscribe<SessionFinishedEvent>(CH.sessionFinished, callback),
    onReady: (callback: (event: SessionReadyEvent) => void) =>
      subscribe<SessionReadyEvent>(CH.sessionReady, callback),
    onBranch: (callback: (event: SessionBranchEvent) => void) =>
      subscribe<SessionBranchEvent>(CH.sessionBranch, callback),
    onTicketIntent: (callback: (event: SessionTicketIntentEvent) => void) =>
      subscribe<SessionTicketIntentEvent>(CH.sessionTicketIntent, callback),
    onMetrics: (callback: (event: SessionMetricsEvent) => void) =>
      subscribe<SessionMetricsEvent>(CH.sessionMetrics, callback),
    onForeground: (callback: (event: SessionForegroundEvent) => void) =>
      subscribe<SessionForegroundEvent>(CH.sessionForeground, callback),
    onTerminalEnded: (callback: (event: SessionTerminalEndedEvent) => void) =>
      subscribe<SessionTerminalEndedEvent>(CH.sessionTerminalEnded, callback),
    // HIVE-87. The namespace's first invoking verbs — everything above is a
    // subscription. `history` is read once at boot; `note` and `pr` carry the
    // two facts about a session that main cannot establish for itself.
    history: (): Promise<SessionHistoryEntry[]> =>
      ipcRenderer.invoke(CH.sessionHistory),
    note: (request: SessionNoteRequest): Promise<void> =>
      ipcRenderer.invoke(CH.sessionNote, request),
    pr: (request: SessionPrRequest): Promise<void> =>
      ipcRenderer.invoke(CH.sessionPr, request),
  },
  // HIVE-81. `send`, not `invoke`: it fires on every tab switch and overlay
  // toggle and has no answer worth waiting for.
  ui: {
    reportForeground: (terminalId: string | null): void =>
      ipcRenderer.send(CH.uiForeground, {
        terminalId,
      } satisfies ForegroundReport),
    // HIVE-110. The name the rail shows, so a desktop toast can say it too.
    // `send` for the same reason: a rename has no answer worth waiting for.
    reportSessionName: (terminalId: string, name: string): void =>
      ipcRenderer.send(CH.uiSessionName, {
        terminalId,
        name,
      } satisfies SessionNameReport),
  },
};

contextBridge.exposeInMainWorld('hive', bridge);
