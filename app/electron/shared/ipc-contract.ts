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
  RemoveProjectRequest,
  RenameProjectRequest,
  ReorderProjectsRequest,
  RepointProjectRequest,
  SetProjectRuntimeRequest,
  SetRuntimeRequest,
} from './config-contract';
import type { SessionStatusEvent } from './session-contract';

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
  CH.configCloneDone,
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
  /** Real session lifecycle, derived in main (story 096). */
  session: {
    onStatus(callback: (event: SessionStatusEvent) => void): () => void;
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

/** The exact top-level key set of `window.hive`. The surface test asserts it. */
export const BRIDGE_KEYS = ['appInfo', 'config', 'pty', 'session'] as const;

/** The exact key set of `window.hive.session`. */
export const BRIDGE_SESSION_KEYS = ['onStatus'] as const;

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
