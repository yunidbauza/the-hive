/**
 * The IPC contract — the single source of truth for channel names and payload
 * shapes (story 082).
 *
 * This module is the ONE thing both processes may import, which is what makes
 * the contract a compile-time artifact instead of a convention: a renamed
 * channel or a changed payload is a type error on both sides rather than a
 * runtime silence.
 *
 * It is therefore **types and constants only**. No runtime imports, no Node
 * APIs, no DOM APIs — anything else here would drag main-process code into the
 * renderer bundle, which the ESLint zones exist to prevent.
 *
 * The PTY channels are declared here but **not implemented in this story**.
 * Story 093 owns their handlers and their flow control. This story ships the
 * bridge, its security properties, and `app:info` as the one working channel
 * that proves the whole path.
 */

import type {
  AddProjectRequest,
  CloneDoneEvent,
  CloneRequest,
  CloneStartResult,
  CommandDiagnostic,
  ConfigSnapshot,
  DiagnoseCommandRequest,
  PathProbe,
  RemoveProjectRequest,
  RenameProjectRequest,
  ReorderProjectsRequest,
  JiraIssueRequest,
  JiraSearchRequest,
  RepointProjectRequest,
  SetJiraRequest,
  SetJiraTokenRequest,
  SetNotificationsRequest,
  SetProjectRuntimeRequest,
  SetRuntimeRequest,
} from './config-contract';
import type {
  JiraIdentity,
  JiraIssue,
  JiraResult,
  JiraSearchResult,
  JiraStatus,
} from './jira-contract';
import type {
  SessionEffort,
  SessionModel,
  SessionNameEvent,
  SessionStatusEvent,
} from './session-contract';

