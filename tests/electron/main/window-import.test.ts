// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Import-time safety of `electron/main/window.ts` (HIVE-81 review follow-up).
 *
 * Narrow and deliberately so: this is not a test of `createWindow()` — that
 * would need a much larger `BrowserWindow` fake, in the shape `about.test.ts`
 * already builds for its own narrower graph, and duplicating that here would
 * not serve this file's one job.
 *
 * The one thing this file exists to prove: `window.ts` now imports
 * `notifyForegroundChange` from `./ipc` (HIVE-81), which makes importing
 * `window.ts` also evaluate the whole of `electron/main/ipc/index.ts` — a much
 * larger module graph than `window.ts` pulled in before. No *existing* test
 * loads the real `window.ts`: `about.test.ts` replaces it wholesale with
 * `vi.mock('../../../electron/main/window', ...)` before it is ever imported,
 * and `lifecycle.test.ts` never imports it at all — it injects
 * `createWindow: vi.fn()`. So neither exercises this module or the new edge.
 *
 * This test does, for real: nothing under `electron/main/`, `electron/shared/`
 * or their transitive dependents is mocked here except `electron` itself (and
 * the same three leaves — `pty-host`, `shutdown`, `config/index` —
 * `config-channels.test.ts` and `foreground.test.ts` already mock to load the
 * real `ipc/index.ts`). If either module's *module scope* — as opposed to a
 * function body inside it — reached for an Electron API, the spies below would
 * record a call before this test's own assertion ever runs.
 */

const calls: string[] = [];
const spy =
  (name: string) =>
  (..._args: unknown[]) => {
    calls.push(name);
    return undefined as unknown;
  };

vi.mock('electron', () => ({
  app: {
    getVersion: spy('app.getVersion'),
    on: spy('app.on'),
    getPath: spy('app.getPath'),
    isPackaged: false,
    dock: undefined,
  },
  // A real constructor, so `new BrowserWindow(...)` inside `createWindow()`
  // would work if it were ever called — which this test asserts it is not.
  BrowserWindow: class {
    constructor() {
      calls.push('new BrowserWindow');
    }
  },
  dialog: { showOpenDialog: spy('dialog.showOpenDialog') },
  safeStorage: {
    isEncryptionAvailable: spy('safeStorage.isEncryptionAvailable'),
    encryptString: spy('safeStorage.encryptString'),
    decryptString: spy('safeStorage.decryptString'),
  },
  ipcMain: {
    handle: spy('ipcMain.handle'),
    on: spy('ipcMain.on'),
    removeHandler: spy('ipcMain.removeHandler'),
  },
  session: {
    defaultSession: {
      webRequest: { onHeadersReceived: spy('webRequest.onHeadersReceived') },
    },
  },
  screen: { getAllDisplays: spy('screen.getAllDisplays') },
  shell: {
    showItemInFolder: spy('shell.showItemInFolder'),
    openExternal: spy('shell.openExternal'),
  },
  nativeImage: { createFromPath: spy('nativeImage.createFromPath') },
}));

vi.mock('../../../electron/main/pty-host', () => ({
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

vi.mock('../../../electron/main/shutdown', () => ({
  onShutdown: () => () => {},
}));

vi.mock('../../../electron/main/config/index', () => ({
  getConfig: vi.fn(() => ({
    configPath: '/tmp/config.json',
    templateWritten: false,
    shell: '/bin/zsh',
    claudeCommand: 'claude',
    projects: [],
    errors: [],
  })),
  reloadConfig: vi.fn(),
  loadConfig: vi.fn(),
  addProject: vi.fn(),
  removeProject: vi.fn(),
  renameProject: vi.fn(),
  repointProject: vi.fn(),
  reorderProjects: vi.fn(),
  configPath: vi.fn(() => '/tmp/config.json'),
}));

beforeEach(() => {
  calls.length = 0;
  vi.resetModules();
});

describe('electron/main/window.ts — import-time safety', () => {
  it('evaluates the module, and the `./ipc` edge it now carries, without touching an Electron API', async () => {
    await import('../../../electron/main/window');

    // Nothing above is called at module scope in `window.ts`, `app-icon.ts`,
    // `external-links.ts`, `splash.ts`, `aux-windows.ts`, `window-state.ts`,
    // or anywhere in `ipc/index.ts`'s own graph — every one of them only
    // reaches for these behind a function that `createWindow()` or
    // `registerIpcHandlers()` would call, and neither runs here.
    expect(calls).toEqual([]);
  });
});
