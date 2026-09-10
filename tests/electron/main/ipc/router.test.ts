import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CloseCause } from '../../../../electron/remote-client/socket';

/**
 * The mode switch in front of `registerIpcHandlers` and `registerRemoteProxy`
 * (HIVE-141, HIVE-144).
 *
 * Both are mocked here rather than run: the eight suites that exercise
 * `registerIpcHandlers` for real each build a full main-process fixture, and
 * `remote-proxy.test.ts` is what exercises `registerRemoteProxy` for real.
 * What is being tested is one branch — which mode reaches which function,
 * which does not, and that the broadcaster and client are handed through
 * rather than swallowed.
 *
 * `electron` is mocked too, purely because `./router` now imports
 * `./broadcaster` for its remote-mode default — `createWindowBroadcaster`
 * reads `BrowserWindow` at call time, and the real `electron` package resolves
 * to a path string outside an actual Electron process (`node_modules/electron/index.js`),
 * not the module API. `getAllWindows` is never actually invoked in this file:
 * `registerRemoteProxy` is mocked, so nothing here calls `.emit()`.
 */

const registerIpcHandlers = vi.fn();
const registerRemoteProxy = vi.fn();

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  /*
    HIVE-150. The reconnect loop asks to be told when this machine wakes, so a
    lid opening reattaches at once rather than waiting out the backoff step it
    was parked on. Modelled here because `router.ts` really reads it.
  */
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
}));
vi.mock('../../../../electron/main/ipc/index', () => ({ registerIpcHandlers }));
vi.mock('../../../../electron/main/ipc/remote-proxy', () => ({ registerRemoteProxy }));

const { registerIpc, switchIpcMode } = await import('../../../../electron/main/ipc/router');

/** A `RemoteClient` fake, fully implemented rather than cast away — the point
 * of this file is that `registerIpc` hands it through unchanged. */
function fakeClient() {
  const closeListeners = new Set<(cause: CloseCause) => void>();
  return {
    call: vi.fn(),
    notify: vi.fn(),
    onEvent: vi.fn(),
    snapshot: vi.fn(),
    serverName: vi.fn(),
    onClose: vi.fn((listener: (cause: CloseCause) => void) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    }),
    close: vi.fn(),
    /** Test-only: end the connection as the real socket's handlers would. */
    drop(cause: CloseCause = { kind: 'transport', code: 'transport', message: 'closed' }) {
      for (const listener of closeListeners) listener(cause);
      closeListeners.clear();
    },
  };
}

beforeEach(() => {
  registerIpcHandlers.mockClear();
  registerRemoteProxy.mockClear();
});

