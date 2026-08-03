import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type { ConfigSnapshot } from '@shared/config-contract';
import {
  CH,
  type AppInfo,
  type DataEvent,
  type ExitEvent,
  type HiveBridge,
  type ResizeRequest,
  type SpawnRequest,
  type WriteRequest,
} from '@shared/ipc-contract';

/**
 * The bridge (story 082).
 *
 * Three rules the review must enforce, all of them load-bearing:
 *
 * 1. **`ipcRenderer` is never exposed**, in whole or in part. Not as
 *    `ipcRenderer.invoke` bound to a channel argument, not behind a wrapper
 *    that takes a channel name. The renderer gets *verbs*, and the set of verbs
 *    is the allowlist. Adding a capability later is a deliberate edit to the
 *    contract rather than an incremental widening of what a web page can do to
 *    this machine.
 *
 * 2. **Every subscription returns its own unsubscribe.** This mirrors
 *    `TerminalTransport.onData`'s contract exactly (story 042), which is what
 *    lets `PtyTransport` (story 094) be a thin adapter rather than a
 *    translation layer.
 *
 * 3. **The raw `IpcRendererEvent` never crosses the bridge.** Passing the event
 *    hands the renderer a `sender` handle and defeats the isolation entirely.
 *
 * `sandbox: true` constrains this file too: it may require only `electron` and
 * a small polyfill set — no `fs`, no `child_process`, no `process.env`. Any
 * temptation to do real work here is a signal the work belongs in main behind
 * a channel.
 */

/**
 * Thirteen live terminals mean thirteen `pty:data` subscriptions on one
 * channel, and Node's default cap of 10 would log a MaxListenersExceeded
 * warning that is entirely legitimate here.
 *
 * Raised explicitly rather than left to fire, because a warning everyone has
 * learned to ignore is a warning that will not be read when it means something.
 * The number is generous but finite — an unbounded cap would hide a real
 * listener leak, which the disposer discipline above exists to prevent.
 */
ipcRenderer.setMaxListeners(64);

/**
 * Subscribe to a main → renderer channel.
 *
 * Invokes the callback with the **payload only**, and returns a disposer that
 * removes exactly this listener. A surface that unmounts without unsubscribing
 * leaks a listener per mount/unmount cycle, and tab switching is frequent.
 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const bridge: HiveBridge = {
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke(CH.appInfo),
  config: {
    get: (): Promise<ConfigSnapshot> => ipcRenderer.invoke(CH.configGet),
    reload: (): Promise<ConfigSnapshot> => ipcRenderer.invoke(CH.configReload),
  },
  pty: {
    spawn: (request: SpawnRequest): Promise<void> =>
      ipcRenderer.invoke(CH.ptySpawn, request),
    // `send`, not `invoke`: keystrokes and resizes are fire-and-forget, and
    // awaiting a round-trip per keypress would put the main process in the
    // typing latency path.
    write: (request: WriteRequest): void => ipcRenderer.send(CH.ptyWrite, request),
    resize: (request: ResizeRequest): void =>
      ipcRenderer.send(CH.ptyResize, request),
    kill: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(CH.ptyKill, sessionId),
    onData: (callback: (event: DataEvent) => void) =>
      subscribe<DataEvent>(CH.ptyData, callback),
    onExit: (callback: (event: ExitEvent) => void) =>
      subscribe<ExitEvent>(CH.ptyExit, callback),
  },
};

contextBridge.exposeInMainWorld('hive', bridge);
