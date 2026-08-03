import type { HostMessage, SpawnCommand } from '@shared/pty-host-protocol';

/**
 * What the host can do to sessions (story 091).
 *
 * **The seam story 092 fills in.** The host process, its message loop, its
 * heartbeat and its shutdown path all exist and are supervised before anything
 * spawns a PTY — which is the entire argument for doing 091 first. Retrofitting
 * a supervisor after 092's handlers and 093's transport are written against
 * in-process calls means re-doing the async shape of both.
 *
 * `emit` is passed in rather than captured so an implementation never has to
 * know how it is connected to main. That is what lets story 098 drive a session
 * manager directly, with no port and no process boundary.
 */
export interface SessionOperations {
  spawn(command: SpawnCommand, emit: (message: HostMessage) => void): void;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  kill(sessionId: string, signal?: string): void;
  /** Kill every session's process group. Awaited on shutdown. */
  killAll(): Promise<void> | void;
}

/**
 * The placeholder this story ships.
 *
 * It answers every request with a typed error rather than failing silently, so
 * a spawn attempted before story 092 lands produces a message in the terminal
 * instead of a session that never opens and never says why.
 */
export function createPendingSessions(): SessionOperations {
  const notYet = (
    sessionId: string,
    emit: (message: HostMessage) => void,
  ): void => {
    emit({
      sessionId,
      type: 'error',
      message: 'the pty host cannot spawn sessions yet (story 092)',
    });
  };

  return {
    spawn: (command, emit) => notYet(command.sessionId, emit),
    // Nothing is live, so these have nothing to route to. They are not errors:
    // main rejects unknown sessions before they ever reach the host, so a
    // write arriving here means a session main believes in — and the spawn
    // that would have created it already reported why it did not.
    write: () => {},
    resize: () => {},
    kill: () => {},
    killAll: () => {},
  };
}
