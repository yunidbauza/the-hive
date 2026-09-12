// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteCallError, type CloseCause } from '../../../../electron/remote-client/socket';
import { CH, type AppInfo } from '../../../../electron/shared/ipc-contract';
import {
  FRAME_KIND,
  PAYLOAD_SCOPED,
  PROCESS_LOCAL,
  WINDOW_BOUND,
  isLocalOnlyEvent,
  payloadScopeFor,
} from '../../../../electron/shared/remote-contract';

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
 * `readLocalRemote` (HIVE-149), mocked for the reason the two above are: the
 * `PROCESS_LOCAL` arm imports it directly, so the spec controls what it answers
 * and can prove the arm reached *it* rather than `client.call`.
 */
const readLocalRemote = vi.fn(() => ({
  mode: 'remote',
  host: 'mini.tail1234.ts.net',
  port: 7433,
}));
vi.mock('../../../../electron/main/ipc/get-remote', () => ({ readLocalRemote }));

/**
 * `../notifications/activate-here` is mocked for `../updates`' reason exactly
 * (HIVE-151): it reaches `shell.openExternal` and this process's real updater,
 * and what those branches *do* is that module's own test's job. What this file
 * proves is narrower and is the whole of the routing question — that a
 * `notifications:act` payload reaches this function rather than `client.call`,
 * or the other way round, depending on the action it carries.
 */
const activateOnThisMachine = vi.fn();
vi.mock('../../../../electron/main/notifications/activate-here', () => ({
  activateOnThisMachine: (action: unknown) => activateOnThisMachine(action),
  focusThisMachine: vi.fn(),
}));

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
 * them (104, 6, 26, 110) are literals, not read back off the derived lists.
 * `tests/shared/remote-contract.test.ts:82,125` pins the same four numbers
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
const setBadge = vi.fn();
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
    // HIVE-159: the attached client badges its own dock from its renderer's count.
    dock: { setBadge, bounce: vi.fn() },
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

const { countsAsAction, lostToTheLink, registerRemoteProxy, remoteProxyBindingsSize, resetRemoteProxy } = await import(
  '../../../../electron/main/ipc/remote-proxy'
);
const { createResumeTracker } = await import('../../../../electron/main/ipc/resume-tracker');

/** Matches `foreground.test.ts`'s trusted-sender fixture: identity, not shape. */
const mainFrame = { url: 'file:///out/renderer/index.html' };
const trustedEvent = { senderFrame: mainFrame, sender: { mainFrame } } as never;

