import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';

import type { Channel } from '@shared/ipc-contract';
import { FRAME_KIND, windowBoundReason } from '@shared/remote-contract';

import { RemoteCallError, type RemoteClient } from '../../remote-client/socket';

import { createBindings, type Bindings } from './bindings';
import type { Broadcaster } from './broadcaster';
import { assertSender } from './sender';

/**
 * Module scope, for the same reason `ipc/index.ts`'s own `bindings` is:
 * `registerRemoteProxy` fills it, and a later mode switch (HIVE-144's next
 * task) must be able to empty it from outside this function.
 */
let bindings: Bindings | null = null;
let unsubscribe: (() => void) | null = null;

/**
 * The other end of `registerIpcHandlers` (HIVE-144).
 *
 * Where `registerIpcHandlers` answers a channel from this process's own
 * layers, `registerRemoteProxy` answers the same channel by asking the socket
 * this process attached to (`electron/remote-client/socket.ts`) and relaying
 * the answer back. The renderer that calls `window.hive.configGet()` cannot
 * tell which of the two ran — that is the whole point of the seam
 * `ipc/router.ts` draws between them.
 *
 * `FRAME_KIND` (`@shared/remote-contract`) is walked once, not read as three
 * literal arrays: a channel added to the contract and forgotten here becomes
 * a channel with no binding at all rather than a channel that silently
 * bypasses the loop, because there is no second list to fall out of step with
 * the first.
 *
 * - `call` channels bind with `ipcMain.handle` and forward to `client.call`.
 * - `notify` channels bind with `ipcMain.on` and forward to `client.notify`.
 * - `event` channels bind **nothing** — a socket does not wait to be asked
 *   for a push, so there is no handler for `ipcMain.handle` or `ipcMain.on`
 *   to answer. They are pumped once, below the loop, from `client.onEvent`
 *   into `broadcaster.emit`.
 *
 * `assertSender` runs first in both wrappers, exactly as `ipc/index.ts`'s own
 * `on`/`handle` run it first. The mode switch changes which layer answers a
 * channel; it does not change who is allowed to ask — the caller is still
 * this process's own sandboxed renderer, and a subframe forging a channel
 * call is exactly as unwelcome talking to a socket as it is talking to a
 * local handler.
 */
export function registerRemoteProxy(deps: { client: RemoteClient; broadcaster: Broadcaster }): void {
  const { client, broadcaster } = deps;

  bindings = createBindings(ipcMain);

  for (const [channel, kind] of Object.entries(FRAME_KIND)) {
    if (kind === 'call') {
      /*
        Resolved once per channel at registration, not per call: the table
        this reads from does not change while the process is running, and a
        `WINDOW_BOUND` channel should refuse every time exactly the same way,
        never depending on what a socket happens to answer.
      */
      const reason = windowBoundReason(channel);

      ipcMain.handle(channel, (event: IpcMainInvokeEvent, payload: unknown) => {
        assertSender(event);
        /*
          Refused here, never forwarded (HIVE-144). These four channels
          dereference a parent `BrowserWindow` to open a native dialog, which
          is meaningless on the machine actually answering `client.call` — it
          has no window at all. Forwarding the frame anyway would still come
          back refused, from `remote-dispatch.ts`'s own `windowBoundReason`
          check, with this exact code and message; answering it here instead
          costs one comparison and saves the round trip, and the renderer
          cannot tell the two apart because the shape is the same class this
          client throws for any other `error` frame.
        */
        if (reason !== null) return Promise.reject(new RemoteCallError('window-bound', reason));
        return client.call(channel as Channel, payload);
      });
      bindings.record(channel);
    } else if (kind === 'notify') {
      ipcMain.on(channel, (event: IpcMainEvent, payload: unknown) => {
        assertSender(event);
        client.notify(channel as Channel, payload);
      });
      bindings.record(channel);
    }
    // `event`: no handler. Pumped below, once, for every event channel at once.
  }

  /*
    One subscription for every push, not one per event channel (HIVE-144).
    `client.onEvent`'s own fan-out already filters to `event`-kind frames
    (`socket.ts`'s `frameKindOf(server.channel) !== 'event'` guard) before a
    listener ever sees one, so a second filter here would only repeat a check
    the socket has already made. What crosses this line is exactly what a
    local handler's own `send` would have pushed to this window — the
    channel and the payload, unchanged.
  */
  unsubscribe = client.onEvent((channel, payload) => {
    broadcaster.emit(channel, payload);
  });
}

/**
 * Test-only: how many channels `registerRemoteProxy` bound, so a channel
 * added to the contract without reaching this proxy fails a count rather
 * than going quietly missing. In the same register as `remoteRegistrySize`
 * in `ipc/index.ts`.
 */
export function remoteProxyBindingsSize(): number {
  return bindings?.size() ?? 0;
}

/**
 * Undo every `ipcMain` binding `registerRemoteProxy` made, and stop pumping
 * events into the broadcaster.
 *
 * Not called by anything yet — HIVE-144's mode-switch task is what calls this
 * before re-registering against local handlers, the same way
 * `resetIpcHandlers` leaves `ipcMain` clean before `registerIpcHandlers` runs
 * again. Exported now, alongside the bindings it tears down, rather than left
 * for that task to reach into module state that was not built to be reached.
 */
export function resetRemoteProxy(): void {
  bindings?.unbindAll();
  bindings = null;
  unsubscribe?.();
  unsubscribe = null;
}
