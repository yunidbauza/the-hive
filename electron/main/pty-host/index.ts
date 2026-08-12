import { join } from 'node:path';

import { utilityProcess } from 'electron';

import { onShutdown } from '../shutdown';

import {
  createPtyHostSupervisor,
  type HostChild,
  type PtyHostSupervisor,
} from './supervisor';

/**
 * Wiring the supervisor to Electron (story 091).
 *
 * The only file here that imports `electron`, which is what keeps
 * `supervisor.ts` — the part with all the behaviour — drivable under Vitest.
 */

/** Emitted beside `index.js` by the `main` target's second rollup input. */
const PTY_HOST_ENTRY = 'pty-host.js';

/**
 * `utilityProcess`, not `child_process.fork`.
 *
 * Three things Electron's own API brings that `fork` does not:
 *
 * - The child is an **Electron** Node process, so it has the same ABI the
 *   `node-pty` binary was built for (story 084).
 * - MessagePort-based messaging, structured-clone typed, rather than a
 *   hand-rolled stdio protocol.
 * - Electron tracks the child's lifetime with the app, so a hard quit cannot
 *   orphan it.
 */
function forkPtyHost(): HostChild {
  return utilityProcess.fork(join(import.meta.dirname, PTY_HOST_ENTRY), [], {
    // Names the process in Activity Monitor. A nameless helper next to an app
    // that spawns terminals is the one a user force-quits first.
    serviceName: 'hive-pty-host',
  });
}

let supervisor: PtyHostSupervisor | null = null;

/**
 * Create the supervisor and register its teardown. **Forks nothing.**
 *
 * Called at startup, but the host itself starts lazily on the first spawn —
 * most launches land on the orchestrator console, which owns no PTY.
 */
export function registerPtyHost(): PtyHostSupervisor {
  if (supervisor) return supervisor;

  const created = createPtyHostSupervisor({ fork: forkPtyHost });

  /**
   * Registration, not a refactor of the quit path — which is exactly why
   * story 081 built `onShutdown` before anything needed it. `before-quit` is
   * already async-correct, so this hook is awaited rather than
   * fire-and-forget.
   */
  onShutdown(() => created.shutdown());

  supervisor = created;
  return created;
}

/** The live supervisor, or `null` before `registerPtyHost` has run. */
export function ptyHost(): PtyHostSupervisor | null {
  return supervisor;
}

/** Test-only: drop the singleton. */
export function resetPtyHost(): void {
  supervisor = null;
}

export type { HostChild, PtyHostSupervisor } from './supervisor';