function fakeClient() {
  const eventListeners = new Set<(channel: string, payload: unknown) => void>();
  const closeListeners = new Set<(cause: CloseCause) => void>();
  return {
    call: vi.fn().mockResolvedValue('ok'),
    notify: vi.fn(),
    onEvent: vi.fn((listener: (channel: string, payload: unknown) => void) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    }),
    snapshot: vi.fn(),
    serverName: vi.fn(),
    onClose: vi.fn((listener: (cause: CloseCause) => void) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    }),
    close: vi.fn(),
    /** Test-only: fire an event as the real socket's fan-out would. */
    emit(channel: string, payload: unknown) {
      for (const listener of eventListeners) listener(channel, payload);
    },
    /** Test-only: end the connection as the real socket's handlers would. */
    drop(cause: CloseCause = { kind: 'transport', code: 'transport', message: 'closed' }) {
      for (const listener of closeListeners) listener(cause);
      closeListeners.clear();
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
    expect(callChannels.length).toBe(104);

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
    expect(eventChannels.length).toBe(26);

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
    expect(eventChannels.length).toBe(26);

    const client = fakeClient();
    const broadcaster = fakeBroadcaster();
    registerRemoteProxy({ client, broadcaster });

    /*
      All but two. `notifications:toast` is answered by this process rather
      than forwarded (HIVE-145): an Electron `Notification` is a main-process
      object, which is also why that channel is absent from `EVENT_CHANNELS`.
      `remote:link-status` is dropped outright (HIVE-150) — see the test below.
    */
    const forwarded = eventChannels.filter(
      (channel) => channel !== 'notifications:toast' && !isLocalOnlyEvent(channel),
    );

    for (const channel of forwarded) {
      const payload = { channel };
      client.emit(channel, payload);
      expect(broadcaster.emit).toHaveBeenCalledWith(channel, payload);
    }
    expect(broadcaster.emit).toHaveBeenCalledTimes(forwarded.length);
  });

  /**
   * A server's own link status is not this window's (HIVE-150).
   *
   * The push counterpart of `PROCESS_LOCAL`. A served machine that is itself
   * attached to a third Hive raises `remote:link-status` about *its* socket;
   * forwarded, every client's header chip would start reporting a link it has
   * no part in — and would go amber for a reconnect happening on someone else's
   * machine. Exactly the defect `PROCESS_LOCAL` closed for `app:info`, where an
   * attached client's About box reported the server's Electron version as its
   * own.
   */
  it('drops a local-only event arriving from the socket', () => {
    const client = fakeClient();
    const broadcaster = fakeBroadcaster();
    registerRemoteProxy({ client, broadcaster });

    client.emit(CH.remoteLinkStatus, {
      state: 'reconnecting',
      serverName: 'somewhere-else',
      attempt: 3,
      nextAttemptAt: null,
      reason: null,
      epoch: 0,
    });

    expect(broadcaster.emit).not.toHaveBeenCalled();
  });

  /**
   * Feeding the resume tracker (HIVE-150).
   *
   * The two signals come from opposite directions and the proxy is the one
   * place that sees both: `pty:data` arriving from the socket carries the
   * `{gen, seq}` a reconnect resumes from, and `pty:ack` leaving for the socket
   * is what says a terminal is actually mounted here — HIVE-145's ruling that
   * being attached is not the same as watching.
   */
  describe('the resume tracker', () => {
    it('records the generation and sequence of arriving output', () => {
      const client = fakeClient();
      const resumeTracker = createResumeTracker();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster(), resumeTracker });

      resumeTracker.markWatched('sess-a');
      client.emit(CH.ptyData, { sessionId: 'sess-a', chunk: 'hi', gen: 2, seq: 17 });

      expect(resumeTracker.points()).toEqual([
        { sessionId: 'sess-a', point: { gen: 2, seq: 17 } },
      ]);
    });

    it('marks a session watched when this surface acks it', () => {
      const client = fakeClient();
      const resumeTracker = createResumeTracker();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster(), resumeTracker });

      client.emit(CH.ptyData, { sessionId: 'sess-a', chunk: 'hi', gen: 2, seq: 17 });
      // Nothing has mounted it yet, so it is not worth a slot in the frame.
      expect(resumeTracker.points()).toEqual([]);

      listeners.get(CH.ptyAck)?.(trustedEvent, { sessionId: 'sess-a', seq: 17 });

      expect(resumeTracker.points()).toEqual([
        { sessionId: 'sess-a', point: { gen: 2, seq: 17 } },
      ]);
    });

    it('leaves delivery alone in both directions', () => {
      const client = fakeClient();
      const broadcaster = fakeBroadcaster();
      const resumeTracker = createResumeTracker();
      registerRemoteProxy({ client, broadcaster, resumeTracker });

      const data = { sessionId: 'sess-a', chunk: 'hi', gen: 2, seq: 17 };
      client.emit(CH.ptyData, data);
      listeners.get(CH.ptyAck)?.(trustedEvent, { sessionId: 'sess-a', seq: 17 });

      /*
        The taps observe, they do not intercept. A `pty:data` that stopped
        reaching the window would be a black terminal, and an ack that stopped
        reaching the socket would stall the session behind its own flow control.
      */
      expect(broadcaster.emit).toHaveBeenCalledWith(CH.ptyData, data);
      expect(client.notify).toHaveBeenCalledWith(CH.ptyAck, {
        sessionId: 'sess-a',
        seq: 17,
      });
    });

    it('binds without one, so every existing caller keeps working', () => {
      const client = fakeClient();
      const broadcaster = fakeBroadcaster();

      expect(() => {
        registerRemoteProxy({ client, broadcaster });
        client.emit(CH.ptyData, { sessionId: 'sess-a', chunk: 'hi', gen: 1, seq: 1 });
        listeners.get(CH.ptyAck)?.(trustedEvent, { sessionId: 'sess-a', seq: 1 });
      }).not.toThrow();
    });

    it('survives a malformed frame rather than taking the pump down with it', () => {
      const client = fakeClient();
      const broadcaster = fakeBroadcaster();
      const resumeTracker = createResumeTracker();
      registerRemoteProxy({ client, broadcaster, resumeTracker });

      /*
        A server is not required to be well-behaved, and this pump runs inside
        `ws`'s own emit — a throw here would abort the fan-out for every other
        subscriber and surface as an uncaught exception in main.
      */
      expect(() => {
        client.emit(CH.ptyData, null);
        client.emit(CH.ptyData, { sessionId: 'sess-a' });
        client.emit(CH.ptyData, { sessionId: 42, gen: 'x', seq: {} });
      }).not.toThrow();

      expect(resumeTracker.points()).toEqual([]);
    });
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

    expect(remoteProxyBindingsSize()).toBe(110);
  });

  /**
   * `PROCESS_LOCAL` (HIVE-144, Ruling 24) — the opposite remedy from
   * `WINDOW_BOUND`'s: these channels are still bound (the count above does not
   * move), but answered by *this* process rather than forwarded, because every
   * field of their payload describes the running process rather than the
   * fleet. See `isProcessLocal`'s own doc comment (`@shared/remote-contract`)
   * for the full argument and the sweep that settled on the first three, then
   * on `config:set-remote` (Ruling 28), then on `remote:pair` and
   * `remote:forget` (HIVE-153).
   */
  describe('PROCESS_LOCAL channels (HIVE-144 Rulings 24 and 28, HIVE-153, HIVE-149, HIVE-151)', () => {
    it('names exactly nine channels', () => {
      expect(PROCESS_LOCAL.length).toBe(9);
      expect([...PROCESS_LOCAL].sort()).toEqual(
        [
          'app:info',
          'config:get-remote',
          'config:set-remote',
          'notifications:badge',
          'notifications:delivery',
          'remote:forget',
          'remote:pair',
          'updates:check',
          'updates:status',
        ].sort(),
      );
    });

    /*
      Structural, rather than mediated by the count above (self review, item
      7). `localAnswerFor`'s `default` arm returns `null`, and a `null` local
      answer falls straight through to `client.call` — so a seventh channel
      added to `PROCESS_LOCAL` and forgotten in that switch would be proxied
      again, silently, which is the exact defect the list exists to prevent.

      The length assertion makes someone look; this makes the compiler's job
      the test's job. Every member must resolve to something, and nothing on
      the list may reach the socket. Deliberately driven through `invoke`
      rather than by reading the switch, because what is being pinned is the
      binding's behaviour, not the helper's shape.
    */
    it('answers every PROCESS_LOCAL channel locally, with the socket untouched', async () => {
      const client = fakeClient();
      registerRemoteProxy({
        client,
        broadcaster: fakeBroadcaster(),
        localAppInfo: fakeAppInfo,
        localSetRemote: vi.fn().mockResolvedValue(undefined),
        localRemotePair: vi.fn().mockReturnValue({ paired: true }),
        localRemoteForget: vi.fn(),
      });

      for (const channel of PROCESS_LOCAL) {
        await invoke(channel, trustedEvent, { deviceId: 'laptop', token: 'sekret' });
      }

      expect(client.call).not.toHaveBeenCalled();
    });

    /*
      HIVE-159. While attached no hub runs in this process, so the renderer's
      count is the only one describing the inbox on this screen, and the dock
      it belongs on is this machine's.
    */
    it('answers notifications:badge by badging this machine\'s dock, never client.call', async () => {
      const client = fakeClient();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster(), localAppInfo: fakeAppInfo });
      setBadge.mockClear();

      await invoke('notifications:badge', trustedEvent, 4);

      expect(setBadge).toHaveBeenCalledWith('4');
      expect(client.call).not.toHaveBeenCalled();
    });

    /*
      HIVE-159. macOS keeps the app alive with no window, and with the renderer
      gone nothing can keep the count current. A stale number is a lie about an
      inbox nobody is displaying, so the badge goes with the last window.
    */
    it('clears the dock badge when the last window closes while attached', () => {
      registerRemoteProxy({ client: fakeClient(), broadcaster: fakeBroadcaster(), localAppInfo: fakeAppInfo });
      setBadge.mockClear();

      for (const listener of appListeners.get('window-all-closed') ?? []) listener();

      expect(setBadge).toHaveBeenCalledWith('');
    });

    it('stops watching for the last window once reset', () => {
      registerRemoteProxy({ client: fakeClient(), broadcaster: fakeBroadcaster(), localAppInfo: fakeAppInfo });
      resetRemoteProxy();

      expect(appListeners.get('window-all-closed')?.size ?? 0).toBe(0);
    });

    it('answers app:info from localAppInfo, never client.call', async () => {
      const client = fakeClient();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster(), localAppInfo: fakeAppInfo });

      await expect(invoke('app:info', trustedEvent, undefined)).resolves.toBe('FAKE_APP_INFO');

      expect(fakeAppInfo).toHaveBeenCalledTimes(1);
      expect(client.call).not.toHaveBeenCalled();
    });

    /*
      HIVE-149. The defect in one assertion: while attached, asking for this
      machine's own `remote` block must not reach the socket, because what comes
      back over it describes the *server* — whose own `mode` reads `local`,
      because the server is the thing being attached to.
    */
    it('answers config:get-remote from this process, never client.call', async () => {
      const client = fakeClient();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster(), localAppInfo: fakeAppInfo });

      await expect(invoke('config:get-remote', trustedEvent, undefined)).resolves.toEqual({
        mode: 'remote',
        host: 'mini.tail1234.ts.net',
        port: 7433,
      });

      expect(readLocalRemote).toHaveBeenCalledTimes(1);
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

    /*
      HIVE-153. The defect these two close is the one this list exists for,
      arriving through the credential rather than the config file: while they
      were proxied, a Forget click on an attached client cleared the
      *server's* stored credential — the far machine's own pairing revoked
      from the near machine's UI, and the clicking user's credential left
      exactly where it was.

      `client.call` is asserted silent in both, because forwarding is the
      whole defect. A local answer that merely *also* forwarded would clear
      both credentials, which is worse than what shipped.
    */
    it('answers remote:pair from localRemotePair, with the payload, never client.call', async () => {
      const client = fakeClient();
      const localRemotePair = vi.fn().mockReturnValue({ paired: true });
      registerRemoteProxy({
        client,
        broadcaster: fakeBroadcaster(),
        localAppInfo: fakeAppInfo,
        localRemotePair,
      });

      await expect(
        invoke('remote:pair', trustedEvent, { deviceId: 'laptop', token: 'sekret' }),
      ).resolves.toEqual({ paired: true });

      expect(localRemotePair).toHaveBeenCalledExactlyOnceWith({
        deviceId: 'laptop',
        token: 'sekret',
      });
      expect(client.call).not.toHaveBeenCalled();
    });

    it('answers remote:forget from localRemoteForget, never client.call', async () => {
      const client = fakeClient();
      const localRemoteForget = vi.fn();
      registerRemoteProxy({
        client,
        broadcaster: fakeBroadcaster(),
        localAppInfo: fakeAppInfo,
        localRemoteForget,
      });

      await expect(invoke('remote:forget', trustedEvent, undefined)).resolves.toBeUndefined();

      expect(localRemoteForget).toHaveBeenCalledOnce();
      expect(client.call).not.toHaveBeenCalled();
    });

    /*
      Loud, or not at all — `noLocalSetRemote`'s reasoning, for a verb whose
      quiet failure is a pairing dialog reporting success over a credential
      this machine does not hold.
    */
    it('throws rather than forwarding remote:pair when no localRemotePair is supplied', async () => {
      const client = fakeClient();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster() });

      await expect(
        invoke('remote:pair', trustedEvent, { deviceId: 'laptop', token: 'sekret' }),
      ).rejects.toThrow(/no localRemotePair supplied/);
      expect(client.call).not.toHaveBeenCalled();
    });

    it('throws rather than forwarding remote:forget when no localRemoteForget is supplied', async () => {
      const client = fakeClient();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster() });

      await expect(invoke('remote:forget', trustedEvent, undefined)).rejects.toThrow(
        /no localRemoteForget supplied/,
      );
      expect(client.call).not.toHaveBeenCalled();
    });
  });

  /**
   * The fourth routing shape, and the only per-call one (HIVE-151).
   *
   * `WINDOW_BOUND` and `PROCESS_LOCAL` are facts about a *channel* and are
   * resolved once, at registration. `notifications:act` cannot be either: it
   * carries seven verbs, three of which reach this machine's hardware and four
   * of which resolve against fleet state the client does not hold. Proxied
   * wholesale — which is what it was — a `url` click opened a browser on the
   * server and `update.install` drove the server's updater.
   *
   * Driven through `invoke` rather than by reading the table, for the reason
   * the `PROCESS_LOCAL` block above gives: what is pinned is the binding's
   * behaviour, not the helper's shape.
   */
  describe('PAYLOAD_SCOPED: notifications:act routes per action (HIVE-151)', () => {
    const proxy = () => {
      const client = fakeClient();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster() });
      return client;
    };

    it.each([
      ['url', { type: 'url', url: 'https://example.com' }],
      ['update.download', { type: 'update.download' }],
      ['update.install', { type: 'update.install' }],
    ])('answers a %s action here, with the socket untouched', async (_name, action) => {
      const client = proxy();

      await invoke('notifications:act', trustedEvent, action);

      expect(activateOnThisMachine).toHaveBeenCalledWith(action);
      expect(client.call).not.toHaveBeenCalled();
    });

    it.each([
      ['ask', { type: 'ask', thread: 't1' }],
      ['session', { type: 'session', entityId: 's1' }],
      ['agent', { type: 'agent', name: 'scout' }],
      ['none', { type: 'none' }],
    ])('forwards a %s action to the socket unchanged', async (_name, action) => {
      const client = proxy();

      await invoke('notifications:act', trustedEvent, action);

      expect(client.call).toHaveBeenCalledWith('notifications:act', action);
      expect(activateOnThisMachine).not.toHaveBeenCalled();
    });

    /*
      Proxied rather than claimed. The far end runs the same parse and reaches
      the same conclusion, so nothing happens either way — but answering it
      here would let a malformed payload pick its own machine, which is the
      class of defect this table closes rather than one it should open.
    */
    it.each([
      ['a url with no url', { type: 'url' }],
      ['a url whose url is not a string', { type: 'url', url: 42 }],
      ['a verb this build does not know', { type: 'not-a-verb' }],
      ['an empty object', {}],
      ['null', null],
    ])('forwards %s rather than acting on it here', async (_name, payload) => {
      const client = proxy();

      await invoke('notifications:act', trustedEvent, payload);

      expect(activateOnThisMachine).not.toHaveBeenCalled();
      expect(client.call).toHaveBeenCalledWith('notifications:act', payload);
    });

    /*
      Membership, not ordering — and the distinction is worth stating, because
      this case cannot test the ordering and used to claim it did.

      `config:choose-directory` is not in `PAYLOAD_SCOPED`, so `payloadScopeFor`
      answers `null` and the payload branch is skipped wherever it sits in the
      handler. Moving that branch above the `WINDOW_BOUND` check — the exact
      inversion the old name forbade — left this file green. The mutation
      survived, so the assertion was vacuous.

      No ordering can be exercised through the public surface while the three
      tables are disjoint, because no channel is on two of them for an order to
      decide between. **Disjointness is the real guarantee**, and it is pinned
      in `tests/shared/remote-contract.test.ts`. What this case does prove is
      still worth having: a `WINDOW_BOUND` channel is refused, and a payload
      that would otherwise route locally does not rescue it.
    */
    it('refuses a WINDOW_BOUND channel even when handed a this-machine payload', async () => {
      const client = proxy();

      await expect(
        invoke('config:choose-directory', trustedEvent, { type: 'url', url: 'https://x.com' }),
      ).rejects.toMatchObject({ code: 'window-bound' });
      expect(activateOnThisMachine).not.toHaveBeenCalled();
      expect(client.call).not.toHaveBeenCalled();
    });

    /*
      Structural, and the counterpart to the `PROCESS_LOCAL` case above.
      `payloadAnswerFor` answers `null` for anything but `notifications:act`, so
      a second entry added to `PAYLOAD_SCOPED` and forgotten there would be
      proxied whatever its predicate said. That fails safe rather than
      dangerous — but silently, and "the table said local, the proxy sent it
      anyway" is precisely the disagreement this shape exists to prevent.
    */
    it('answers every PAYLOAD_SCOPED channel locally for a payload its own predicate claims', async () => {
      const client = proxy();

      for (const channel of Object.keys(PAYLOAD_SCOPED)) {
        const scope = payloadScopeFor(channel);
        expect(scope, `${channel} is in PAYLOAD_SCOPED but has no predicate`).not.toBeNull();
        // The one payload every current member agrees is this machine's.
        const payload = { type: 'url', url: 'https://example.com' };
        if (scope?.(payload) !== true) continue;
        await invoke(channel, trustedEvent, payload);
      }

      expect(client.call).not.toHaveBeenCalled();
      expect(activateOnThisMachine).toHaveBeenCalled();
    });

    it('leaves every other call channel routed by name alone', async () => {
      const client = proxy();

      await invoke('config:get', trustedEvent, { type: 'url', url: 'https://example.com' });

      expect(activateOnThisMachine).not.toHaveBeenCalled();
      expect(client.call).toHaveBeenCalledWith('config:get', {
        type: 'url',
        url: 'https://example.com',
      });
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
   * HIVE-140 audit, gap 1: what a dead link swallowed is counted, so the chip
   * can say so. What the server itself refused is not: it arrived.
   */
  describe('counting what the link lost', () => {
    it('tells a dead link from a server refusal', () => {
      expect(lostToTheLink(new Error('Cannot call config:reload: the connection to mini is closed.'))).toBe(true);
      expect(lostToTheLink(new RemoteCallError('connection-closed', 'closed'))).toBe(true);
      expect(lostToTheLink(new RemoteCallError('window-bound', 'no window'))).toBe(false);
      expect(lostToTheLink(new RemoteCallError('frame-too-large', 'too big'))).toBe(false);
      expect(lostToTheLink('not an error')).toBe(false);
    });

    it('counts a call the closed link rejected, and still rejects it', async () => {
      const client = fakeClient();
      const lost = new Error('Cannot call config:reload: the connection to mini is closed.');
      client.call.mockRejectedValue(lost);
      const onLinkLoss = vi.fn();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster(), onLinkLoss });

      await expect(invoke(CH.configReload, trustedEvent, {})).rejects.toBe(lost);
      expect(onLinkLoss).toHaveBeenCalledTimes(1);
    });

    /**
     * Review round 1: the PR and ticket sweeps poll every minute whether or not
     * the link is up, and counting their failures told an idle user that a
     * sleeping server had eaten ten of their "actions".
     */
    it('counts only what the user did: no reads, no background polls, no acks', () => {
      expect(countsAsAction(CH.configReload, 'call')).toBe(true);
      expect(countsAsAction(CH.ledgerPost, 'call')).toBe(true);
      expect(countsAsAction(CH.configGet, 'call')).toBe(false);
      expect(countsAsAction(CH.jiraSearch, 'call')).toBe(false);
      expect(countsAsAction(CH.githubPrs, 'call')).toBe(false);
      expect(countsAsAction(CH.ptyWrite, 'notify')).toBe(true);
      expect(countsAsAction(CH.ptyAck, 'notify')).toBe(false);
      expect(countsAsAction(CH.ptyResize, 'notify')).toBe(false);
    });

    it('does not count a read the closed link rejected', async () => {
      const client = fakeClient();
      client.call.mockRejectedValue(new Error('Cannot call config:get: the connection to mini is closed.'));
      const onLinkLoss = vi.fn();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster(), onLinkLoss });

      await expect(invoke(CH.configGet, trustedEvent, {})).rejects.toThrow(/is closed/);
      expect(onLinkLoss).not.toHaveBeenCalled();
    });

    it('does not count a call the server refused', async () => {
      const client = fakeClient();
      client.call.mockRejectedValue(new RemoteCallError('outside', 'EOUTSIDE'));
      const onLinkLoss = vi.fn();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster(), onLinkLoss });

      await expect(invoke(CH.configReload, trustedEvent, {})).rejects.toBeInstanceOf(RemoteCallError);
      expect(onLinkLoss).not.toHaveBeenCalled();
    });

    it('counts a keystroke the closed link refused, and nothing it sent', () => {
      const client = fakeClient();
      const onLinkLoss = vi.fn();
      registerRemoteProxy({ client, broadcaster: fakeBroadcaster(), onLinkLoss });
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const write = listeners.get('pty:write');
      if (write === undefined) throw new Error('pty:write was never bound');

      write(trustedEvent, { sessionId: 's1', data: 'a' });
      expect(onLinkLoss).not.toHaveBeenCalled();

      client.notify.mockImplementation(() => {
        throw new RemoteCallError('connection-closed', 'Cannot send pty:write: closed.');
      });
      write(trustedEvent, { sessionId: 's1', data: 'b' });
      expect(onLinkLoss).toHaveBeenCalledTimes(1);

      consoleError.mockRestore();
    });
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

    // 110 (104 call + 6 notify), the same literal `records every binding`
    // pins — not `callChannels.length + notifyChannels.length`, which would
    // recompute its own expectation from the same source the code under test
    // reads and could never catch a channel silently lost between the two.
    expect(removeHandler).toHaveBeenCalledTimes(110);
    expect(removeAllListeners).toHaveBeenCalledTimes(110);
    expect(remoteProxyBindingsSize()).toBe(0);

    client.emit('pty:data', { seq: 2 });
    expect(broadcaster.emit).not.toHaveBeenCalled();
  });
});
