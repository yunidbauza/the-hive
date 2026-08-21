import { join } from 'node:path';

import { app, BrowserWindow, screen, shell } from 'electron';

import {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  TRAFFIC_LIGHT_POSITION,
  WINDOW_BACKGROUND,
} from '@shared/window';

import { devIconPath } from './app-icon';
import { isSafeExternalUrl } from './external-links';
import { createSplashWindow, splashEnabled, type SplashController } from './splash';
import {
  debounce,
  readWindowState,
  resolveRect,
  writeWindowState,
  type WindowRect,
} from './window-state';

/** Where geometry lives. Per-instance, so `--user-data-dir` isolates it. */
export const windowStatePath = (): string =>
  join(app.getPath('userData'), 'window-state.json');

/** How long to coalesce a drag or resize before writing. */
const PERSIST_DEBOUNCE_MS = 400;

/**
 * The renderer, from disk or from the dev server.
 *
 * `electron-vite dev` sets `ELECTRON_RENDERER_URL`; a built app has no such
 * variable and loads `out/renderer/index.html` beside `out/main/`.
 */
function loadRenderer(win: BrowserWindow): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
    // A production build that pops DevTools is a shipped bug.
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

/**
 * Everything that must be locked down on a `webContents` (story 081/082).
 *
 * Exported so the same policy can be asserted directly in a unit test rather
 * than inferred from a window.
 */
export function applyWebContentsPolicy(win: BrowserWindow): void {
  /**
   * Deny every `window.open`. Nothing in this app opens a second window, so an
   * attempt is either a bug or hostile terminal output; either way the answer
   * is no. External links are re-routed to the OS browser after a scheme check.
   */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  /**
   * Same check on in-place navigation. Without it, a link that replaces the
   * document navigates the app itself away from the renderer and there is no
   * way back — the window is left showing someone else's web page.
   */
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  });

  /**
   * A silent renderer crash in an app full of live terminals looks exactly like
   * the terminals froze. Surface it; never swallow it.
   */
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[hive] renderer process gone:', details.reason, details.exitCode);
  });
  win.webContents.on('unresponsive', () => {
    console.error('[hive] renderer unresponsive');
  });
}

/** Wire geometry persistence to a window. Exported for tests. */
export function trackWindowState(win: BrowserWindow, statePath: string): void {
  const persist = debounce(() => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    // Read the *normal* bounds: saving a maximized window's bounds means
    // un-maximizing on the next launch restores to full-screen-sized, and the
    // user can never get their old size back.
    const rect = win.getNormalBounds() as WindowRect;
    writeWindowState(statePath, { rect, maximized });
  }, PERSIST_DEBOUNCE_MS);

  win.on('resize', persist);
  win.on('move', persist);
  // `close` may beat the debounce timer; flush so the last drag is not lost.
  win.on('close', () => persist.flush());
}

export interface CreateWindowOptions {
  /**
   * Open the cold-start splash in front of this window (the Overmind Chamber).
   *
   * Only the first window of a launch asks for it. `activate` — the macOS dock
   * click that re-creates a window after the last one closed — does not: the
   * app is already running, so there is nothing to cover, and a splash there
   * would read as a second launch. Neither does `second-instance`, which never
   * creates a window at all.
   */
  withSplash?: boolean;
  /** Injected by the unit test. */
  createSplash?: typeof createSplashWindow;
  setTimeoutFn?: typeof setTimeout;
}

export function createWindow({
  withSplash = false,
  createSplash = createSplashWindow,
  setTimeoutFn = setTimeout,
}: CreateWindowOptions = {}): BrowserWindow {
  /**
   * Before the main window, so the chamber is on screen while the renderer
   * boots rather than after it — which is the entire point.
   */
  const splash: SplashController | null =
    withSplash && splashEnabled() ? createSplash() : null;

  const statePath = windowStatePath();
  const saved = readWindowState(statePath);
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  const rect = resolveRect(saved.rect, workAreas);

  const icon = devIconPath();

  const win = new BrowserWindow({
    ...(rect
      ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      : DEFAULT_WINDOW_SIZE),
    /**
     * The window and taskbar icon on Windows and Linux, during development
     * only — a packaged app takes it from the executable or the `.desktop`
     * entry, and macOS ignores this option entirely in both cases (`app-icon.ts`).
     */
    ...(icon ? { icon } : {}),
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    /**
     * Revealed on `ready-to-show`. Showing immediately paints an empty frame
     * while the renderer boots, and on a dark app that flash is a white
     * rectangle.
     */
    show: false,
    /**
     * Electron paints this before any CSS loads, and the default is white. This
     * is the same flash from the other side, and the one people notice on every
     * cold launch.
     */
    backgroundColor: WINDOW_BACKGROUND,
    /**
     * The app already has a 56px header (story 021). A native title bar above
     * it would stack two bars. `hiddenInset` removes the bar and floats the
     * traffic lights over our own header — what VS Code, Linear and every app
     * of this shape do. Not honoured on Windows/Linux; those get the default
     * frame, which this epic accepts.
     */
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // `.cjs` deliberately — a sandboxed preload cannot be ESM (story 080).
      preload: join(import.meta.dirname, '../preload/index.cjs'),
    },
  });

  if (saved.maximized) win.maximize();

  /**
   * With no splash this is the original behaviour, unchanged.
   *
   * With one, the window is ready but stays hidden until the chamber has had
   * its {@link SPLASH_MIN_MS} floor. The order inside the timeout matters: the
   * main window is shown *first*, underneath the splash — which is
   * `alwaysOnTop` — and the splash then fades off it. Destroying first and
   * showing second leaves a frame or two of bare desktop between the two, which
   * is the one visible artefact this whole handover exists to avoid.
   */
  win.once('ready-to-show', () => {
    if (!splash) {
      win.show();
      return;
    }
    setTimeoutFn(() => {
      win.show();
      void splash.dismiss();
    }, splash.remaining());
  });

  applyWebContentsPolicy(win);
  trackWindowState(win, statePath);
  loadRenderer(win);

  /*
    No focus wiring here (HIVE-81 review).

    This used to be `win.on('focus'|'blur', notifyForegroundChange)`, which
    watched the main window while the predicate it feeds counts *every* window
    of ours. The About panel is the case that breaks: blur it by switching
    applications and nothing fired, so a still-blocked session kept its silent,
    already-read row for as long as the user was away. It lives on `app`'s own
    `browser-window-blur`/`browser-window-focus` now — one wiring, every window
    — in `ipc/index.ts`, where the state it re-evaluates already lives.
  */

  return win;
}
