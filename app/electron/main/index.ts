import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, ipcMain } from 'electron';

import { CH, type AppInfo } from '@shared/ipc-contract';

/**
 * Main process entry (story 080 — the scaffold).
 *
 * Deliberately thin. This exists to prove the three-target build works and that
 * the renderer we already shipped boots inside an Electron window unchanged.
 * The real window lifecycle — state persistence, the single-instance lock, the
 * application menu, the shutdown registry — is story 081, which replaces most
 * of this file.
 *
 * The `webPreferences` posture below is already the locked one (story 082).
 * It is set here rather than left to a later story because the insecure
 * defaults are the kind of thing that survives by being nobody's job; 082 adds
 * the sender assertion, the payload guards, the CSP and the tests that keep it
 * from regressing.
 */

/**
 * `out/main/index.js` and `out/renderer/index.html` are siblings under `out/`.
 * ESM output has no `__dirname`, so the path is derived from this module's URL.
 */
const rendererHtml = fileURLToPath(
  new URL('../renderer/index.html', import.meta.url),
);

/** `win`, not `window` — in the main process that name means something else. */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    // Revealed on `ready-to-show` so a cold launch never paints an empty frame
    // — on a dark app that flash is a white rectangle (story 081).
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // `.cjs` deliberately — a sandboxed preload cannot be ESM. See
      // `electron.vite.config.ts`'s preload target for the full reasoning.
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
    },
  });

  win.once('ready-to-show', () => win.show());

  /**
   * `electron-vite dev` serves the renderer over HTTP so Vite's HMR client can
   * attach; a built app loads it off disk. DevTools open only in the former —
   * a production build that pops DevTools is a shipped bug.
   */
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(rendererHtml);
  }

  return win;
}

/** The one live channel — it proves renderer → preload → main → renderer. */
ipcMain.handle(CH.appInfo, (): AppInfo => {
  const { electron, chrome, node } = process.versions;
  return {
    version: app.getVersion(),
    electron: electron ?? 'unknown',
    chrome: chrome ?? 'unknown',
    node: node ?? 'unknown',
    platform: process.platform,
  };
});

void app.whenReady().then(() => {
  createWindow();

  // macOS: clicking the dock icon with no windows open re-creates one.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// macOS apps stay alive with no windows; everywhere else, closing is quitting.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
