// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeWindow {
  destroyed: boolean;
  isDestroyed: () => boolean;
}

const windows: FakeWindow[] = [];

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => windows },
}));

const { appWindows, isAuxiliary, markAuxiliary, primaryWindow } = await import(
  '../../../electron/main/aux-windows'
);

const win = (): FakeWindow => {
  const w: FakeWindow = { destroyed: false, isDestroyed: () => w.destroyed };
  windows.push(w);
  return w;
};

beforeEach(() => {
  windows.length = 0;
});

/**
 * Which windows are *the app*, and which are furniture.
 *
 * The distinction did not need to exist while the only other window was the
 * splash, which destroys itself moments after the main window appears. The
 * About panel is long-lived and can be the only window open, which turned three
 * separate `getAllWindows()` assumptions into bugs at once.
 */
describe('aux-windows', () => {
  it('counts only windows the user can work in', () => {
    const main = win();
    const panel = win();
    markAuxiliary(panel as never);

    expect(appWindows()).toEqual([main]);
    expect(isAuxiliary(panel as never)).toBe(true);
    expect(isAuxiliary(main as never)).toBe(false);
  });

  it('reports no app window when only furniture is open', () => {
    /**
     * The exact state behind the report: on macOS the app survives its last
     * window, so About can be the only thing on screen. `activate` counted
     * *all* windows, saw 1, and never re-created the main window — leaving a
     * panel about an app the user could no longer reach.
     */
    const panel = win();
    markAuxiliary(panel as never);

    expect(appWindows()).toHaveLength(0);
    expect(primaryWindow()).toBeUndefined();
  });

  it('never returns a destroyed window', () => {
    // A dialog parented to a destroyed window throws rather than misplacing a
    // sheet, so this is the harsher failure of the two.
    const main = win();
    main.destroyed = true;

    expect(appWindows()).toHaveLength(0);
    expect(primaryWindow()).toBeUndefined();
  });

  it('picks the app window even when furniture was created first', () => {
    /**
     * Order matters because the old code took `getAllWindows()[0]`. The
     * updater's dialogs parent to this, and the About panel floats above the
     * main window — so parenting to the panel drew the confirm sheet
     * underneath the thing the user had just clicked.
     */
    const panel = win();
    markAuxiliary(panel as never);
    const main = win();

    expect(primaryWindow()).toBe(main);
  });
});
