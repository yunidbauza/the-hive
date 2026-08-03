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

import type { ConfigSnapshot } from './config-contract';

export const CH = {
  configGet: 'config:get',
  configReload: 'config:reload',
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
export const EVENT_CHANNELS = [CH.ptyData, CH.ptyExit, CH.ptyLost] as const;
export type EventChannel = (typeof EVENT_CHANNELS)[number];

export interface SpawnRequest {
  sessionId: string;
  projectId: string;
  cols: number;
  rows: number;
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
   * The workspace config (story 090).
   *
   * Read-only from the renderer, deliberately. `reload()` re-reads the file
   * the *user* edited; there is no `set`, because a settings UI that writes
   * this file is out of scope and a bridge verb that can write to disk is not
   * something to add speculatively.
   */
  config: {
    get(): Promise<ConfigSnapshot>;
    reload(): Promise<ConfigSnapshot>;
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
export const BRIDGE_KEYS = ['appInfo', 'config', 'pty'] as const;

/** The exact key set of `window.hive.config`. */
export const BRIDGE_CONFIG_KEYS = ['get', 'reload'] as const;

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
] as const;
