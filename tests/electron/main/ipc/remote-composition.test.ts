// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptySnapshot } from '../../../../electron/shared/config-contract';

/**
 * The composition HIVE-143 exists for: the module-scope registry `handle` and
 * `on` record into, and the socket half of the fan-out.
 *
 * Mocked the way `ledger-channels.test.ts` and `notification-broadcast.test.ts`
 * mock this module, and for the same reason — `ipc/index.ts` reaches Electron,
 * the pty host and the config at module scope, so the fakes have to be
 * installed before the dynamic import below. Nothing about the wiring under
 * test is faked: the registry, the dispatch, the broadcasters and
 * `registerIpcHandlers` itself are all real.
 *
 * What this file is *not*: a test of dispatch policy (`remote-dispatch.test.ts`),
 * of the registry's own storage (`registry.test.ts`), or of the socket
 * broadcaster's frame shape (`socket-broadcaster.test.ts`). It asserts only
 * that the four are wired to each other, and in the right order.
 */

interface FakeWindow {
  isDestroyed: () => boolean;
  webContents: { send: (channel: string, payload: unknown) => void };
}

/** Every `webContents.send` this registration made, in order. */
const windowSends: [string, unknown][] = [];

const windows: FakeWindow[] = [];

const fakeWindow = (): FakeWindow => ({
  isDestroyed: () => false,
  webContents: {
    send: (channel, payload) => {
      windowSends.push([channel, payload]);
    },
  },
});

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0',
    on: vi.fn(),
    removeListener: vi.fn(),
    // Per-spec, never shared: vitest runs spec files in parallel worker
    // processes and these registrations really write container sets (HIVE-139).
    getPath: () => '/tmp/hive-test-remote-composition',
    dock: { bounce: vi.fn(), setBadge: vi.fn() },
  },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => windows },
  dialog: { showOpenDialog: vi.fn() },
  Notification: Object.assign(vi.fn(), { isSupported: () => false }),
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
  shell: { showItemInFolder: vi.fn(), openExternal: vi.fn() },
}));

vi.mock('../../../../electron/main/pty-host', () => ({
  registerPtyHost: () => ({
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    onData: () => () => {},
    onExit: () => () => {},
    onSpawned: () => () => {},
    onError: () => () => {},
    onSessionLost: () => () => {},
    shutdown: async () => {},
    isRunning: () => true,
    isBlocked: () => false,
    sessionIds: () => [],
  }),
}));

vi.mock('../../../../electron/main/shutdown', () => ({ onShutdown: vi.fn() }));

// The whole snapshot, so no getter reading a field this fixture forgot can
// throw into a swallowing catch (HIVE-139).
const snapshot = emptySnapshot('/tmp/config.json', '/bin/zsh');

vi.mock('../../../../electron/main/config/index', () => ({
  getConfig: vi.fn(() => snapshot),
  reloadConfig: vi.fn(() => snapshot),
  loadConfig: vi.fn(() => snapshot),
  addProject: vi.fn(() => snapshot),
  removeProject: vi.fn(() => snapshot),
  renameProject: vi.fn(() => snapshot),
  repointProject: vi.fn(() => snapshot),
  reorderProjects: vi.fn(() => snapshot),
  configPath: vi.fn(() => '/tmp/config.json'),
}));

/**
 * `ledger:changed` is the event this file pushes, and the ledger is faked only
 * so a test can raise one — `createLedger`'s own rules are
 * `tests/electron/main/ledger/index.test.ts`'s job.
 */
let onChangeListener: ((entry: unknown) => void) | undefined;

vi.mock('../../../../electron/main/ledger', () => ({
  createLedger: () => ({
    read: () => ({ entries: [], openAsks: [], claims: {} }),
    append: () => ({ ok: true, id: 'entry-1' }),
    answer: () => ({ ok: true, id: 'entry-2' }),
    onChange: (listener: (entry: unknown) => void) => {
      onChangeListener = listener;
      return () => {
        onChangeListener = undefined;
      };
    },
  }),
}));

const { CH } = await import('../../../../electron/shared/ipc-contract');
const { attachForTest, registerIpcHandlers, remoteRegistrySize, resetIpcHandlers } =
  await import('../../../../electron/main/ipc');

/**
 * Read at import time, before any test body has run, so the composition-order
 * assertion below cannot be weakened by moving a case: at this point in the
 * file `registerIpcHandlers` has never been called and the registry has to be
 * empty. The listener is only ever `start()`-ed later, from
 * `electron/main/index.ts`, which is what makes "populated before a socket can
 * attach" true rather than lucky.
 */
const sizeBeforeRegistration = remoteRegistrySize();

const emitLedgerChanged = (entry: unknown): void => {
  if (onChangeListener === undefined) throw new Error('ledger.onChange was never wired');
  onChangeListener(entry);
};

beforeEach(() => {
  windowSends.length = 0;
  windows.length = 0;
  onChangeListener = undefined;
  vi.clearAllMocks();
  resetIpcHandlers();
});

afterEach(() => {
  resetIpcHandlers();
});

describe('remote composition (HIVE-143)', () => {
  it('records nothing before registerIpcHandlers runs', () => {
    expect(sizeBeforeRegistration).toBe(0);
  });

  it('records a handler for every call and notify channel', () => {
    registerIpcHandlers();

    // 89 call + 6 notify. Asserted as the total so a channel added without a
    // handler, or a handler registered twice, both fail here.
    expect(remoteRegistrySize()).toBe(95);
  });

  it('empties the registry on reset, so a socket sees not-ready rather than a stale handler', () => {
    registerIpcHandlers();
    resetIpcHandlers();

    expect(remoteRegistrySize()).toBe(0);
  });

  it('sends an event to an attached socket as well as to every window', () => {
    windows.push(fakeWindow());
    registerIpcHandlers();
    const socket = { send: vi.fn() };
    attachForTest(socket);

    emitLedgerChanged({ id: 'e1' });

    expect(socket.send).toHaveBeenCalledWith({
      kind: 'event',
      channel: CH.ledgerChanged,
      payload: { id: 'e1' },
    });
    expect(windowSends).toContainEqual([CH.ledgerChanged, { id: 'e1' }]);
  });

  it('drops a detached socket, and keeps delivering to the windows', () => {
    windows.push(fakeWindow());
    registerIpcHandlers();
    const socket = { send: vi.fn() };
    attachForTest(socket);

    resetIpcHandlers();
    registerIpcHandlers();
    emitLedgerChanged({ id: 'e2' });

    // The set is cleared with the registry, or one suite's socket receives the
    // next suite's events.
    expect(socket.send).not.toHaveBeenCalled();
    expect(windowSends).toContainEqual([CH.ledgerChanged, { id: 'e2' }]);
  });
});
