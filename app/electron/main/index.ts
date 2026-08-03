import { app, ipcMain } from 'electron';

import { CH, type AppInfo } from '@shared/ipc-contract';

import { registerLifecycle } from './lifecycle';
import { createWindow } from './window';

/**
 * Main process entry (story 081).
 *
 * Lifecycle only. The window itself is `window.ts`, the platform handlers are
 * `lifecycle.ts`, and teardown registration is `shutdown.ts` — this file exists
 * to decide whether this process should run at all, and then to hand off.
 */

/**
 * The single-instance lock, first, before anything else is wired.
 *
 * `requestSingleInstanceLock()` returns false in the *second* process, which
 * must exit immediately — the first process gets a `second-instance` event and
 * focuses its window instead (see `lifecycle.ts`).
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
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

  registerLifecycle({ createWindow });
}