describe('registerIpc', () => {
  it('binds the local handlers in local mode', () => {
    registerIpc('local');

    expect(registerIpcHandlers).toHaveBeenCalledTimes(1);
  });

  it('passes the broadcaster through to the handlers', () => {
    const broadcaster = { emit: vi.fn() };

    registerIpc('local', { broadcaster });

    expect(registerIpcHandlers).toHaveBeenCalledWith(
      broadcaster,
      switchIpcMode,
      expect.any(Function),
      expect.any(Function),
    );
  });

  /**
   * The switch itself, by identity (HIVE-144). `config:set-remote`'s handler
   * can only change this process's mode through what it is handed here — the
   * reverse import would close a cycle — so a registration that forgot the
   * second argument would leave that verb writing `mode: "remote"` to disk
   * over a switch that never happened. `noModeSwitcher` throws rather than
   * letting that pass quietly, but this is the assertion that keeps the real
   * one wired.
   */
  it('hands the handlers the real mode switch', () => {
    registerIpc('local');

    expect(registerIpcHandlers).toHaveBeenCalledWith(
      undefined,
      switchIpcMode,
      expect.any(Function),
      expect.any(Function),
    );
  });

  /**
   * Undefined rather than a substitute, so `registerIpcHandlers` reaches its own
   * default. A router that manufactured a broadcaster here would be a second
   * place that decides where a push goes, and the first one to drift would win
   * silently.
   */
  it('leaves the default broadcaster to the handlers when none is given', () => {
    registerIpc('local');

    expect(registerIpcHandlers).toHaveBeenCalledWith(
      undefined,
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  /**
   * `router.ts`'s own `attachedServerName()` (HIVE-144, Task 13) — handed
   * down the same way `switchIpcMode` is and for the identical reason: the
   * reverse import would close a cycle. A registration that forgot this
   * argument would leave `AppInfo.attachedServerName` answering `null` off
   * `registerIpcHandlers`'s own no-op default forever, in every mode.
   */
  it('hands the handlers the real attachedServerName reader', async () => {
    registerIpc('local');

    const { attachedServerName } = await import('../../../../electron/main/ipc/router');
    expect(registerIpcHandlers).toHaveBeenCalledWith(
      undefined,
      switchIpcMode,
      attachedServerName,
      expect.any(Function),
    );
  });

  /**
   * `router.ts`'s own `attachedSnapshot()` (HIVE-144 review, I1) — the reader
   * that turns the accept frame's snapshot into something `applySetRemote`
   * can report. Forgetting it would leave `SetRemoteResult.changed` answering
   * `null` off the no-op default forever, which is the state the whole
   * attach-snapshot path was in before this fix: built, sent, and dropped.
   */
  it('hands the handlers the real attachedSnapshot reader', async () => {
    registerIpc('local');

    const { attachedSnapshot } = await import('../../../../electron/main/ipc/router');
    expect(registerIpcHandlers).toHaveBeenCalledWith(
      undefined,
      switchIpcMode,
      expect.any(Function),
      attachedSnapshot,
    );
  });

  it('registers the remote proxy in remote mode, and binds nothing locally', () => {
    const client = fakeClient();

    registerIpc('remote', { client });

    expect(registerRemoteProxy).toHaveBeenCalledTimes(1);
    expect(registerIpcHandlers).not.toHaveBeenCalled();
  });

  it('forwards the client and a default window broadcaster to the proxy', () => {
    const client = fakeClient();

    registerIpc('remote', { client });

    expect(registerRemoteProxy).toHaveBeenCalledWith({
      client,
      broadcaster: { emit: expect.any(Function) },
      // Ruling 28: the proxy answers `config:set-remote` itself, so the router
      // has to hand it something that can. Asserted here rather than only in
      // `remote-proxy.test.ts` because a router that stopped passing one would
      // leave the proxy on its rejecting default — a detach that fails loudly
      // instead of one that works.
      localSetRemote: expect.any(Function),
    });
  });

  /**
   * The router's own default must not be the one the proxy sees when a
   * caller supplies its own — a router that ignored an explicit broadcaster
   * would be a second place deciding where a push goes, the same bug the
   * local-mode test above guards against.
   */
  it('forwards an explicit broadcaster instead of manufacturing one', () => {
    const client = fakeClient();
    const broadcaster = { emit: vi.fn() };

    registerIpc('remote', { client, broadcaster });

    expect(registerRemoteProxy).toHaveBeenCalledWith({
      client,
      broadcaster,
      localSetRemote: expect.any(Function),
    });
  });

  it('refuses remote mode without a client, and registers nothing', () => {
    expect(() => registerIpc('remote')).toThrow(/requires a client/);
    expect(registerRemoteProxy).not.toHaveBeenCalled();
    expect(registerIpcHandlers).not.toHaveBeenCalled();
  });

  /**
   * `localAppInfo` (HIVE-144, Ruling 24): the router hands `registerRemoteProxy`
   * the *exact* closure the most recent local registration's `registerIpcHandlers`
   * call returned — over that call's own `hooks`, `remoteListener` and
   * `sessions` — never a substitute. A proxy sourced any other way would
   * answer `CH.appInfo` from whichever instances happened to be lying
   * around, which is the bug this ruling exists to close. `mockReturnValueOnce`
   * rather than a persistent mock, so this fake cannot leak into another
   * test in this file that also exercises the 'remote' branch.
   */
  it("threads the local registration's own AppInfo answer into the remote proxy", () => {
    const localAppInfo = () => ({ version: 'fake' });
    registerIpcHandlers.mockReturnValueOnce(localAppInfo);

    registerIpc('local');
    const client = fakeClient();
    registerIpc('remote', { client });

    expect(registerRemoteProxy).toHaveBeenCalledWith(
      expect.objectContaining({ localAppInfo }),
    );
  });
});
