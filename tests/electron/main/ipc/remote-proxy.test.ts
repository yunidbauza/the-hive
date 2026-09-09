// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FRAME_KIND, WINDOW_BOUND } from '../../../../electron/shared/remote-contract';

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
 * them (99, 6, 22, 105) are literals, not read back off the derived lists.
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

vi.mock('electron', () => ({
  ipcMain: { handle, on, removeHandler, removeAllListeners },
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
  vi.clearAllMocks();
});

afterEach(() => {
  resetRemoteProxy();
});

describe('registerRemoteProxy', () => {
  it('binds every call channel to the client', () => {
    expect(callChannels.length).toBe(99);

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
    expect(eventChannels.length).toBe(22);

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
   * Drives every event channel, not just `pty:data` (review round 1). A
   * single-channel version of this test cannot fail against a proxy that
   * hard-codes `broadcaster.emit('pty:data', payload)` regardless of what
   * channel actually fired — "it arrived" and "it arrived as itself" are two
   * properties, and firing 22 distinct channels with distinct payloads is
   * what makes the second one checkable: a hard-coded channel mismatches on
   * the very first one that isn't `pty:data`.
   */
  it('pumps a client event into the broadcaster on the same channel', () => {
    expect(eventChannels.length).toBe(22);

    const client = fakeClient();
    const broadcaster = fakeBroadcaster();
    registerRemoteProxy({ client, broadcaster });

    for (const channel of eventChannels) {
      const payload = { channel };
      client.emit(channel, payload);
      expect(broadcaster.emit).toHaveBeenCalledWith(channel, payload);
    }
    expect(broadcaster.emit).toHaveBeenCalledTimes(eventChannels.length);
  });

  it("refuses each WINDOW_BOUND channel locally with the table's own reason", async () => {
    expect(Object.keys(WINDOW_BOUND).length).toBe(4);

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

    expect(remoteProxyBindingsSize()).toBe(105);
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

    // 105 (99 call + 6 notify), the same literal `records every binding`
    // pins — not `callChannels.length + notifyChannels.length`, which would
    // recompute its own expectation from the same source the code under test
    // reads and could never catch a channel silently lost between the two.
    expect(removeHandler).toHaveBeenCalledTimes(105);
    expect(removeAllListeners).toHaveBeenCalledTimes(105);
    expect(remoteProxyBindingsSize()).toBe(0);

    client.emit('pty:data', { seq: 2 });
    expect(broadcaster.emit).not.toHaveBeenCalled();
  });
});