export const CH = {
  configGet: 'config:get',
  configReload: 'config:reload',
  /** Story 101's three mutating channels. All `invoke` — each needs a result. */
  configChooseDirectory: 'config:choose-directory',
  configAddProject: 'config:add-project',
  configRemoveProject: 'config:remove-project',
  /**
   * Story 103's three mutating channels. All `invoke` — each returns the fresh
   * snapshot, so the renderer never follows a write with a reload.
   */
  configRenameProject: 'config:rename-project',
  configRepointProject: 'config:repoint-project',
  configReorderProjects: 'config:reorder-projects',
  /**
   * Story 102's clone verbs.
   *
   * `start` and `cancel` are `invoke` — start needs its pre-flight verdict, and
   * cancel is awaited so the view can disable its own button. `done` is a push:
   * a clone concludes long after the call that started it returned.
   *
   * See `CloneRequest` for why none of them takes a destination path.
   */
  /**
   * Story 104's runtime channels.
   *
   * Two mutating verbs returning `ConfigSnapshot` like every other, plus one
   * read-only diagnostic that writes nothing and so does not go through the
   * write path at all.
   */
  configSetRuntime: 'config:set-runtime',
  configSetProjectRuntime: 'config:set-project-runtime',
  configDiagnoseCommand: 'config:diagnose-command',
  /**
   * Story 106's channels.
   *
   * One mutating verb returning `ConfigSnapshot` like every other; one
   * read-only status that takes **no payload at all**, which is its security
   * design rather than an omission — with nothing arriving from the renderer
   * there is no argv to inject into; and one main → renderer event naming the
   * session a clicked notification was about.
   */
  configSetNotifications: 'config:set-notifications',
  /**
   * Story 107's two verbs. Both `invoke`, and both take **no payload at all**.
   *
   * That is the whole security design rather than an omission, and it is the
   * same one story 106's `integrations:status` uses: with nothing arriving from
   * the renderer there is no payload guard to write and nothing to inject into.
   * Main resolves the target from its own `configPath()` in both cases, so a
   * compromised renderer cannot aim either verb at a file main did not choose.
   * The epic's rule is that no verb takes a destination path; taking no
   * argument at all is strictly stronger.
   *
   * `reveal` returns nothing — showing a file in the OS file manager has no
   * verdict to report. `reset` returns the fresh snapshot, like every other
   * mutating verb.
   */
  configReveal: 'config:reveal',
  configReset: 'config:reset',
  integrationsStatus: 'integrations:status',
  /**
   * The Jira connection settings (HIVE-67).
   *
   * A `config:` channel rather than a `jira:` one because it writes the config
   * file and returns the fresh snapshot, exactly like every other settings
   * verb. Only the *credential* needs a namespace of its own, because it is the
   * one part that does not live in that file.
   */
  configSetJira: 'config:set-jira',
  /**
   * The Jira credential and the connection test (HIVE-67).
   *
   * Four verbs, and the count is the security design: the renderer may write a
   * token and clear one, and there is **no verb that returns one**. A user who
   * wants to read their token looks at Atlassian, which is correct.
   */
  jiraStatus: 'jira:status',
  jiraSetToken: 'jira:set-token',
  jiraClearToken: 'jira:clear-token',
  jiraTest: 'jira:test',
  /**
   * The Jira read verbs (HIVE-68).
   *
   * Both take a payload, which is what makes them the first Jira channels with
   * anything to guard: a JQL string and an issue key both arrive from the
   * renderer. `jiraSearch`'s query goes into one URL-encoded parameter and is
   * never parsed; `jiraIssue`'s key is matched against a pattern before it
   * reaches a URL path, because that one is interpolated.
   */
  jiraSearch: 'jira:search',
  jiraIssue: 'jira:issue',
  notificationsActivate: 'notifications:activate', // main → renderer
  configCloneStart: 'config:clone-start',
  configCloneCancel: 'config:clone-cancel',
  configCloneDone: 'config:clone-done', // main → renderer
  ptySpawn: 'pty:spawn',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  /**
   * The ack half of the flow-control loop (story 093).
   *
   * Renderer → main, `send` rather than `invoke`: an ack is a report, not a
   * question, and awaiting one would put the main process in the path of the
   * very backpressure it is measuring.
   */
  ptyAck: 'pty:ack',
  ptyData: 'pty:data', // main → renderer, stream
  ptyExit: 'pty:exit', // main → renderer
  /**
   * A session that stopped existing without its process exiting (story 094).
   *
   * Distinct from {@link CH.ptyExit} because the two mean different things to
   * the user and must read differently in the transcript. An exit is the
   * process finishing — there is a code, and it is information. A *lost*
   * session is the host dying underneath a process that may well still have
   * been working: there is no code, nothing was concluded, and the only honest
   * thing to say is that the terminal no longer knows.
   *
   * Story 093 logged these in main and forwarded nothing, because no renderer
   * channel existed. This is that channel.
   */
  ptyLost: 'pty:lost', // main → renderer
  /** Kill, wait for the exit, spawn fresh, bootstrap again (story 096). */
  ptyRestart: 'pty:restart',
  /**
   * What a real session is doing, derived in main (story 096).
   *
   * Derived in main and not the renderer because the input is a firehose: a
   * per-chunk store write would re-render the shell continuously, which is
   * exactly what the store split exists to prevent. One `working`, then one
   * `idle` two seconds after the output stops.
   */
  sessionStatus: 'session:status', // main → renderer
  /**
   * What a session now calls itself (HIVE-61).
   *
   * Separate from `session:status` because the two are independent: a rename is
   * rare and user-driven, a status change is frequent and machine-driven, and
   * folding them together would make every status tick carry a name main did
   * not observe on that tick.
   */
  sessionName: 'session:name', // main → renderer
  appInfo: 'app:info',
} as const;

export type Channel = (typeof CH)[keyof typeof CH];

/**
 * The channels main may push to the renderer.
 *
 * A closed set, deliberately. An alternative design — one channel per session
 * (`pty:data:<id>`) — is rejected because it makes the channel set *dynamic*,
 * which is precisely what an allowlist cannot be.
 */
export const EVENT_CHANNELS = [
  CH.ptyData,
  CH.ptyExit,
  CH.ptyLost,
  CH.sessionStatus,
  CH.sessionName,
  CH.configCloneDone,
  CH.notificationsActivate,
] as const;
export type EventChannel = (typeof EVENT_CHANNELS)[number];

