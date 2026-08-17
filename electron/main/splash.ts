import { join } from 'node:path';

import { BrowserWindow } from 'electron';

import {
  SPLASH_FADE_MS,
  SPLASH_FADE_STEP_MS,
  SPLASH_MIN_MS,
  SPLASH_SIZE,
} from '@shared/splash';
import { WINDOW_BACKGROUND } from '@shared/window';

import { markAuxiliary } from './aux-windows';

/**
 * The cold-start splash — the Overmind Chamber.
 *
 * A second `BrowserWindow`, opened before the main one and torn down when it
 * hands over. It is deliberately the dumbest window in the app: no preload, no
 * IPC, no `nodeIntegration`, nothing to talk to. It loads one static document,
 * plays for {@link SPLASH_MIN_MS}, and is destroyed.
 *
 * That flatness is the design. Anything the splash could be *told* would have
 * to arrive over a channel that exists only for the few seconds
 * before the app is up, and the app's own window is a better place to say
 * anything true. So the copy is fixed and the clock lives here.
 *
 * `applyWebContentsPolicy` in `window.ts` guards the main window's
 * `webContents`; this window has no navigation surface at all — no links, no
 * scripts that fetch, and a document that cannot be reached from outside — so
 * it takes the same sandboxed defaults and nothing else.
 */

/** How the rest of main talks to a splash without knowing it is a window. */
export interface SplashController {
  /** The window itself. Exposed for the e2e suite and for teardown. */
  readonly window: BrowserWindow;
  /**
   * Milliseconds still owed to {@link SPLASH_MIN_MS}, never negative — so a
   * caller can `setTimeout` on it unconditionally.
   */
  remaining(now?: number): number;
  /** Fade out and destroy. Safe to call twice; the second call is a no-op. */
  dismiss(): Promise<void>;
}

/**
 * Whether a launch should show the splash at all.
 *
 * There is deliberately no user-facing setting: no config key, no command-line
 * flag. The single exception is `HIVE_E2E`, which the Playwright suite already
 * sets to disable the simulation clock and animation-driven timing — the same
 * determinism lever, extended to the same kind of problem. Without it every one
 * of the suite's specs would wait out the floor and then have to work out which
 * of two windows is the app.
 *
 * The splash's own spec launches with it cleared, so the real path is still
 * driven end to end rather than merely unit-tested.
 */
export function splashEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.HIVE_E2E;
}

/** The document, from disk or from the dev server — mirrors `loadRenderer`. */
function loadSplash(win: BrowserWindow): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(new URL('splash.html', `${devUrl}/`).toString());
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/splash.html'));
  }
}

/**
 * Ramp a window's opacity to zero, then run `done`.
 *
 * Written against injectable timers so the unit test can drive it without
 * waiting 240 real milliseconds, and so the fade cannot become the reason a
 * test is flaky.
 */
function fadeOut(
  win: BrowserWindow,
  done: () => void,
  setIntervalFn: typeof setInterval = setInterval,
  clearIntervalFn: typeof clearInterval = clearInterval,
): void {
  const steps = Math.max(1, Math.round(SPLASH_FADE_MS / SPLASH_FADE_STEP_MS));
  let step = 0;
  const timer = setIntervalFn(() => {
    step += 1;
    if (!win.isDestroyed()) win.setOpacity(Math.max(0, 1 - step / steps));
    if (step >= steps) {
      clearIntervalFn(timer);
      done();
    }
  }, SPLASH_FADE_STEP_MS);
}

export interface CreateSplashOptions {
  /** Injected by the unit test. */
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export function createSplashWindow({
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}: CreateSplashOptions = {}): SplashController {
  const win = new BrowserWindow({
    ...SPLASH_SIZE,
    /** Revealed on `ready-to-show`, for the reason `window.ts` gives. */
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    center: true,
    skipTaskbar: true,
    /**
     * Above the main window, which is shown *underneath* the splash and
     * revealed as it fades. Reversing that order — destroy, then show — leaves
     * a frame or two of empty desktop between the two windows.
     */
    alwaysOnTop: true,
    backgroundColor: WINDOW_BACKGROUND,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  /**
   * Seeded at construction and moved forward when the window actually appears.
   *
   * If it were only set on `ready-to-show`, a document that fails to load would
   * leave it unset and `remaining()` would have to decide what an absent start
   * time means — with the wrong answer meaning the app never opens. Starting
   * the clock here makes the floor an upper bound on the delay no matter what
   * the document does.
   */
  /**
   * Furniture. The splash never needed this — it destroys itself moments after
   * the main window appears — but "the transient one happens not to overlap" is
   * a coincidence rather than a rule, and the About panel is what happens when
   * the next window like it does. See `aux-windows.ts`.
   */
  markAuxiliary(win);

  let shownAt = now();
  let dismissed = false;

  win.once('ready-to-show', () => {
    shownAt = now();
    win.show();
  });

  loadSplash(win);

  return {
    window: win,
    remaining(at = now()) {
      return Math.max(0, SPLASH_MIN_MS - (at - shownAt));
    },
    dismiss() {
      if (dismissed || win.isDestroyed()) return Promise.resolve();
      dismissed = true;
      return new Promise<void>((resolve) => {
        fadeOut(
          win,
          () => {
            if (!win.isDestroyed()) win.destroy();
            resolve();
          },
          setIntervalFn,
          clearIntervalFn,
        );
      });
    },
  };
}
