import { createPtyHost, type HostPort } from './host';
import { createSessionManager } from './session-manager';

/**
 * The pty-host process entry (story 091).
 *
 * Bundled as a second input of the `main` target, so it lands beside
 * `out/main/index.js` as `out/main/pty-host.js` and inherits the same module
 * format and the same Electron ABI the `node-pty` binary was rebuilt for
 * (story 084). Forking the *system* `node` instead would reintroduce exactly
 * the ABI mismatch that story exists to eliminate.
 *
 * Wiring only. Everything testable is in `host.ts`.
 */

/**
 * `process.parentPort` exists only inside a `utilityProcess` child.
 *
 * Reached through a narrow local type rather than by importing `electron`: the
 * host is a plain Node process that must not depend on Electron's module
 * graph, and the lint zone for this directory is what keeps that true. If the
 * global is absent, this file is being run somewhere it was never meant to be,
 * and saying so beats a `TypeError` on an undefined property.
 */
const parentPort = (process as NodeJS.Process & { parentPort?: HostPort })
  .parentPort;

if (!parentPort) {
  throw new Error(
    'pty-host must be started with utilityProcess.fork — no parentPort found',
  );
}

createPtyHost({ port: parentPort, sessions: createSessionManager() });
