// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppInfo } from '../../../../electron/shared/ipc-contract';
import { FRAME_KIND, PROCESS_LOCAL, WINDOW_BOUND } from '../../../../electron/shared/remote-contract';

/**
 * `../updates` (`electron/main/updates/index.ts`) is mocked here for the
 * reason `client` is faked rather than dialled for real: that module reaches
 * real `electron` APIs (`app.getVersion()`, `dialog.showMessageBox`) this
 * file's own `electron` mock does not provide, and what a real update check
 * actually does is `electron/main/updates/`'s own test's job, not this
 * proxy's. What this file needs to prove is narrower — that `CH.updatesStatus`
 * and `CH.updatesCheck` reach *these* functions directly rather than
 * `client.call` — and a fake return value is what makes that provable without
 * a real update check running in a unit test.
 */
const updateStatus = vi.fn(() => 'FAKE_UPDATE_STATUS');
const checkForUpdatesInteractively = vi.fn(() => Promise.resolve('FAKE_UPDATE_CHECK'));
vi.mock('../../../../electron/main/updates', () => ({ updateStatus, checkForUpdatesInteractively }));

/**
 * `registerRemoteProxy`, the other end of `registerIpcHandlers` (HIVE-144).
 *
 * `electron`'s `ipcMain` is mocked the way `bindings.test.ts` mocks its own
 * target — `handle` and `on` record into plain maps, `removeHandler` and
 * `removeAllListeners` un-record, so a real reversibility guarantee is being
 * exercised rather than a `vi.fn()` that would silently accept a duplicate
 * binding a real `ipcMain.handle` would throw on.
 *
 * The three channel lists below are derived from `FRAME_KIND` — the same
 * table `registerRemoteProxy` itself walks — but the counts asserted against
 * them (98, 6, 25, 104) are literals, not read back off the derived lists.
 * `tests/shared/remote-contract.test.ts:58,93` pins the same four numbers
 * independently. A channel added to the contract without a home in this file
 * fails a count here, which is the point: a self-referential assertion could
 * never catch that, only a literal one can.
 */

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
const listeners = new Map<string, (event: unknown, payload: unknown) => unknown>();

const handle = vi.fn((channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
  handlers.set(channel, fn);
});
const on = vi.fn((channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
  listeners.set(channel, fn);
});
const removeHandler = vi.fn((channel: string) => {
  handlers.delete(channel);
});
const removeAllListeners = vi.fn((channel: string) => {
  listeners.delete(channel);
});

/**
 * `app` and `BrowserWindow` are here for the foreground stamp (HIVE-145): the
 * proxy enriches `ui:foreground` with this machine's own focus, which means it
 * watches the app-level focus events and reads `BrowserWindow` live.
 */
const appListeners = new Map<string, Set<() => void>>();
/** Toasts this process raised for the attached server (HIVE-145). */
const toastsRaised: { title: string; body: string }[] = [];
let windows: { isDestroyed: () => boolean; isFocused: () => boolean }[] = [
  { isDestroyed: () => false, isFocused: () => true },
];

vi.mock('electron', () => ({
  ipcMain: { handle, on, removeHandler, removeAllListeners },
  app: {
    on: (event: string, listener: () => void) => {
      const existing = appListeners.get(event) ?? new Set();
      existing.add(listener);
      appListeners.set(event, existing);
    },
    removeListener: (event: string, listener: () => void) => {
      appListeners.get(event)?.delete(listener);
    },
  },
  BrowserWindow: { getAllWindows: () => windows },
  /*
    The proxy answers `notifications:toast` itself rather than forwarding it
    (HIVE-145), so driving the pump reaches a real Electron `Notification`.
  */
  Notification: class {
    static isSupported(): boolean {
      return true;
    }
    constructor(options: { title: string; body: string }) {
      toastsRaised.push(options);
    }
    on(): this {
      return this;
    }
    show(): void {
      /* nothing to observe beyond the construction above */
    }
  },
}));

const { registerRemoteProxy, remoteProxyBindingsSize, resetRemoteProxy } = await import(
  '../../../../electron/main/ipc/remote-proxy'
);

/** Matches `foreground.test.ts`'s trusted-sender fixture: identity, not shape. */
const mainFrame = { url: 'file:///out/renderer/index.html' };
const trustedEvent = { senderFrame: mainFrame, sender: { mainFrame } } as never;

