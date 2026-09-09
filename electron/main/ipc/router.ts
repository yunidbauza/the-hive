import type { RemoteClient } from '../../remote-client/socket';

import { createWindowBroadcaster, type Broadcaster } from './broadcaster';
import { registerRemoteProxy } from './remote-proxy';

import { registerIpcHandlers } from './index';

/**
 * Where this process's IPC is answered (HIVE-141).
 *
 * `local` is today and every day so far: `registerIpcHandlers()` binds every
 * channel to handlers in this process. `remote` is the mode where they are
 * answered by another machine instead — `registerRemoteProxy` forwards each
 * one to the socket this process attached to, over `RemoteClient` (HIVE-144).
 *
 * The switch lands a story before it does anything so that the boot path has
 * exactly one shape from here on. A mode added later to a boot path that never
 * had one is a refactor of `electron/main/index.ts`; a mode added to a switch is
 * a branch.
 */
export type IpcMode = 'local' | 'remote';

export interface RegisterIpcOptions {
  /**
   * Where main → renderer pushes go. Defaults to every live window either
   * way: in local mode that is the only surface there is, and in remote mode
   * it is what `registerRemoteProxy` pumps `client.onEvent` into. Supplied
   * explicitly by the remote host once sockets can attach *to* this process,
   * which is a different broadcaster answering a different question.
   */
  broadcaster?: Broadcaster;
  /** The attached socket, required in `remote` mode and ignored in `local`. */
  client?: RemoteClient;
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
 *
 * Remote mode forwards to `registerRemoteProxy`, which consults the same
 * sender check and nothing else — the renderer is the same sandboxed window
 * either way, only what answers it changes. `client` has no default: a caller
 * that asks for `remote` without a socket already open is a programming
 * error, not a runtime condition to recover from.
 */
export function registerIpc(mode: IpcMode, options: RegisterIpcOptions = {}): void {
  if (mode === 'remote') {
    if (options.client === undefined) {
      throw new Error('registerIpc("remote", ...) requires a client — there is no socket to attach to.');
    }
    registerRemoteProxy({
      client: options.client,
      broadcaster: options.broadcaster ?? createWindowBroadcaster(),
    });
    return;
  }
  registerIpcHandlers(options.broadcaster);
}
