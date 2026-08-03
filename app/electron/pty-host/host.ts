import type { HostCommand, HostMessage } from '@shared/pty-host-protocol';

import type { SessionOperations } from './sessions';

/**
 * The host's message loop (story 091).
 *
 * Separated from `index.ts` so it can be driven with a fake port in a unit
 * test. `index.ts` is then three lines of wiring that only Electron can
 * execute, and everything worth asserting lives here.
 *
 * The host owns processes, not policy. It does not read config, does not know
 * what a project is, and does not decide what to run — every value it needs
 * arrives on the command. A lint zone enforces that it cannot import the code
 * that would tempt it otherwise.
 */

/** The slice of Electron's `parentPort` this module uses. */
export interface HostPort {
  postMessage(message: HostMessage): void;
  on(event: 'message', listener: (event: { data: HostCommand }) => void): void;
}

export interface PtyHostDeps {
  port: HostPort;
  sessions: SessionOperations;
  /** Injected so a test can observe the exit instead of ending the run. */
  exit?: (code: number) => void;
}

export function createPtyHost({
  port,
  sessions,
  exit = (code) => process.exit(code),
}: PtyHostDeps): void {
  const emit = (message: HostMessage): void => {
    port.postMessage(message);
  };

  port.on('message', (event) => {
    const command = event.data;

    switch (command.type) {
      case 'ping':
        // Answered immediately and unconditionally. A pong that waited behind
        // session work would report the host as hung precisely when it is
        // busiest, which is when the user least wants their terminals killed.
        emit({ type: 'pong', seq: command.seq });
        return;

      case 'pong':
        // Main answering a ping this host sent. Nothing here drives a health
        // timer — a host watching a hung *main* process could do nothing
        // useful with the answer, since the window it would report to is the
        // thing that hung — so the reply is simply accepted.
        return;

      case 'spawn':
        sessions.spawn(command, emit);
        return;

      case 'write':
        sessions.write(command.sessionId, command.data);
        return;

      case 'resize':
        sessions.resize(command.sessionId, command.cols, command.rows);
        return;

      case 'kill':
        sessions.kill(command.sessionId, command.signal);
        return;

      case 'shutdown':
        /**
         * Kill everything, *then* exit.
         *
         * Exiting first would orphan every child process the sessions own —
         * the `claude` processes that outlive app quit, which is the bug this
         * whole path exists to prevent. The supervisor is holding the app's
         * quit open while this runs, and will force-kill if it takes too long.
         */
        void Promise.resolve(sessions.killAll()).then(
          () => exit(0),
          (cause: unknown) => {
            emit({
              type: 'error',
              message: `shutdown failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            });
            exit(1);
          },
        );
        return;
    }
  });
}