function fakeClient() {
  const eventListeners = new Set<(channel: string, payload: unknown) => void>();
  return {
    call: vi.fn().mockResolvedValue('ok'),
    notify: vi.fn(),
    onEvent: vi.fn((listener: (channel: string, payload: unknown) => void) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    }),
    snapshot: vi.fn(),
    serverName: vi.fn(),
    close: vi.fn(),
    /** Test-only: fire an event as the real socket's fan-out would. */
    emit(channel: string, payload: unknown) {
      for (const listener of eventListeners) listener(channel, payload);
    },
  };
}

const fakeBroadcaster = () => ({ emit: vi.fn() });

/**
 * A `localAppInfo` fake, distinguishable from `updateStatus`'s fake return.
 * Cast rather than typed as a real `AppInfo`: a full fixture would repeat
 * `use-project-config.test.tsx`'s own `AppInfo` factory for no benefit here —
 * this file only proves *that* `localAppInfo` was called, never inspects the
 * shape of what it returns.
 */
const fakeAppInfo = vi.fn(() => 'FAKE_APP_INFO') as unknown as () => AppInfo;

/**
 * Calls a bound `handle` channel the way real `ipcMain.handle` would: a
 * synchronous throw inside the handler — `assertSender`'s — becomes a
 * rejected promise rather than an exception thrown while evaluating the call
 * expression. Matches `config-channels.test.ts`'s own `invoke`.
 */
const invoke = (channel: string, event: unknown, payload: unknown) =>
  Promise.resolve().then(() => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`${channel} was never bound`);
    return handler(event, payload);
  });

const callChannels = Object.entries(FRAME_KIND)
  .filter(([, kind]) => kind === 'call')
  .map(([channel]) => channel);
const notifyChannels = Object.entries(FRAME_KIND)
  .filter(([, kind]) => kind === 'notify')
  .map(([channel]) => channel);
const eventChannels = Object.entries(FRAME_KIND)
  .filter(([, kind]) => kind === 'event')
  .map(([channel]) => channel);

beforeEach(() => {
  handlers.clear();
  listeners.clear();
  appListeners.clear();
  toastsRaised.length = 0;
  windows = [{ isDestroyed: () => false, isFocused: () => true }];
  vi.clearAllMocks();
});

afterEach(() => {
  resetRemoteProxy();
});

