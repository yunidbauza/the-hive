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
 * ## Why it exists, and what changed under it
 *
 * It was written when `window.ts` imported `notifyForegroundChange` from
 * `./ipc` to wire the main window's own `focus`/`blur`, which made importing
 * `window.ts` also evaluate the whole of `electron/main/ipc/index.ts`. **That
 * edge is gone**: the focus wiring moved to `app.on('browser-window-blur' |
 * 'browser-window-focus')` inside `registerIpcHandlers`, because watching one
 * window while the predicate counts every window lost a real notification
 * whenever the About panel was the last thing focused.
 *
 * The file stays, because the property it asserts was never about that one
 * edge. No *other* test loads the real `window.ts`: `about.test.ts` replaces
 * it wholesale with `vi.mock('../../../electron/main/window', ...)` before it
 * is ever imported, and `lifecycle.test.ts` never imports it at all — it
 * injects `createWindow: vi.fn()`. So this is the only place that would notice
 * `window.ts`, or anything in its graph, reaching for an Electron API at
 * *module scope* rather than inside a function `createWindow()` calls. The
 * spies below would record it before the assertion ever runs.
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

/*
  Only `electron` is mocked. The three leaves this file used to stub as well —
  `pty-host`, `shutdown` and `config/index` — were needed to load
  `ipc/index.ts`, which `window.ts` no longer pulls in (see the note above).
  Nothing under `electron/main/` or `electron/shared/` is replaced here, which
  is what makes the assertion below a statement about the real graph.
*/

beforeEach(() => {
  calls.length = 0;
  vi.resetModules();
});

describe('electron/main/window.ts — import-time safety', () => {
  it('evaluates the module and its whole graph without touching an Electron API', async () => {
    await import('../../../electron/main/window');

    // Nothing above is called at module scope in `window.ts`, `app-icon.ts`,
    // `external-links.ts`, `splash.ts`, `aux-windows.ts` or `window-state.ts` —
    // every one of them only reaches for these behind a function that
    // `createWindow()` would call, and it does not run here.
    expect(calls).toEqual([]);
  });
});
