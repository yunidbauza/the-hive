import { app, BrowserWindow } from 'electron';

import { showAboutWindow } from './about';
import { appWindows, primaryWindow } from './aux-windows';
import { installApplicationMenu } from './menu';
import { runShutdown } from './shutdown';
import { checkForUpdatesInteractively } from './updates';

/**
 * App lifecycle wiring (story 081).
 *
 * Split from `index.ts` so it can be driven directly in a unit test: the
 * handlers here are where the platform-specific behaviour lives, and asserting
 * them through a real Electron boot would be slow and indirect.
 */

export interface LifecycleDeps {
  /** Injected so tests do not need a real `BrowserWindow`. */
  createWindow: (options?: { withSplash?: boolean }) => unknown;
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
    // The *app's* window, not merely the first one open — with the About panel
    // up and the main window closed, the first one is the panel.
    const existing = primaryWindow();
    if (!existing) return;
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  });

  void app.whenReady().then(() => {
    if (isMac) {
      installApplicationMenu({
        isMac,
        isDev,
        appName: app.getName(),
        /**
         * Fire-and-forget: a menu `click` handler cannot be awaited, and every
         * outcome of a check — found, not found, failed — is already reported
         * to the user by the updater's own dialog. There is nothing left for a
         * caller here to do with the promise except drop it, so it says so.
         */
        onCheckForUpdates: () => void checkForUpdatesInteractively(),
        /**
         * The focused window is passed only so the panel centres over the app
         * rather than over the display. It is not made modal — see
         * `showAboutWindow` — and an absent one is fine.
         */
        onShowAbout: () => showAboutWindow(BrowserWindow.getFocusedWindow()),
      });
    }
    /**
     * The only launch that gets the splash — this is the cold start it covers.
     */
    createWindow({ withSplash: true });
  });

  /**
   * macOS: clicking the dock icon with no windows open re-creates one.
   *
   * Deliberately without the splash. The app is already running; there is no
   * boot to cover, and a chamber that opened every time the dock was clicked
   * would turn a two-and-a-half second launch flourish into a recurring toll.
   */
  app.on('activate', () => {
    /**
     * Counted over the app's own windows, not every window that exists.
     *
     * The About panel is a long-lived `BrowserWindow`, so the old count of
     * *all* windows could be 1 with no main window open at all: close the main
     * window on macOS (the app stays alive), open About from the menu, click
     * the dock icon — nothing was re-created, and the only thing on screen was
     * a panel about an app the user could no longer reach.
     */
    if (appWindows().length === 0) createWindow();
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