describe('registerRemoteProxy', () => {
  it('binds every call channel to the client', () => {
    expect(callChannels.length).toBe(98);

    registerRemoteProxy({ client: fakeClient(), broadcaster: fakeBroadcaster() });

    expect([...handlers.keys()].sort()).toEqual([...callChannels].sort());
  });

  it('binds every notify channel as a listener, not a handler', () => {
    expect(notifyChannels.length).toBe(6);

    registerRemoteProxy({ client: fakeClient(), broadcaster: fakeBroadcaster() });

    expect([...listeners.keys()].sort()).toEqual([...notifyChannels].sort());
    for (const channel of notifyChannels) expect(handlers.has(channel)).toBe(false);
  });

  it('binds no handler for an event channel', () => {
    expect(eventChannels.length).toBe(25);

    registerRemoteProxy({ client: fakeClient(), broadcaster: fakeBroadcaster() });

    for (const channel of eventChannels) {
      expect(handlers.has(channel)).toBe(false);
      expect(listeners.has(channel)).toBe(false);
    }
  });

  it('forwards a call channel to client.call', async () => {
    const client = fakeClient();
    registerRemoteProxy({ client, broadcaster: fakeBroadcaster() });

    await invoke('config:get', trustedEvent, undefined);

    expect(client.call).toHaveBeenCalledWith('config:get', undefined);
  });

  it('forwards a notify channel to client.notify, not client.call', () => {
    const client = fakeClient();
    registerRemoteProxy({ client, broadcaster: fakeBroadcaster() });

    const listener = listeners.get('pty:write');
    if (listener === undefined) throw new Error('pty:write was never bound');
    listener(trustedEvent, { data: 'hi' });

    expect(client.notify).toHaveBeenCalledWith('pty:write', { data: 'hi' });
    expect(client.call).not.toHaveBeenCalled();
  });

  /**
   * `ui:foreground` is the one payload this proxy enriches (HIVE-145).
   *
   * The server answering it has no windows of this machine to look at — a
   * served Mac usually has none of its own — so notification suppression would
   * be deciding "is the person looking at this session" from the wrong
   * machine's answer. The client stamps its own focus on the way past, and
   * `src/` keeps sending the one-key shape it sends in local mode.
   */
  describe('ui:foreground', () => {
    const report = (payload: unknown) => {
      const listener = listeners.get('ui:foreground');
      if (listener === undefined) throw new Error('ui:foreground was never bound');
      listener(trustedEvent, payload);
    };

    it('stamps this machine\'s focus onto the report', () => {
      const client = fakeClient();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster() });

      report({ terminalId: 'term-1' });

      expect(client.notify).toHaveBeenCalledWith('ui:foreground', {
        terminalId: 'term-1',
        focused: true,
      });
    });

    it('reports not focused when no window of ours has focus', () => {
      const client = fakeClient();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster() });
      windows = [{ isDestroyed: () => false, isFocused: () => false }];

      report({ terminalId: 'term-1' });

      expect(client.notify).toHaveBeenCalledWith('ui:foreground', {
        terminalId: 'term-1',
        focused: false,
      });
    });

    it('forwards a malformed report untouched, for the server to reject', () => {
      const client = fakeClient();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster() });

      report({ terminalId: 'term-1', extra: 1 });

      expect(client.notify).toHaveBeenCalledWith('ui:foreground', {
        terminalId: 'term-1',
        extra: 1,
      });
    });

    it('leaves every other notify payload alone', () => {
      const client = fakeClient();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster() });

      const listener = listeners.get('pty:write');
      if (listener === undefined) throw new Error('pty:write was never bound');
      listener(trustedEvent, { data: 'hi' });

      expect(client.notify).toHaveBeenCalledWith('pty:write', { data: 'hi' });
    });
  });

  /**
   * Drives every event channel, not just `pty:data` (review round 1). A
   * single-channel version of this test cannot fail against a proxy that
   * hard-codes `broadcaster.emit('pty:data', payload)` regardless of what
   * channel actually fired — "it arrived" and "it arrived as itself" are two
   * properties, and firing 24 distinct channels with distinct payloads is
   * what makes the second one checkable: a hard-coded channel mismatches on
   * the very first one that isn't `pty:data`.
   */
  it('pumps a client event into the broadcaster on the same channel', () => {
    expect(eventChannels.length).toBe(25);

    const client = fakeClient();
    const broadcaster = fakeBroadcaster();
    registerRemoteProxy({ client, broadcaster });

    /*
      All but one (HIVE-145). `notifications:toast` is answered by this process
      rather than forwarded: an Electron `Notification` is a main-process
      object, which is also why that channel is absent from `EVENT_CHANNELS`.
    */
    const forwarded = eventChannels.filter((channel) => channel !== 'notifications:toast');

    for (const channel of forwarded) {
      const payload = { channel };
      client.emit(channel, payload);
      expect(broadcaster.emit).toHaveBeenCalledWith(channel, payload);
    }
    expect(broadcaster.emit).toHaveBeenCalledTimes(forwarded.length);
  });

  it('raises a toast here rather than forwarding it to the window', () => {
    const client = fakeClient();
    const broadcaster = fakeBroadcaster();
    registerRemoteProxy({ client, broadcaster });

    client.emit('notifications:toast', {
      id: 'n1',
      kind: 'session.blocked',
      title: 'hero is blocked',
      body: 'waiting on you',
      action: { type: 'session', entityId: 'hero' },
    });

    expect(toastsRaised).toEqual([{ title: 'hero is blocked', body: 'waiting on you' }]);
    expect(broadcaster.emit).not.toHaveBeenCalled();
  });

  it("refuses each WINDOW_BOUND channel locally with the table's own reason", async () => {
    // 3 (HIVE-146): `themePick` and `themeSave` left the table with their
    // channels, because the renderer reads and writes a theme file itself now.
    // `configChooseDirectory` stayed — a server still cannot open a dialog, the
    // renderer just asks `config:browse-directory` instead of asking at all —
    // and `configReveal` is here for Ruling 25's reason rather than the event:
    // its effect lands on the answering machine, not the one the user is at.
    expect(Object.keys(WINDOW_BOUND).length).toBe(3);

    const client = fakeClient();
    registerRemoteProxy({ client, broadcaster: fakeBroadcaster() });

    for (const [channel, reason] of Object.entries(WINDOW_BOUND)) {
      await expect(invoke(channel, trustedEvent, undefined)).rejects.toMatchObject({
        message: reason,
        code: 'window-bound',
      });
    }
    // Refused locally, never forwarded to the socket.
    expect(client.call).not.toHaveBeenCalled();
  });

  it('records every binding, so the mode can be switched back', () => {
    registerRemoteProxy({ client: fakeClient(), broadcaster: fakeBroadcaster() });

    expect(remoteProxyBindingsSize()).toBe(104);
  });

  /**
   * `PROCESS_LOCAL` (HIVE-144, Ruling 24) — the opposite remedy from
   * `WINDOW_BOUND`'s: these three channels are still bound (the count above
   * does not move), but answered by *this* process rather than forwarded,
   * because every field of their payload describes the running process
   * rather than the fleet. See `isProcessLocal`'s own doc comment
   * (`@shared/remote-contract`) for the full argument and the sweep that
   * settled on exactly these three.
   */
  describe('PROCESS_LOCAL channels (HIVE-144, Rulings 24 and 28)', () => {
    it('names exactly four channels', () => {
      expect(PROCESS_LOCAL.length).toBe(4);
      expect([...PROCESS_LOCAL].sort()).toEqual(
        ['app:info', 'config:set-remote', 'updates:check', 'updates:status'].sort(),
      );
    });

    it('answers app:info from localAppInfo, never client.call', async () => {
      const client = fakeClient();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster(), localAppInfo: fakeAppInfo });

      await expect(invoke('app:info', trustedEvent, undefined)).resolves.toBe('FAKE_APP_INFO');

      expect(fakeAppInfo).toHaveBeenCalledTimes(1);
      expect(client.call).not.toHaveBeenCalled();
    });

    it('answers updates:status from the local updater, never client.call', async () => {
      const client = fakeClient();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster(), localAppInfo: fakeAppInfo });

      await expect(invoke('updates:status', trustedEvent, undefined)).resolves.toBe(
        'FAKE_UPDATE_STATUS',
      );

      expect(updateStatus).toHaveBeenCalledTimes(1);
      expect(client.call).not.toHaveBeenCalled();
    });

    it('answers updates:check from the local updater, never client.call', async () => {
      const client = fakeClient();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster(), localAppInfo: fakeAppInfo });

      await expect(invoke('updates:check', trustedEvent, undefined)).resolves.toBe(
        'FAKE_UPDATE_CHECK',
      );

      expect(checkForUpdatesInteractively).toHaveBeenCalledTimes(1);
      expect(client.call).not.toHaveBeenCalled();
    });

    /**
     * Without a `localAppInfo`, `app:info` must fail loudly rather than
     * silently forward — a caller that reaches this branch skipped
     * `router.ts` entirely, and forwarding instead would resurrect exactly
     * the bug Ruling 24 fixes with no test able to see it.
     */
    it('throws rather than forwarding app:info when no localAppInfo is supplied', async () => {
      const client = fakeClient();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster() });

      await expect(invoke('app:info', trustedEvent, undefined)).rejects.toThrow(
        /no localAppInfo supplied/,
      );
      expect(client.call).not.toHaveBeenCalled();
    });

    /*
      Ruling 28. The three above are reads; this one is the command, and it is
      the only entry on this list whose payload matters — a local answer that
      dropped it would detach a client that asked to be re-pointed, or
      re-point one that asked to detach.
    */
    it('answers config:set-remote from localSetRemote, with the payload, never client.call', async () => {
      const client = fakeClient();
      const localSetRemote = vi.fn().mockResolvedValue('FAKE_SET_REMOTE_RESULT');
      registerRemoteProxy({
        client,
        broadcaster: fakeBroadcaster(),
        localAppInfo: fakeAppInfo,
        localSetRemote,
      });

      await expect(
        invoke('config:set-remote', trustedEvent, { mode: 'local' }),
      ).resolves.toBe('FAKE_SET_REMOTE_RESULT');

      expect(localSetRemote).toHaveBeenCalledExactlyOnceWith({ mode: 'local' });
      expect(client.call).not.toHaveBeenCalled();
    });

    /*
      The failure this guards is worse than `app:info`'s. Forwarding a detach
      does not merely answer wrongly — it answers `{ ok: true }` for a detach
      that never happened, which is exactly what the defect looked like from
      the pane, so nothing downstream can tell the two apart. Loud, or not at
      all.
    */
    it('rejects rather than forwarding config:set-remote when no localSetRemote is supplied', async () => {
      const client = fakeClient();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster() });

      await expect(
        invoke('config:set-remote', trustedEvent, { mode: 'local' }),
      ).rejects.toThrow(/no localSetRemote supplied/);
      expect(client.call).not.toHaveBeenCalled();
    });
  });

  it('rejects a call from an untrusted sender before it reaches the client', async () => {
    const client = fakeClient();
    registerRemoteProxy({ client, broadcaster: fakeBroadcaster() });

    const untrustedEvent = { senderFrame: {}, sender: { mainFrame } } as never;

    await expect(invoke('config:get', untrustedEvent, undefined)).rejects.toThrow(/non-main frame/);
    expect(client.call).not.toHaveBeenCalled();
  });

  it('rejects a notify from an untrusted sender before it reaches the client', () => {
    const client = fakeClient();
    registerRemoteProxy({ client, broadcaster: fakeBroadcaster() });

    const listener = listeners.get('pty:write');
    if (listener === undefined) throw new Error('pty:write was never bound');
    const untrustedEvent = { senderFrame: {}, sender: { mainFrame } } as never;

    expect(() => listener(untrustedEvent, { data: 'x' })).toThrow(/non-main frame/);
    expect(client.notify).not.toHaveBeenCalled();
  });

  /**
   * The sibling `ipc/index.ts`'s own `on()` guards against, by name in its
   * own comment (review round 1): a `send` channel has no reply, so a throw
   * from the handler must not escape `ipcMain.on`'s callback — it is logged
   * and dropped instead. Not hypothetical: `client.notify` throws
   * `RemoteCallError('frame-too-large', …)` past
   * `POST_ATTACH_FRAME_MAX_BYTES`, and a large `pty:write` paste is the
   * realistic trigger named in `socket.ts`'s own comment.
   */
  it('logs and drops a notify that throws, rather than letting it escape', () => {
    const client = fakeClient();
    const thrown = new Error('frame too large');
    client.notify.mockImplementation(() => {
      throw thrown;
    });
    registerRemoteProxy({ client, broadcaster: fakeBroadcaster() });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const listener = listeners.get('pty:write');
    if (listener === undefined) throw new Error('pty:write was never bound');

    expect(() => listener(trustedEvent, { data: 'a very large paste' })).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith('[hive] rejected pty:write:', thrown);

    consoleError.mockRestore();
  });

  /**
   * Without this guard, a second `registerRemoteProxy()` call would silently
   * reassign `bindings` and `unsubscribe`, orphaning the first registration's
   * `notify` listeners against a stale client — `ipcMain.on` does not refuse
   * a duplicate the way `ipcMain.handle` does (review round 1).
   */
  it('refuses a second registration without a reset in between', () => {
    registerRemoteProxy({ client: fakeClient(), broadcaster: fakeBroadcaster() });

    expect(() =>
      registerRemoteProxy({ client: fakeClient(), broadcaster: fakeBroadcaster() }),
    ).toThrow(/resetRemoteProxy/);
  });

  it('unbinds every channel and stops pumping events on reset', () => {
    const client = fakeClient();
    const broadcaster = fakeBroadcaster();
    registerRemoteProxy({ client, broadcaster });

    resetRemoteProxy();

    // 104 (98 call + 6 notify), the same literal `records every binding`
    // pins — not `callChannels.length + notifyChannels.length`, which would
    // recompute its own expectation from the same source the code under test
    // reads and could never catch a channel silently lost between the two.
    expect(removeHandler).toHaveBeenCalledTimes(104);
    expect(removeAllListeners).toHaveBeenCalledTimes(104);
    expect(remoteProxyBindingsSize()).toBe(0);

    client.emit('pty:data', { seq: 2 });
    expect(broadcaster.emit).not.toHaveBeenCalled();
  });
});
