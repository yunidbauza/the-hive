/**
 * The main ↔ pty-host protocol (story 091).
 *
 * Deliberately **distinct** from `ipc-contract.ts`, which is the renderer-facing
 * contract. The two describe different boundaries with different trust
 * properties — the renderer is untrusted input, the host is a process we
 * started — and they must be free to diverge. Collapsing them into one type
 * would mean every renderer-visible change rippled into a process boundary that
 * has no business knowing about it.
 *
 * The host is deliberately dumb: it owns processes, not policy. Note what these
 * messages do **not** carry — no project id, no config, no fixture anything.
 * `shell`, `args`, `cwd` and `env` arrive fully resolved from main (stories 090
 * and 096). That is what lets the conformance suite (098) drive a host in
 * isolation, with no app around it.
 */

/** Commands main sends to the host. */
export interface SpawnCommand {
  type: 'spawn';
  sessionId: string;
  shell: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface WriteCommand {
  type: 'write';
  sessionId: string;
  data: string;
}

export interface ResizeCommand {
  type: 'resize';
  sessionId: string;
  cols: number;
  rows: number;
}

export interface KillCommand {
  type: 'kill';
  sessionId: string;
  signal?: string;
}

/**
 * Stop reading the pty's fd (story 093).
 *
 * Real backpressure, not a buffer somewhere: the kernel pty buffer fills and
 * the producing process blocks on `write`, exactly as it would piping to a
 * slow consumer in a shell.
 */
export interface PauseCommand {
  type: 'pause';
  sessionId: string;
}

export interface ResumeCommand {
  type: 'resume';
  sessionId: string;
}

/** Kill every session and exit. Sent on app quit (story 081's shutdown hook). */
export interface ShutdownCommand {
  type: 'shutdown';
}

export type HostCommand =
  | SpawnCommand
  | WriteCommand
  | ResizeCommand
  | KillCommand
  | PauseCommand
  | ResumeCommand
  | ShutdownCommand
  // Both halves of the heartbeat travel in both directions, so either side can
  // ask and either side can answer. Without `PongMessage` here, main could
  // only ever reply to a ping with another ping.
  | PingMessage
  | PongMessage;

/** Messages the host sends back. */
export interface DataMessage {
  type: 'data';
  sessionId: string;
  chunk: string;
}

export interface ExitMessage {
  type: 'exit';
  sessionId: string;
  exitCode: number;
  signal?: number;
}

export interface SpawnedMessage {
  type: 'spawned';
  sessionId: string;
  pid: number;
}

export interface ErrorMessage {
  type: 'error';
  /** Absent when the failure is not attributable to one session. */
  sessionId?: string;
  message: string;
}

/**
 * The heartbeat, typed for either direction.
 *
 * In practice **main pings and the host pongs**, and only main runs a health
 * timer. The reverse is typed but not driven, for a simple reason: the failure
 * being watched for is a host that hangs without exiting, which is
 * indistinguishable from a dead terminal to the user unless something is
 * watching. A host watching a hung *main* process could do nothing useful with
 * the answer — the window it would report to is the thing that hung.
 */
export interface PingMessage {
  type: 'ping';
  seq: number;
}

export interface PongMessage {
  type: 'pong';
  seq: number;
}

export type HostMessage =
  | DataMessage
  | ExitMessage
  | SpawnedMessage
  | ErrorMessage
  | PongMessage
  | PingMessage;

/** How often main pings the host. */
export const HEARTBEAT_INTERVAL_MS = 2_000;

/**
 * Consecutive unanswered pings before the host is treated as crashed.
 *
 * Three, so a single slow tick — a GC pause, a burst of output — cannot
 * condemn a healthy host, while a genuine hang is caught inside ~6 seconds.
 */
export const MISSED_BEAT_LIMIT = 3;

/** How long a graceful shutdown is given before the host is force-killed. */
export const SHUTDOWN_TIMEOUT_MS = 3_000;

/** The crash-loop guard's window and its limit. */
export const CRASH_WINDOW_MS = 60_000;

/**
 * Crashes inside the window before restarts stop.
 *
 * An unbounded restart loop against a reproducible segfault burns CPU and
 * floods the feed. Four, not one, because a single crash is a bad terminal and
 * should cost the user that terminal — not the ability to open another.
 */
export const CRASH_LIMIT = 4;

/** What a terminal writes when its host died underneath it. */
export const SESSION_LOST_NOTICE = 'session lost (pty host crashed)';

/**
 * Prefixed to a replayed transcript that had output dropped from its front
 * (story 092).
 *
 * SGR dim written literally, not through `src/lib/terminal/ansi.ts`: the host
 * may not import renderer code, and this string is produced inside a pty
 * stream where an escape sequence is the only way to be dim. A partial
 * transcript that does not say it is partial is worse than no transcript —
 * the user reads it as the whole story.
 */
export const TRUNCATION_NOTICE =
  '[2m── earlier output truncated ──[0m\r\n';

/** Default bounded scrollback per session. */
export const SCROLLBACK_BYTES = 256 * 1024;

/**
 * Default session cap.
 *
 * The fixture set is thirteen entities, so this sits comfortably above
 * realistic use and well below the point where a laptop is fork-bombed.
 */
export const MAX_SESSIONS = 24;

/** How long a killed process group has to die before it is SIGKILLed. */
export const KILL_GRACE_MS = 2_000;
