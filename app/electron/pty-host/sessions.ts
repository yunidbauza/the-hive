import type { HostMessage, SpawnCommand } from '@shared/pty-host-protocol';

/**
 * What the host can do to sessions (story 091, implemented by story 092).
 *
 * The seam between the host's message loop and the thing that owns real
 * processes. `session-manager.ts` is the implementation; this stays a separate
 * type so `host.ts` can be driven with a recording stub, and so story 098 can
 * drive a session manager directly with no port and no process boundary.
 *
 * `emit` is passed to `spawn` rather than captured at construction so an
 * implementation never has to know how it is connected to main.
 */
export interface SessionOperations {
  spawn(command: SpawnCommand, emit: (message: HostMessage) => void): void;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  kill(sessionId: string, signal?: string): void;
  /**
   * Stop / start reading the pty's fd (story 093).
   *
   * Paused, the kernel pty buffer fills and the producing process blocks on
   * `write` — real backpressure, not a queue growing somewhere out of sight.
   */
  pause(sessionId: string): void;
  resume(sessionId: string): void;
  /** Kill every session's process group. Awaited on shutdown. */
  killAll(): Promise<void> | void;
}