export interface SpawnRequest {
  sessionId: string;
  projectId: string;
  cols: number;
  rows: number;
  /**
   * The first thing to say to this session, once its TUI is up (story 097).
   *
   * Optional because most spawns have nothing to say — a session opened from
   * the picker starts at a prompt and waits for its user. It is delivered by
   * main's bootstrap rather than by the renderer, which has no signal for "the
   * TUI is ready" and by design cannot have one: `session:status` carries
   * `working | idle | done` and nothing finer.
   */
  task?: string;
  /**
   * What to start `claude` *as* (story 109).
   *
   * Both optional, and absent means "say nothing" rather than "use the
   * default": a spawn that names neither produces the bare command it always
   * did, and `claude` applies whatever the user's own configuration says. That
   * matters for the sessions nobody picked a model for — a fixture opened for
   * the first time, a `spawn` typed into the console — where inventing a flag
   * would silently override a setting the user made outside this app.
   *
   * Unlike {@link SpawnRequest.task} these **are** forwarded on a restart. A
   * task is an instruction the previous generation may already have acted on;
   * a model is a property of the session itself, and restarting a session as a
   * different model than the one its row advertises is not a restart.
   */
  model?: SessionModel;
  effort?: SessionEffort;
}

export interface WriteRequest {
  sessionId: string;
  data: string;
}

