import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';

import { CH, type AppInfo, type Channel } from '@shared/ipc-contract';
import { FRAME_KIND, isProcessLocal, windowBoundReason } from '@shared/remote-contract';

import { RemoteCallError, type RemoteClient } from '../../remote-client/socket';
import { checkForUpdatesInteractively, updateStatus } from '../updates';

import { createBindings, type Bindings } from './bindings';
import type { Broadcaster } from './broadcaster';
import { assertSender } from './sender';

/**
 * What each `PROCESS_LOCAL` channel is actually answered with (HIVE-144,
 * Ruling 24).
 *
 * `CH.updatesStatus` and `CH.updatesCheck` reach stable, already-a-singleton
 * module functions (`electron/main/updates/index.ts`'s own doc comment: "one
 * object, always present") — the same functions `ipc/index.ts`'s local
 * handlers call, imported directly rather than handed down, because nothing
 * about them is per-registration state and importing them creates no cycle
 * (`updates/index.ts` reaches `electron`, `@shared/update-contract` and its
 * own `capability`/`engine`/`updater` siblings — nothing back into `ipc/`).
 *
 * `CH.appInfo` is different: its answer depends on state that *is*
 * per-registration (`hooks`, `remoteListener`, `sessions`, all closed over
 * inside one call to `registerIpcHandlers`), so it cannot be imported the
 * same way — `localAppInfo` is handed down instead, the same seam
 * `switchMode` already crosses for the identical reason.
 */
function localAnswerFor(
  channel: Channel,
  localAppInfo: () => AppInfo,
): (() => unknown | Promise<unknown>) | null {
  switch (channel) {
    case CH.appInfo:
      return localAppInfo;
    case CH.updatesStatus:
      return updateStatus;
    case CH.updatesCheck:
      return checkForUpdatesInteractively;
    default:
      return null;
  }
}

/**
 * The default `localAppInfo`, reached only by a caller that skips
 * `router.ts` entirely — every production path (`registerIpc('remote', ...)`)
 * supplies the real one. Throws rather than answering a placeholder `AppInfo`
 * for the same reason {@link noModeSwitcher} (`ipc/index.ts`) throws: a
 * silent, wrong answer here would tell a user their own machine's version,
 * bind state and attachment were something they are not.
 */
function noLocalAppInfo(): AppInfo {
  throw new Error(
    'registerRemoteProxy reached CH.appInfo with no localAppInfo supplied. ' +
      'registerRemoteProxy was called directly rather than through registerIpc.',
  );
}

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
 *
 * Refuses a second call without a `resetRemoteProxy()` in between (review
 * round 1). Without this, a re-registration would silently reassign
 * `bindings` and `unsubscribe`, orphaning the first registration: its `call`
 * channels would throw on Electron's own "second handler" refusal mid-loop,
 * but its `notify` channels do not — `ipcMain.on` happily adds a second
 * listener — so the stale first client would keep answering `pty:write`
 * alongside the new one, unbindable because nothing still references it.
 *
 * `localAppInfo` answers `CH.appInfo` (HIVE-144, Ruling 24) — see
 * `isProcessLocal`'s own doc comment for the three channels this bypasses the
 * socket for entirely, and why. Optional only so the many call sites in this
 * module's own test file that never touch those three channels do not all
 * need one; every production caller (`ipc/router.ts`'s `registerIpc`) passes
 * the real one, and {@link noLocalAppInfo} throws rather than answering
 * quietly wrong if a caller that skips `router.ts` ever does exercise
 * `CH.appInfo` without supplying it.
 */
export function registerRemoteProxy(deps: {
  client: RemoteClient;
  broadcaster: Broadcaster;
  localAppInfo?: () => AppInfo;
}): void {
  if (bindings !== null) {
    throw new Error(
      'registerRemoteProxy is already registered. Call resetRemoteProxy() first — ' +
        'registering again without it would leave the previous registration’s notify ' +
        'listeners bound against a stale client, since ipcMain.on does not refuse a duplicate.',
    );
  }

  const { client, broadcaster, localAppInfo = noLocalAppInfo } = deps;

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
      /*
        Same resolve-once reasoning as `reason` above, for the sibling table
        (HIVE-144, Ruling 24): `PROCESS_LOCAL` does not change while this
        process is running either, so a channel on it answers from `localAnswer`
        every time, never depending on what the socket would have said.
      */
      const localAnswer = isProcessLocal(channel)
        ? localAnswerFor(channel as Channel, localAppInfo)
        : null;

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
        /*
          Answered here, never forwarded (HIVE-144, Ruling 24): every field of
          this channel's payload describes *this* process — see
          `isProcessLocal`'s own doc comment — so the far end's answer would be
          a plausible, wrong one, not merely an unreachable one the way
          `WINDOW_BOUND`'s channels are. No `client.call` at all, not even a
          discarded one: the round trip itself would be a socket the client
          did not need to spend.
        */
        if (localAnswer !== null) return Promise.resolve(localAnswer());
        return client.call(channel as Channel, payload);
      });
      bindings.record(channel);
    } else if (kind === 'notify') {
      ipcMain.on(channel, (event: IpcMainEvent, payload: unknown) => {
        assertSender(event);
        /*
          Mirrors `ipc/index.ts`'s own `on()` wrapper exactly, and for the
          reason its comment gives: a `send` channel has no reply, so a throw
          here would be an unhandled exception in main rather than an error
          the renderer sees (review round 1). It is not hypothetical for this
          proxy — `client.notify` (`remote-client/socket.ts`) throws
          `RemoteCallError('frame-too-large', …)` past
          `POST_ATTACH_FRAME_MAX_BYTES`, and a very large `pty:write` paste is
          the realistic way that happens. Logged and dropped, exactly as the
          local path drops it — never acted on, never escaping this wrapper.
        */
        try {
          client.notify(channel as Channel, payload);
        } catch (cause) {
          console.error(`[hive] rejected ${channel}:`, cause);
        }
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
