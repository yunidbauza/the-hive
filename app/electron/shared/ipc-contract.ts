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

export const CH = {
  ptySpawn: 'pty:spawn',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyData: 'pty:data', // main → renderer, stream
  ptyExit: 'pty:exit', // main → renderer
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
export const EVENT_CHANNELS = [CH.ptyData, CH.ptyExit] as const;
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
}

export interface ExitEvent {
  sessionId: string;
  exitCode: number;
  signal?: number;
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
  pty: {
    spawn(request: SpawnRequest): Promise<void>;
    write(request: WriteRequest): void;
    resize(request: ResizeRequest): void;
    kill(sessionId: string): Promise<void>;
    /** Returns its own unsubscribe. Callers MUST invoke it on unmount. */
    onData(callback: (event: DataEvent) => void): () => void;
    onExit(callback: (event: ExitEvent) => void): () => void;
  };
}

/** The exact top-level key set of `window.hive`. The surface test asserts it. */
export const BRIDGE_KEYS = ['appInfo', 'pty'] as const;

/** The exact key set of `window.hive.pty`. */
export const BRIDGE_PTY_KEYS = [
  'spawn',
  'write',
  'resize',
  'kill',
  'onData',
  'onExit',
] as const;
