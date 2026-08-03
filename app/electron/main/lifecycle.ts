import { app, BrowserWindow } from 'electron';

import { installApplicationMenu } from './menu';
import { runShutdown } from './shutdown';

/**
 * App lifecycle wiring (story 081).
 *
 * Split from `index.ts` so it can be driven directly in a unit test: the
 * handlers here are where the platform-specific behaviour lives, and asserting
 * them through a real Electron boot would be slow and indirect.
 */

export interface LifecycleDeps {
  /** Injected so tests do not need a real `BrowserWindow`. */
  createWindow: () => unknown;
  platform?: NodeJS.Platform;
  isDev?: boolean;
}

/** Set once `before-quit` fires, so teardown runs exactly once. */
let quitting = false;

/** Test-only. */
export function resetQuitting(): void {
  quitting = false;
}

export function registerLifecycle({
  createWindow,
  platform = process.platform,
  isDev = Boolean(process.env.ELECTRON_RENDERER_URL),
}: LifecycleDeps): void {
  const isMac = platform === 'darwin';

  /**
   * Focus the existing window instead of opening a second one.
   *
   * Mandatory, not optional. Once story 092 lands, a second instance means a
   * second set of PTYs running `claude` against the same repositories — two
   * agents editing one working tree. The lock has to exist *before* PTYs do.
   */
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (!existing) return;
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  });

  void app.whenReady().then(() => {
    if (isMac) installApplicationMenu({ isMac, isDev, appName: app.getName() });
    createWindow();
  });

  /** macOS: clicking the dock icon with no windows open re-creates one. */
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  /** macOS apps stay alive with no windows; everywhere else, closing quits. */
  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });

  /**
   * Teardown runs on `before-quit`, where it can still hold up the exit.
   *
   * `will-quit` is too late to await anything — by then the app is committed to
   * exiting. So this handler cancels the first quit, awaits every registered
   * hook, and re-issues `app.quit()`. The `quitting` flag makes that re-entry
   * pass straight through instead of looping.
   */
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void runShutdown().finally(() => app.quit());
  });
}
