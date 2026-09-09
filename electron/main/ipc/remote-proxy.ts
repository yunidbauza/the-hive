import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';

import { CH, type AppInfo, type Channel } from '@shared/ipc-contract';
import { FRAME_KIND, isProcessLocal, windowBoundReason } from '@shared/remote-contract';

import { RemoteCallError, type RemoteClient } from '../../remote-client/socket';
import { checkForUpdatesInteractively, updateStatus } from '../updates';

import { createBindings, type Bindings } from './bindings';
import type { Broadcaster } from './broadcaster';
import { createForegroundStamp, type ForegroundStamp } from './remote-foreground';
import { assertSender } from './sender';

/**
 * What each `PROCESS_LOCAL` channel is actually answered with (HIVE-144,
 * Rulings 24 and 28).
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
 *
 * `CH.configSetRemote` is the fourth, added by Ruling 28, and it is the one
 * that made this table take a **payload**. The other three are read verbs a
 * renderer calls with nothing; this one carries `{ mode, host, port }` and is
 * meaningless without it. It is handed down like `localAppInfo` rather than
 * imported like `updateStatus` for a different reason from `localAppInfo`'s,
 * worth stating because the shapes look alike: nothing about it is
 * per-registration state — {@link applySetRemote} closes over no registration
 * at all — but the switcher it needs is `router.ts`'s own `switchIpcMode`, and
 * this module is on `router.ts`'s import graph already, so reaching back for
 * it would close a cycle `import/no-cycle` refuses.
 */
function localAnswerFor(
  channel: Channel,
  deps: { localAppInfo: () => AppInfo; localSetRemote: (payload: unknown) => Promise<unknown> },
): ((payload: unknown) => unknown | Promise<unknown>) | null {
  switch (channel) {
    case CH.appInfo:
      return () => deps.localAppInfo();
    case CH.updatesStatus:
      return () => updateStatus();
    case CH.updatesCheck:
      return () => checkForUpdatesInteractively();
    case CH.configSetRemote:
      return (payload) => deps.localSetRemote(payload);
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
 * {@link noLocalAppInfo}'s sibling for `CH.configSetRemote` (Ruling 28), and
 * it throws for a sharper reason than that one does.
 *
 * A missing `localAppInfo` would answer a placeholder that told a user the
 * wrong version. A missing `localSetRemote` would have nowhere to go at all:
 * the whole point of the channel being here is that forwarding it detaches
 * nothing, so a default that quietly proxied would restore the exact defect
 * Ruling 28 removed, and one that answered `{ ok: true }` would report a
 * detach that never happened — which is what the defect *looked like*.
 */
function noLocalSetRemote(): Promise<never> {
  return Promise.reject(
    new Error(
      'registerRemoteProxy reached CH.configSetRemote with no localSetRemote supplied. ' +
        'registerRemoteProxy was called directly rather than through registerIpc.',
    ),
  );
}

/**
 * Module scope, for the same reason `ipc/index.ts`'s own `bindings` is:
 * `registerRemoteProxy` fills it, and a later mode switch (HIVE-144's next
 * task) must be able to empty it from outside this function.
 */
let bindings: Bindings | null = null;
let unsubscribe: (() => void) | null = null;
/** This machine's focus, stamped onto `ui:foreground` (HIVE-145). */
let foregroundStamp: ForegroundStamp | null = null;

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
 * `localAppInfo` answers `CH.appInfo` (HIVE-144, Ruling 24) and
 * `localSetRemote` answers `CH.configSetRemote` (Ruling 28) — see
 * `isProcessLocal`'s own doc comment for the four channels this bypasses the
 * socket for entirely, and why. Both optional only so the many call sites in
 * this module's own test file that never touch those channels do not all need
 * one; every production caller (`ipc/router.ts`'s `registerIpc`) passes the
 * real ones, and {@link noLocalAppInfo} and {@link noLocalSetRemote} fail
 * loudly rather than answering quietly wrong if a caller that skips
 * `router.ts` ever does exercise those channels without supplying them.
 */
export function registerRemoteProxy(deps: {
  client: RemoteClient;
  broadcaster: Broadcaster;
  localAppInfo?: () => AppInfo;
  localSetRemote?: (payload: unknown) => Promise<unknown>;
}): void {
  if (bindings !== null) {
    throw new Error(
      'registerRemoteProxy is already registered. Call resetRemoteProxy() first — ' +
        'registering again without it would leave the previous registration’s notify ' +
        'listeners bound against a stale client, since ipcMain.on does not refuse a duplicate.',
    );
  }

  const {
    client,
    broadcaster,
    localAppInfo = noLocalAppInfo,
    localSetRemote = noLocalSetRemote,
  } = deps;

  bindings = createBindings(ipcMain);
  foregroundStamp = createForegroundStamp((channel, payload) => {
    /*
      Straight to the socket, not through `ipcMain`: this is a send the *main
      process* originates, on the renderer's behalf, because only main can see
      a window's focus. Wrapped for the reason the notify binding below is —
      `client.notify` throws past `POST_ATTACH_FRAME_MAX_BYTES`, and an
      unhandled throw out of a focus event would be an exception in main with
      nobody to catch it.
    */
    try {
      client.notify(channel as Channel, payload);
    } catch (cause) {
      console.error(`[hive] rejected ${channel}:`, cause);
    }
  });

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
        ? localAnswerFor(channel as Channel, { localAppInfo, localSetRemote })
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
          Answered here, never forwarded (HIVE-144, Rulings 24 and 28): this
          channel reads or changes *this* process's own identity or attachment
          — see `isProcessLocal`'s own doc comment — so the far end's answer
          would be a plausible, wrong one, not merely an unreachable one the
          way `WINDOW_BOUND`'s channels are. No `client.call` at all, not even
          a discarded one: the round trip itself would be a socket the client
          did not need to spend.

          `payload` is forwarded to the local answer rather than dropped, and
          that is not symmetry for its own sake: `CH.configSetRemote` carries
          `{ mode, host, port }` and means nothing without them. The three
          read verbs beside it ignore what they are handed, exactly as their
          local handlers do.

          **This is also the one local answer that unbinds the handler running
          it.** `applySetRemote` awaits `switchIpcMode`, whose every path calls
          `unbindEverything()` — including `resetRemoteProxy()`, which removes
          the very `ipcMain.handle` this closure is executing inside. That is
          survivable for the reason the local surface's own copy of this
          sequence is: `ipcMain.handle` resolves the promise it already
          returned, and removing the handler afterwards cannot reach back into
          a call in flight. Nothing below this line touches `bindings`, which
          is `null` by the time the await returns.
        */
        if (localAnswer !== null) return Promise.resolve(localAnswer(payload));
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
          /*
            The one payload this proxy enriches on the way past (HIVE-145).

            `ui:foreground` decides notification suppression, and the server
            answering it cannot see this machine's windows — a served Mac
            usually has none of its own. So the client stamps its own focus
            here, live from `BrowserWindow`, and `src/` goes on sending the
            same one-key `{ terminalId }` it sends in local mode. A malformed
            payload is passed through unchanged so the server's own guard is
            still the one that rejects it.
          */
          const outgoing =
            channel === CH.uiForeground ? (foregroundStamp?.stamp(payload) ?? payload) : payload;
          client.notify(channel as Channel, outgoing);
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
  foregroundStamp?.dispose();
  foregroundStamp = null;
}