export interface ResizeRequest {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface DataEvent {
  sessionId: string;
  chunk: string;
  /**
   * Monotonic per session (story 093).
   *
   * The renderer asserts monotonicity and, on a gap, writes a notice into the
   * transcript rather than silently rendering a corrupted stream. A terminal
   * that quietly drops a batch shows output that never existed in that order,
   * and the user debugs the wrong thing.
   *
   * The notice itself lives in `src/lib/terminal/pty-transport.ts`, not here.
   * Story 093 declared it in this file as a literal SGR string because no
   * renderer-side consumer existed yet; now that one does, the text is built
   * from `TERM` like every other colour the terminal shows — which is the rule
   * this file was quietly the one exception to.
   */
  seq: number;
}

/**
 * The renderer reporting that it has *parsed* everything up to `seq`.
 *
 * The critical detail of the whole design: this is sent from xterm's
 * `write` callback, **not** on receipt. `xterm.write` is asynchronous and its
 * callback fires once the chunk is in the buffer. Acking on arrival measures
 * the IPC channel and learns nothing about whether the terminal is keeping up,
 * which is the entire question.
 */
export interface AckRequest {
  sessionId: string;
  seq: number;
}

export interface ExitEvent {
  sessionId: string;
  exitCode: number;
  /**
   * The signal that killed the process, as a **number** — `15`, not
   * `'SIGTERM'`.
   *
   * `node-pty` reports the raw signal number and it is carried through
   * unchanged, because main is not the layer that should be picking names for
   * things. The renderer maps it for display (`src/lib/terminal/signals.ts`).
   *
   * **`0` means no signal**, and it is what an ordinary exit reports — the
   * field is far more often zero than absent. A consumer that treats only
   * `undefined` as "not signalled" will describe every clean exit as a
   * termination.
   */
  signal?: number;
}

/**
 * A session whose host died (story 094).
 *
 * `reason` is a closed union rather than a free-text string: it is rendered
 * into a terminal, and a message the renderer cannot exhaustively switch on is
 * a message that eventually reaches the user as raw main-process prose.
 */
export interface SessionLostEvent {
  sessionId: string;
  reason: 'host-crashed';
}

/**
 * Where a GitHub token would come from, if anything asked for one (story 106).
 *
 * Reported, never stored. The PR panel is fixture-backed today — nothing in
 * this app fetches from GitHub — so a token persisted here would be a
 * credential no code reads, sitting in a plaintext file the product actively
 * encourages hand-editing. What is useful *now* is the answer to "which source
 * would be used", which is the thing users get wrong and the same answer the
 * future real-PR story needs.
 */
export type GhTokenSource = 'keyring' | 'env' | 'none';

/** What this machine's `gh` install looks like from here (story 106). */
export interface GhStatus {
  /** An executable `gh` was found on the `PATH` a session would search. */
  installed: boolean;
  /** Absolute path to it, or `null`. This exact path is what gets executed. */
  resolved: string | null;
  /** The `PATH` that was consulted — for a GUI app this is launchd's. */
  path: string;
  /** Every directory looked in, so "not found" can explain itself. */
  probes: PathProbe[];
  /** As reported by `gh --version`, or `null` if it could not be read. */
  version: string | null;
  /** `gh` reports a logged-in account. */
  authenticated: boolean;
  /** The login `gh` reports, or `null`. Never a token, never raw output. */
  account: string | null;
  tokenSource: GhTokenSource;
  /** Which variable supplied it, when `tokenSource` is `env`. */
  envVar: 'GH_TOKEN' | 'GITHUB_TOKEN' | null;
  /**
   * `gh` ran and failed in a way that is not an answer — a timeout, or output
   * that could not be read. Not-installed and not-logged-in are **ordinary
   * answers**, not errors: a settings pane that reports a failure because a
   * tool is missing tells the user the app is broken when the tool is what is
   * missing.
   */
  error: string | null;
}

/**
 * Answer to {@link CH.integrationsStatus}.
 *
 * Both facts in one round trip because the section needs both on open, and two
 * verbs would paint the pane twice.
 */
export interface IntegrationsStatus {
  gh: GhStatus;
  /**
   * `Notification.isSupported()`. False on a Linux box with no notification
   * daemon, where the switches must be replaced by an explanation rather than
   * left as controls that quietly do nothing.
   */
  notificationsSupported: boolean;
}

/** A clicked notification, naming the session it was about (story 106). */
export interface NotificationActivateEvent {
  /** The *entity* id, matching {@link SessionStatusEvent}. */
  entityId: string;
}

/** Answer to {@link CH.appInfo} — proves the bridge round-trips. */
export interface AppInfo {
  /** The app version, from `package.json` via Electron. */
  version: string;
  /** Electron's runtime versions, for the About box and bug reports. */
  electron: string;
  chrome: string;
  node: string;
  /** `process.platform`, so the renderer can reason about chrome differences. */
  platform: string;
  /**
   * Electron's log directory (story 107).
   *
   * Reported, **not written to**. This app writes no log file — main logs to
   * stdout with a `[hive]` prefix — and the Advanced pane says exactly that
   * next to this path. It lives here rather than behind a verb of its own
   * because `AppInfo` already exists "for the About box and bug reports", and
   * this is the same kind of fact as {@link AppInfo.electron}.
   *
   * A real log file — a sink, rotation, a decision about what every
   * `console.error` in main becomes — is a logging feature that a diagnostics
   * pane would then report on, and it is deliberately out of story 107. A
   * "Reveal logs" button that opened an empty directory while implying the app
   * had written to it would answer the user's question wrongly rather than not
   * answering it, so no such button ships and this stays text.
   */
  logPath: string;
  /**
   * Per-session flow-control counters (story 093).
   *
   * Flow-control bugs are otherwise diagnosed by staring at a slow terminal
   * and guessing. Absent when no session has ever run.
   */
  pty?: PtyDiagnostics[];
}

/** What the diagnostics counter set records for one session. */
export interface PtyDiagnostics {
  sessionId: string;
  /** Bytes received from the pty host. */
  bytesIn: number;
  /** Bytes the renderer has confirmed it parsed. */
  bytesAcked: number;
  /** Bytes sent but not yet acked — the number the water marks compare. */
  unacked: number;
  /** How many times the pty was paused for being too far ahead. */
  pauses: number;
  /** IPC messages sent. `bytesIn / batches` is the coalescing ratio. */
  batches: number;
  /** Messages dropped for an unknown or exited session. */
  dropped: number;
  paused: boolean;
}

/**
 * The shape `contextBridge` exposes as `window.hive`.
 *
 * Declared here so the preload implementation, the renderer's ambient type
 * (`src/types/hive-bridge.d.ts`, story 083) and the bridge's own surface test
 * all agree by construction. Widening the bridge means editing this type,
 * which is exactly the deliberate act the design is trying to force.
 */
export interface HiveBridge {
  appInfo(): Promise<AppInfo>;
  /**
   * The workspace config (stories 090, 101).
   *
   * No longer read-only. Story 090's comment here said there was no `set`
   * "because a settings UI that writes this file is out of scope and a bridge
   * verb that can write to disk is not something to add speculatively". Story
   * 101 is that settings UI: the reasoning was sound and the condition
   * changed, so the comment is rewritten rather than deleted.
   *
   * What bounds the widening, and what a reviewer should check any future verb
   * here against:
   *
   * - The bridge can write to **exactly one file** — the config. No verb
   *   accepts a destination path, and none ever should.
   * - Every path arriving from the renderer is **re-validated in main from
   *   scratch** — expanded, made absolute, `realpath`'d, confirmed to be a
   *   directory — exactly as a path arriving from the file is.
   * - `chooseDirectory` is a UX step, not a capability grant. A renderer that
   *   skips the dialog and posts a path directly gets identical treatment,
   *   because main's validation is the actual gate either way.
   *
   * Every mutating verb returns the fresh snapshot, so the renderer never has
   * to follow a write with a reload and can never render a stale list.
   */
  config: {
    get(): Promise<ConfigSnapshot>;
    reload(): Promise<ConfigSnapshot>;
    /** Native directory dialog, owned by main. Resolves null when cancelled. */
    chooseDirectory(): Promise<string | null>;
    addProject(request: AddProjectRequest): Promise<ConfigSnapshot>;
    removeProject(request: RemoveProjectRequest): Promise<ConfigSnapshot>;
    /** Change a project's display name (story 103). The id is never touched. */
    renameProject(request: RenameProjectRequest): Promise<ConfigSnapshot>;
    /**
     * Point a project at a folder that moved (story 103).
     *
     * The path comes from {@link HiveBridge.config.chooseDirectory}, and main
     * re-validates it from scratch — the dialog is a UX step, not a capability
     * grant.
     */
    repointProject(request: RepointProjectRequest): Promise<ConfigSnapshot>;
    /**
     * Rewrite the whole project order (story 103).
     *
     * Refused unless the ids are a permutation of the file on disk, so an
     * ordering built before a hand edit cannot drop or resurrect a project.
     */
    reorderProjects(request: ReorderProjectsRequest): Promise<ConfigSnapshot>;
    /**
     * Change the top-level shell or agent command (story 104).
     *
     * Only the fields named are touched, so saving one cannot restate the
     * other. Neither can be cleared — there is no lower level to inherit from.
     */
    setRuntime(request: SetRuntimeRequest): Promise<ConfigSnapshot>;
    /**
     * Change one project's overrides (story 104).
     *
     * `null` removes an override so the project inherits the top level again;
     * an absent field is left untouched. Storing `""` instead of removing would
     * spawn a shell named `""`.
     */
    setProjectRuntime(request: SetProjectRuntimeRequest): Promise<ConfigSnapshot>;
    /**
     * Explain where the agent command was looked for (story 104).
     *
     * Read-only. Answers the question the epic actually poses — why `claude`
     * "is installed" and still not found — by reporting the `PATH` a session
     * would really search, which for a GUI app is launchd's, not the login
     * shell's.
     */
    diagnoseCommand(request: DiagnoseCommandRequest): Promise<CommandDiagnostic>;
    /**
     * Change which events raise an OS notification (story 106).
     *
     * Only the classes named are touched. Off is a value, not an absence, so
     * there is no clearing case: a preference has no lower level to inherit
     * from.
     */
    setNotifications(request: SetNotificationsRequest): Promise<ConfigSnapshot>;
    /**
     * Change the Jira site and account email (HIVE-67).
     *
     * `null` clears a field; an absent field is untouched. The API token is
     * deliberately **not** here — it is a secret, and it goes through
     * {@link HiveBridge.jira.setToken} into `safeStorage`. Keeping the two on
     * separate verbs is what stops a credential from ever having a path into a
     * file the product invites the user to hand-edit.
     */
    setJira(request: SetJiraRequest): Promise<ConfigSnapshot>;
    /**
     * Show the config file in the OS file manager (story 107).
     *
     * Takes no argument: main reveals its own `configPath()`. *Reveal* rather
     * than *open* — it selects the file in a folder window instead of launching
     * whatever application has claimed `.json`, which on a developer's machine
     * is as likely to be a browser as an editor.
     */
    revealConfig(): Promise<void>;
    /**
     * Put the config file back to the first-run template (story 107).
     *
     * The one write that does not preserve unknown keys or the user's comments,
     * which is what "reset" means. Takes no argument; the confirmation is the
     * renderer's, and main refuses if there is no file to read rather than
     * recreating one.
     */
    resetConfig(): Promise<ConfigSnapshot>;
    /**
     * Start a clone (story 102).
     *
     * Resolves once `git` is running, **not** once it has finished — the
     * terminal streams in between, and completion arrives on
     * {@link HiveBridge.config.onCloneDone}.
     */
    startClone(request: CloneRequest): Promise<CloneStartResult>;
    /** Kill a running clone and remove the directory it had created. */
    cancelClone(): Promise<void>;
    /** Returns its own unsubscribe. Callers MUST invoke it on unmount. */
    onCloneDone(callback: (event: CloneDoneEvent) => void): () => void;
  };
  pty: {
    spawn(request: SpawnRequest): Promise<void>;
    write(request: WriteRequest): void;
    resize(request: ResizeRequest): void;
    kill(sessionId: string): Promise<void>;
    /** Report progress so main can apply backpressure. See {@link AckRequest}. */
    ack(request: AckRequest): void;
    /** Returns its own unsubscribe. Callers MUST invoke it on unmount. */
    onData(callback: (event: DataEvent) => void): () => void;
    onExit(callback: (event: ExitEvent) => void): () => void;
    /** The host died under this session (story 094). See {@link SessionLostEvent}. */
    onLost(callback: (event: SessionLostEvent) => void): () => void;
    /**
     * Kill this session and start a fresh one (story 096).
     *
     * A capability, not a listener — and deliberately explicit. Nothing
     * auto-respawns: the transport keeps its "already requested" flag set even
     * after an exit, so a remount can never restart a finished agent. This verb
     * is the only way back, and it is a thing the user chose to do.
     */
    restart(request: SpawnRequest): Promise<void>;
  };
  /**
   * External tooling this app can see but does not own (story 106).
   *
   * Read-only, and `status()` takes no arguments at all. That is the whole
   * security story for a verb that executes a binary: with nothing arriving
   * from the renderer, there is no argv to inject into and nothing to guard.
   */
  integrations: {
    status(): Promise<IntegrationsStatus>;
  };
  /**
   * Jira (HIVE-67).
   *
   * Read the credential *state*, write a token, clear one, and test the
   * connection. **There is no verb that returns a token**, and adding one would
   * be a deliberate widening of what a web page can extract from this machine
   * rather than an incremental convenience.
   *
   * `test` is the only verb here that causes a network request, and it takes no
   * argument: the host comes from the config. That bounds *this* verb, not the
   * renderer — `config.setJira` is how the settings pane sets the site, so the
   * renderer can still change which host the next `test` reaches. It is not a
   * new capability (the same bridge already grants a login shell through
   * `pty.write`), and it is the feature: a user has to be able to type their
   * own site.
   */
  jira: {
    status(): Promise<JiraStatus>;
    setToken(request: SetJiraTokenRequest): Promise<JiraStatus>;
    clearToken(): Promise<JiraStatus>;
    test(): Promise<JiraResult<JiraIdentity>>;
    /**
     * Run a JQL query (HIVE-68).
     *
     * `jql` is optional; absent means the default query. The result carries
     * only mapped, named fields — never a raw Jira payload — and `capped` says
     * when the 200-issue limit stopped paging while Jira still had more.
     */
    search(request: JiraSearchRequest): Promise<JiraResult<JiraSearchResult>>;
    /** Read one issue by key (HIVE-68). The key is pattern-matched in main. */
    issue(request: JiraIssueRequest): Promise<JiraResult<JiraIssue>>;
  };
  /** OS notifications raised by main (story 106). */
  notifications: {
    /**
     * A notification was clicked. Returns its own unsubscribe.
     *
     * Main focuses the window itself; this says *which session* the user was
     * answering, because only the renderer knows how to open one.
     */
    onActivate(callback: (event: NotificationActivateEvent) => void): () => void;
  };
  /** Real session lifecycle, derived in main (story 096). */
  session: {
    onStatus(callback: (event: SessionStatusEvent) => void): () => void;
    /** A session reported a new display name (HIVE-61). */
    onName(callback: (event: SessionNameEvent) => void): () => void;
  };
}

/**
 * At most one IPC message per session per this many milliseconds.
 *
 * Under a frame at 120 Hz, so no perceptible latency is added to interactive
 * typing — the echo of a keystroke still lands in the frame it would have.
 */
export const BATCH_INTERVAL_MS = 8;

/** Flush immediately past this, so a firehose cannot build a huge string. */
export const BATCH_FLUSH_BYTES = 64 * 1024;

/** Unacked bytes above which the pty is paused. */
export const HIGH_WATER_BYTES = 512 * 1024;

/** Unacked bytes below which it is resumed. */
export const LOW_WATER_BYTES = 128 * 1024;

/**
 * At most one resize per session per this many milliseconds.
 *
 * A window drag fires `ResizeObserver` continuously, and every resize is a
 * `SIGWINCH` to a process that redraws on each one.
 */
export const RESIZE_THROTTLE_MS = 50;

/**
 * The exact top-level key set of `window.hive`. The surface test asserts it.
 *
 * Story 106 adds two namespaces, and the alarm firing was the point. What a web
 * page can now do that it could not before: ask what this machine's `gh` looks
 * like (`integrations.status`, no arguments, read-only, no token value ever
 * returned), and hear that a notification was clicked
 * (`notifications.onActivate`, main → renderer only). Neither widens what the
 * renderer can *change*; the one new mutating verb is `config.setNotifications`,
 * which goes through the same guarded write path as every other.
 *
 * HIVE-67 adds `jira`, and it is the first namespace that touches a secret, so
 * the same alarm is worth ringing again. What a web page can now do that it
 * could not before: learn *whether* a Jira credential exists and which source
 * it comes from, store one, clear one, and cause exactly one authenticated
 * request to the configured site. What it still cannot do: read a token back —
 * there is no verb for it — or choose the host, which comes from the config and
 * never from a payload.
 */
export const BRIDGE_KEYS = [
  'appInfo',
  'config',
  'integrations',
  'jira',
  'notifications',
  'pty',
  'session',
] as const;

/** The exact key set of `window.hive.session`. */
export const BRIDGE_SESSION_KEYS = ['onStatus', 'onName'] as const;

/** The exact key set of `window.hive.integrations`. */
export const BRIDGE_INTEGRATIONS_KEYS = ['status'] as const;

/**
 * The exact key set of `window.hive.jira` (HIVE-67).
 *
 * Four. A fifth that read the token back would be the one addition this list
 * exists to make impossible to add quietly.
 */
export const BRIDGE_JIRA_KEYS = [
  'status',
  'setToken',
  'clearToken',
  'test',
  // HIVE-68. Two reads. Both return mapped fields only, and neither can name a
  // host — the site still comes from the config, in main.
  'search',
  'issue',
] as const;

/** The exact key set of `window.hive.notifications`. */
export const BRIDGE_NOTIFICATIONS_KEYS = ['onActivate'] as const;

/** The exact key set of `window.hive.config`. */
export const BRIDGE_CONFIG_KEYS = [
  'get',
  'reload',
  'chooseDirectory',
  'addProject',
  'removeProject',
  // Story 103.
  'renameProject',
  'repointProject',
  'reorderProjects',
  // Story 102.
  'startClone',
  'cancelClone',
  'onCloneDone',
  // Story 104.
  'setRuntime',
  'setProjectRuntime',
  'diagnoseCommand',
  // Story 106.
  'setNotifications',
  /**
   * Story 107. Two verbs, and what makes widening the surface here acceptable
   * is that **neither takes an argument**: `revealConfig` shows main's own
   * `configPath()` in the file manager, and `resetConfig` rewrites that same
   * file through the one guarded write path. Nothing arrives from the renderer,
   * so there is nothing to guard and no way to aim either at a file main did
   * not choose.
   */
  'revealConfig',
  'resetConfig',
  /**
   * HIVE-67. The Jira site and account email — ordinary settings, written
   * through the same guarded path as every other. The token is not here; it has
   * its own namespace because it is not config.
   */
  'setJira',
] as const;

/** The exact key set of `window.hive.pty`. */
export const BRIDGE_PTY_KEYS = [
  'ack',
  'spawn',
  'write',
  'resize',
  'kill',
  'onData',
  'onExit',
  'onLost',
  'restart',
] as const;
