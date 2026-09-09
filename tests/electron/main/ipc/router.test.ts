import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: vi.fn(() => []) } }));
vi.mock('../../../../electron/main/ipc/index', () => ({ registerIpcHandlers }));
vi.mock('../../../../electron/main/ipc/remote-proxy', () => ({ registerRemoteProxy }));

const { registerIpc } = await import('../../../../electron/main/ipc/router');

/** A `RemoteClient` fake, fully implemented rather than cast away — the point
 * of this file is that `registerIpc` hands it through unchanged. */
function fakeClient() {
  return {
    call: vi.fn(),
    notify: vi.fn(),
    onEvent: vi.fn(),
    snapshot: vi.fn(),
    serverName: vi.fn(),
    close: vi.fn(),
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

    expect(registerIpcHandlers).toHaveBeenCalledWith(broadcaster);
  });

  /**
   * Undefined rather than a substitute, so `registerIpcHandlers` reaches its own
   * default. A router that manufactured a broadcaster here would be a second
   * place that decides where a push goes, and the first one to drift would win
   * silently.
   */
  it('leaves the default broadcaster to the handlers when none is given', () => {
    registerIpc('local');

    expect(registerIpcHandlers).toHaveBeenCalledWith(undefined);
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

    expect(registerRemoteProxy).toHaveBeenCalledWith({ client, broadcaster });
  });

  it('refuses remote mode without a client, and registers nothing', () => {
    expect(() => registerIpc('remote')).toThrow(/requires a client/);
    expect(registerRemoteProxy).not.toHaveBeenCalled();
    expect(registerIpcHandlers).not.toHaveBeenCalled();
  });
});
