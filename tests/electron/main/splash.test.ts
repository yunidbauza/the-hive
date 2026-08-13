// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SPLASH_FADE_MS,
  SPLASH_FADE_STEP_MS,
  SPLASH_MIN_MS,
  SPLASH_SIZE,
} from '../../../electron/shared/splash';

/**
 * The splash window, with `electron` mocked (stories 081, and this one).
 *
 * What is worth asserting here is the *clock*, not the chamber: whether a fast
 * boot still gets its floor, whether a slow one is not delayed twice, and
 * whether the window is the harmless thing it claims to be. How the creature
 * looks is a question for a real browser, and `tests/e2e/electron/splash.spec.ts`
 * asks it there.
 */

interface FakeWindow {
  options: Record<string, unknown>;
  once: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  setOpacity: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  loadFile: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  fire: (event: string) => void;
}

const created: FakeWindow[] = [];

vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) {
      const listeners = new Map<string, () => void>();
      let destroyed = false;
      const win: FakeWindow = {
        options,
        once: vi.fn((event: string, handler: () => void) => {
          listeners.set(event, handler);
        }),
        show: vi.fn(),
        destroy: vi.fn(() => {
          destroyed = true;
        }),
        setOpacity: vi.fn(),
        isDestroyed: () => destroyed,
        loadFile: vi.fn(),
        loadURL: vi.fn(),
        fire: (event: string) => listeners.get(event)?.(),
      };
      created.push(win);
      return win as unknown as object;
    }
  },
}));

const { createSplashWindow, splashEnabled } = await import(
  '../../../electron/main/splash'
);

beforeEach(() => {
  created.length = 0;
  delete process.env.ELECTRON_RENDERER_URL;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('splashEnabled', () => {
  it('is on for an ordinary launch', () => {
    expect(splashEnabled({})).toBe(true);
  });

  it('is off under the e2e suite, which sets HIVE_E2E', () => {
    expect(splashEnabled({ HIVE_E2E: '1' })).toBe(false);
  });

  it('treats an empty HIVE_E2E as absent, so a spec can opt back in', () => {
    expect(splashEnabled({ HIVE_E2E: '' })).toBe(true);
  });
});

describe('createSplashWindow', () => {
  it('opens a frameless, chrome-less window at the shared size', () => {
    createSplashWindow();
    const { options } = created[0];

    expect(options).toMatchObject({
      width: SPLASH_SIZE.width,
      height: SPLASH_SIZE.height,
      frame: false,
      resizable: false,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
    });
  });

  it('carries no preload and no node integration', () => {
    createSplashWindow();
    const web = created[0].options.webPreferences as Record<string, unknown>;

    // The splash has nothing to talk to. A preload here would be a security
    // surface bought for a window that is destroyed seconds later.
    expect(web.preload).toBeUndefined();
    expect(web).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
  });

  it('loads the built document when there is no dev server', () => {
    createSplashWindow();
    expect(created[0].loadFile).toHaveBeenCalledWith(
      expect.stringContaining('splash.html'),
    );
  });

  it('loads it from the dev server when electron-vite set one', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173';
    createSplashWindow();
    expect(created[0].loadURL).toHaveBeenCalledWith('http://localhost:5173/splash.html');
  });

  it('shows itself on ready-to-show', () => {
    createSplashWindow();
    created[0].fire('ready-to-show');
    expect(created[0].show).toHaveBeenCalled();
  });
});

describe('the floor', () => {
  it('owes the full minimum the moment it opens', () => {
    let clock = 1_000;
    const splash = createSplashWindow({ now: () => clock });
    expect(splash.remaining()).toBe(SPLASH_MIN_MS);
  });

  it('counts from when the window appeared, not when it was constructed', () => {
    let clock = 1_000;
    const splash = createSplashWindow({ now: () => clock });

    // 400ms of document loading before it could be shown.
    clock = 1_400;
    created[0].fire('ready-to-show');
    clock = 1_900;

    // 500ms visible, so 2000 still owed — not 1600.
    expect(splash.remaining()).toBe(SPLASH_MIN_MS - 500);
  });

  it('owes nothing once the floor has passed, and never goes negative', () => {
    let clock = 1_000;
    const splash = createSplashWindow({ now: () => clock });
    clock = 1_000 + SPLASH_MIN_MS + 5_000;
    expect(splash.remaining()).toBe(0);
  });

  it('starts the clock at construction, so a document that never loads cannot hang the app', () => {
    let clock = 1_000;
    const splash = createSplashWindow({ now: () => clock });

    // `ready-to-show` never fires.
    clock = 1_000 + SPLASH_MIN_MS;
    expect(splash.remaining()).toBe(0);
  });
});

describe('dismissal', () => {
  it('fades to zero and then destroys the window', async () => {
    vi.useFakeTimers();
    const splash = createSplashWindow();
    const done = splash.dismiss();

    const steps = Math.round(SPLASH_FADE_MS / SPLASH_FADE_STEP_MS);
    await vi.advanceTimersByTimeAsync(SPLASH_FADE_MS);
    await done;

    const opacities = created[0].setOpacity.mock.calls.map(([value]) => value);
    expect(opacities).toHaveLength(steps);
    expect(opacities[0]).toBeGreaterThan(0);
    expect(opacities.at(-1)).toBe(0);
    // Destroyed only after the ramp — a window destroyed at step one is a cut,
    // not a fade.
    expect(created[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('is safe to call twice', async () => {
    vi.useFakeTimers();
    const splash = createSplashWindow();

    const first = splash.dismiss();
    const second = splash.dismiss();
    await vi.advanceTimersByTimeAsync(SPLASH_FADE_MS);
    await Promise.all([first, second]);

    expect(created[0].destroy).toHaveBeenCalledTimes(1);
  });
});
