import type { Broadcaster } from './broadcaster';

import { registerIpcHandlers } from './index';

/**
 * Where this process's IPC is answered (HIVE-141).
 *
 * `local` is today and every day so far: `registerIpcHandlers()` binds all 114
 * channels to handlers in this process. `remote` is the mode where they are
 * answered by another machine, and it is a stub — HIVE-144 fills it in.
 *
 * The switch lands a story before it does anything so that the boot path has
 * exactly one shape from here on. A mode added later to a boot path that never
 * had one is a refactor of `electron/main/index.ts`; a mode added to a switch is
 * a branch.
 */
export type IpcMode = 'local' | 'remote';

export interface RegisterIpcOptions {
  /**
   * Where main → renderer pushes go. Omitted in local mode, where the windows
   * are the only surface; supplied by the remote host once sockets can attach.
   */
  broadcaster?: Broadcaster;
}

/**
 * Thrown rather than returned, and named rather than generic.
 *
 * `remote` is reachable today only by a caller that passed the string itself, so
 * this is a programming error and not a runtime condition to branch on. When
 * HIVE-144 lands the branch, this throw is what it replaces — and a named class
 * makes that a deletion somebody can find rather than a `TODO` somebody hopes to
 * notice.
 */
export class RemoteModeNotImplementedError extends Error {
  constructor() {
    super(
      'Remote IPC mode is not implemented yet (HIVE-144). ' +
        'The contract and the authorization table ship in HIVE-141; the socket does not.',
    );
    this.name = 'RemoteModeNotImplementedError';
  }
}

/**
 * Bind this process's IPC according to `mode`.
 *
 * Local mode forwards to `registerIpcHandlers` and nothing else — no wrapping,
 * no filtering, no authorization check. The table in
 * `electron/shared/remote-contract.ts` is consulted by nothing in this path on
 * purpose: local callers are the sandboxed renderer of the app's own window,
 * already vouched for by `electron/main/ipc/sender.ts`, and adding a second gate
 * that always passes would be a gate nobody could tell was working.
 */
export function registerIpc(mode: IpcMode, options: RegisterIpcOptions = {}): void {
  if (mode === 'remote') throw new RemoteModeNotImplementedError();
  registerIpcHandlers(options.broadcaster);
}
