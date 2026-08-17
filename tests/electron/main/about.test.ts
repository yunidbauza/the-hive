// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ABOUT_SIZE,
  ABOUT_TRAFFIC_LIGHT_POSITION,
} from '../../../electron/shared/about';

/**
 * The About window, with `electron` mocked.
 *
 * What is worth asserting here is the *window*: that it is the singleton it
 * claims to be, that it takes the same lockdown as the main window, and that it
 * carries a preload — which is the one place it deliberately departs from the
 * splash it is modelled on. How the creature looks is a question for a real
 * browser, exactly as it is for the splash.
 */

interface FakeWindow {
  options: Record<string, unknown>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  webContents: { on: ReturnType<typeof vi.fn> };
  fire: (event: string) => void;
  fireInput: (input: { type: string; key: string }) => void;
  destroy: () => void;
}

const created: FakeWindow[] = [];

vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) {
      const listeners = new Map<string, () => void>();
      const inputListeners: ((event: unknown, input: unknown) => void)[] = [];
      let destroyed = false;

      const win: FakeWindow = {
        options,
        show: vi.fn(),
        focus: vi.fn(),
        close: vi.fn(),
        once: vi.fn((event: string, cb: () => void) => listeners.set(event, cb)),
        on: vi.fn((event: string, cb: () => void) => listeners.set(event, cb)),
        loadFile: vi.fn(),
        loadURL: vi.fn(),
        isDestroyed: () => destroyed,
        webContents: {
          on: vi.fn((event: string, cb: (e: unknown, i: unknown) => void) => {
            if (event === 'before-input-event') inputListeners.push(cb);
          }),
        },
        fire: (event: string) => listeners.get(event)?.(),
        fireInput: (input) => inputListeners.forEach((cb) => cb({}, input)),
        destroy: () => {
          destroyed = true;
        },
      };

      created.push(win);
      return win as unknown as object;
    }
  },
}));

/**
 * `window.ts` reaches for `shell` and the external-link allowlist on import.
 * The policy itself is asserted in its own suite; here it only needs to be
 * observable, so that "the About window takes the same lockdown" is a claim
 * this file can actually make.
 */
const applyWebContentsPolicy = vi.fn();
vi.mock('../../../electron/main/window', () => ({
  applyWebContentsPolicy: (win: unknown) => applyWebContentsPolicy(win),
}));

const { showAboutWindow, resetAboutWindow } = await import(
  '../../../electron/main/about'
);

beforeEach(() => {
  created.length = 0;
  applyWebContentsPolicy.mockClear();
  resetAboutWindow();
  delete process.env.ELECTRON_RENDERER_URL;
});

afterEach(() => {
  delete process.env.ELECTRON_RENDERER_URL;
});

describe('showAboutWindow', () => {
  it('opens at the size the stylesheet is authored for', () => {
    // `about.css` is written in these coordinates. A window of another size
    // would crop the composition rather than reflow it, which is the point.
    showAboutWindow();

    expect(created[0]?.options).toMatchObject(ABOUT_SIZE);
  });

  it('carries the preload — the one place it departs from the splash', () => {
    /**
     * The splash is deliberately the dumbest window in the app. This one shows
     * the version, the runtime versions and whether a newer release exists —
     * all of which already travel over `AppInfo`, the interface whose docblock
     * says it exists "for the About box".
     */
    showAboutWindow();

    const prefs = created[0]?.options.webPreferences as Record<string, unknown>;
    expect(prefs.preload).toContain('preload');
    expect(prefs).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
  });

  it('takes the same lockdown as the main window', () => {
    showAboutWindow();

    expect(applyWebContentsPolicy).toHaveBeenCalledTimes(1);
  });

  it('raises the panel already open instead of stacking a second', () => {
    /**
     * About is a statement, not a document: choosing the menu item twice means
     * "show me", not "give me another copy". A stack of identical panels is the
     * bug every app that skipped this check has shipped.
     */
    const first = showAboutWindow();
    const again = showAboutWindow();

    expect(again).toBe(first);
    expect(created).toHaveLength(1);
    expect(created[0]?.show).toHaveBeenCalled();
    expect(created[0]?.focus).toHaveBeenCalled();
  });

  it('opens a fresh panel once the old one is gone', () => {
    showAboutWindow();
    created[0]?.fire('closed');

    showAboutWindow();

    expect(created).toHaveLength(2);
  });

  it('is shown on ready-to-show, not before', () => {
    // The same reason `window.ts` gives: a window shown before its document has
    // painted is a flash of empty chrome.
    showAboutWindow();

    expect(created[0]?.show).not.toHaveBeenCalled();
    created[0]?.fire('ready-to-show');
    expect(created[0]?.show).toHaveBeenCalledTimes(1);
  });

  it('shows a close button, rather than hiding the only exit behind a key', () => {
    /**
     * The regression this exists to prevent, and it shipped once.
     *
     * `frame: false` removes the traffic lights along with the title bar, so
     * the panel had no visible way out at all — Escape worked and always did,
     * but a shortcut nobody can see is not an affordance. `hidden` keeps the
     * frameless look and lets macOS draw the real controls; `minimizable` and
     * `maximizable` stay false, so Close is the only live one.
     */
    showAboutWindow();

    expect(created[0]?.options.titleBarStyle).toBe('hidden');
    expect(created[0]?.options.frame).toBeUndefined();
    expect(created[0]?.options.trafficLightPosition).toEqual(
      ABOUT_TRAFFIC_LIGHT_POSITION,
    );
  });

  it('keeps Escape working too — the shortcut, now as the shortcut', () => {
    showAboutWindow();

    created[0]?.fireInput({ type: 'keyDown', key: 'Escape' });

    expect(created[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys, and the key going back up', () => {
    showAboutWindow();

    created[0]?.fireInput({ type: 'keyDown', key: 'a' });
    created[0]?.fireInput({ type: 'keyUp', key: 'Escape' });

    expect(created[0]?.close).not.toHaveBeenCalled();
  });

  it('blocks nothing behind it', () => {
    /**
     * Not modal, deliberately: someone who opened About to copy a version into
     * a bug report should still be able to read the terminal it is about.
     */
    showAboutWindow();

    expect(created[0]?.options.modal).toBeUndefined();
  });

  it('loads the built document, and the dev server when there is one', () => {
    showAboutWindow();
    expect(created[0]?.loadFile).toHaveBeenCalledWith(
      expect.stringContaining('about.html'),
    );

    resetAboutWindow();
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173';
    showAboutWindow();

    expect(created[1]?.loadURL).toHaveBeenCalledWith(
      'http://localhost:5173/about.html',
    );
  });
});
