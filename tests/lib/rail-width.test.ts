import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIN_WINDOW_SIZE } from '@shared/window';

import {
  clampRailWidths,
  isRailDefault,
  RAIL_MAX_FRACTION,
  RAIL_MAX_PX,
  RAIL_MIN,
  railFloorWindowWidth,
  railMaxWidth,
  railWidthConstantsHold,
  STAGE_MIN_FRACTION,
  type RailWidthInput,
} from '@lib/rail-width';

/**
 * The rail width rules (HIVE-105).
 *
 * Pure arithmetic, so it is tested as pure arithmetic — no store, no DOM, no
 * render. Everything the feature promises about the terminal never being
 * starved is provable here, which is the reason the rules live in one function
 * rather than in three components.
 */

const COMFORTABLE = RAIL_MIN.comfortable;
const COMPACT = RAIL_MIN.compact;

/** A wide window, so nothing is under budget pressure unless a case says so. */
const clamp = (over: Partial<RailWidthInput> = {}) =>
  clampRailWidths({
    storedLeft: null,
    storedRight: null,
    min: COMFORTABLE,
    windowWidth: 1920,
    showActivityRail: true,
    ...over,
  });

/** What the stage is left with, as a fraction of the window. */
const stageShare = (
  widths: { left: number; right: number },
  windowWidth: number,
): number => (windowWidth - widths.left - widths.right) / windowWidth;

describe('RAIL_MIN', () => {
  /**
   * The constants duplicate `tokens.css`, and this is the assertion that makes
   * the duplication safe. Reading the values back out of the stylesheet at
   * runtime is not an option — `getComputedStyle` returns nothing in a unit
   * test — so instead the stylesheet is parsed here and the two are compared.
   */
  it('matches the widths tokens.css actually paints', () => {
    /*
      Resolved from the repo root rather than from `import.meta.url`: this suite
      runs under happy-dom, where `import.meta.url` is an http URL and
      `fileURLToPath` rejects it.
    */
    const css = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');

    const widthsIn = (block: string) => ({
      left: Number(/--cc-rail-w-left:\s*(\d+)px/.exec(block)?.[1]),
      right: Number(/--cc-rail-w-right:\s*(\d+)px/.exec(block)?.[1]),
    });

    /*
      Comfortable carries no attribute — it is the `:root` block, which is
      everything before the compact override.
    */
    const compactAt = css.indexOf("body[data-density='compact']");
    expect(compactAt).toBeGreaterThan(-1);

    expect(widthsIn(css.slice(0, compactAt))).toEqual({
      left: COMFORTABLE.left,
      right: COMFORTABLE.right,
    });
    expect(widthsIn(css.slice(compactAt))).toEqual({
      left: COMPACT.left,
      right: COMPACT.right,
    });
  });

  /**
   * **The invariant the whole feature rests on.**
   *
   * The desktop window cannot open narrower than `MIN_WINDOW_SIZE.width`, so as
   * long as that clears the width both rails plus the stage floor need, the
   * compressing branch of `clampRailWidths` is unreachable in the real app.
   * Narrow the window minimum, or widen a rail minimum, and this fails rather
   * than the stage silently dropping below its fifth.
   */
  it('leaves the stage its share at the narrowest window the app allows', () => {
    expect(MIN_WINDOW_SIZE.width).toBeGreaterThanOrEqual(
      railFloorWindowWidth(COMFORTABLE),
    );
    expect(MIN_WINDOW_SIZE.width).toBeGreaterThanOrEqual(railFloorWindowWidth(COMPACT));

    const widths = clamp({ windowWidth: MIN_WINDOW_SIZE.width });
    expect(widths).toEqual({ left: COMFORTABLE.left, right: COMFORTABLE.right });
    expect(stageShare(widths, MIN_WINDOW_SIZE.width)).toBeGreaterThanOrEqual(
      STAGE_MIN_FRACTION,
    );
  });
});

describe('railMaxWidth', () => {
  it('is a share of the window while that is the smaller bound', () => {
    expect(railMaxWidth(1280)).toBe(1280 * RAIL_MAX_FRACTION);
  });

  /** 30% of a 2560px display would be a 768px rail — wider than any panel needs. */
  it('is the absolute cap on a large display', () => {
    expect(railMaxWidth(2560)).toBe(RAIL_MAX_PX);
  });

  it('falls back to the cap when there is no window to measure', () => {
    expect(railMaxWidth(0)).toBe(RAIL_MAX_PX);
    expect(railMaxWidth(Number.NaN)).toBe(RAIL_MAX_PX);
  });
});

describe('clampRailWidths', () => {
  describe('rule 1 — the minimum', () => {
    it('defaults an unset rail to its density width', () => {
      expect(clamp()).toEqual({ left: COMFORTABLE.left, right: COMFORTABLE.right });
    });

    it('uses the compact widths at compact density', () => {
      expect(clamp({ min: COMPACT })).toEqual({
        left: COMPACT.left,
        right: COMPACT.right,
      });
    });

    /** A rail grows from where it is today and never shrinks below it. */
    it('refuses to go narrower than the density width', () => {
      expect(clamp({ storedLeft: 120, storedRight: 90 })).toEqual({
        left: COMFORTABLE.left,
        right: COMFORTABLE.right,
      });
    });

    /**
     * A width stored at compact density is below the comfortable minimum.
     * Switching density must lift it rather than paint a too-narrow rail.
     */
    it('lifts a width stored under a narrower density', () => {
      expect(clamp({ storedLeft: COMPACT.left, min: COMFORTABLE }).left).toBe(
        COMFORTABLE.left,
      );
    });
  });

  describe('rule 2 — the maximum', () => {
    it('holds a rail to the window share', () => {
      expect(clamp({ storedLeft: 900, windowWidth: 1280 }).left).toBe(384);
    });

    it('holds a rail to the absolute cap on a wide window', () => {
      expect(clamp({ storedLeft: 900, windowWidth: 2560 }).left).toBe(RAIL_MAX_PX);
    });
  });

  describe('rule 3 — the stage floor outranks the rest', () => {
    /**
     * At the narrowest window the app opens at, both rails dragged to their
     * ceiling still clear the floor comfortably — the stage keeps 40%, double
     * what it is promised. This is rule 1 doing rule 3's job, which is the
     * whole reason the reduction below is so rarely reached.
     */
    it('leaves the stage well clear of the floor at the app minimum', () => {
      const windowWidth = MIN_WINDOW_SIZE.width;
      const widths = clamp({ storedLeft: 9999, storedRight: 9999, windowWidth });

      expect(widths.left).toBe(Math.floor(railMaxWidth(windowWidth)));
      expect(widths.right).toBe(Math.floor(railMaxWidth(windowWidth)));
      expect(stageShare(widths, windowWidth)).toBeGreaterThanOrEqual(
        STAGE_MIN_FRACTION,
      );
    });

    /** A rail nobody dragged stays exactly at its default while the other is capped. */
    it('caps only the rail that was dragged', () => {
      const windowWidth = 1100;
      const widths = clamp({ storedLeft: 400, storedRight: null, windowWidth });

      expect(widths.right).toBe(COMFORTABLE.right);
      expect(widths.left).toBe(Math.floor(railMaxWidth(windowWidth)));
      expect(widths.left).toBeLessThan(400);
    });

    /**
     * The reason there is only one reduction branch. Two rails dragged as wide
     * as they will go come to 60% of the window, so the 80% budget is never
     * even approached — no drag can reach the reduction at all.
     */
    it('never needs a reduction for two rails dragged to their maximum', () => {
      expect(railWidthConstantsHold()).toBe(true);

      for (let windowWidth = 900; windowWidth <= 3000; windowWidth += 50) {
        const widths = clamp({ storedLeft: 9999, storedRight: 9999, windowWidth });

        expect(widths.left + widths.right).toBeLessThanOrEqual(
          windowWidth * (1 - STAGE_MIN_FRACTION),
        );
        expect(widths.left).toBeGreaterThanOrEqual(COMFORTABLE.left);
        expect(widths.right).toBeGreaterThanOrEqual(COMFORTABLE.right);
      }
    });

    /**
     * Below ~730px even the two minimums breach the floor. The floor wins and
     * the minimums compress — unreachable in the desktop app, which is what the
     * `MIN_WINDOW_SIZE` assertion above proves, but reachable in `pnpm dev`.
     */
    it('compresses below the minimum rather than starve the stage', () => {
      const windowWidth = 700;
      const widths = clamp({ windowWidth });

      expect(widths.left).toBeLessThan(COMFORTABLE.left);
      expect(widths.right).toBeLessThan(COMFORTABLE.right);
      expect(stageShare(widths, windowWidth)).toBeGreaterThanOrEqual(
        STAGE_MIN_FRACTION,
      );
    });

    /**
     * Swept rather than sampled: whatever the stored widths and whatever the
     * window, the stage keeps its fifth. This is the promise the ticket makes,
     * so it is asserted as a promise and not as three examples.
     */
    it('never starves the stage, at any window width or stored width', () => {
      for (let windowWidth = 400; windowWidth <= 3000; windowWidth += 100) {
        for (const stored of [null, 0, 200, 400, 520, 5000]) {
          for (const showActivityRail of [true, false]) {
            for (const min of [COMFORTABLE, COMPACT]) {
              const widths = clampRailWidths({
                storedLeft: stored,
                storedRight: stored,
                min,
                windowWidth,
                showActivityRail,
              });

              expect(stageShare(widths, windowWidth)).toBeGreaterThanOrEqual(
                STAGE_MIN_FRACTION,
              );
            }
          }
        }
      }
    });
  });

  describe('the hidden activity rail', () => {
    it('claims no width at all', () => {
      expect(clamp({ showActivityRail: false }).right).toBe(0);
    });

    /**
     * Its budget goes back to the stage's side of the ledger, which shows up
     * where the budget actually binds: on a window too narrow for both
     * defaults, the left rail keeps its full width once the right one is gone.
     */
    it('returns its budget when the window is too narrow for both', () => {
      const windowWidth = 700;

      const shown = clamp({ windowWidth, showActivityRail: true });
      const hidden = clamp({ windowWidth, showActivityRail: false });

      expect(shown.left).toBeLessThan(COMFORTABLE.left);
      expect(hidden.left).toBe(COMFORTABLE.left);
      expect(hidden.left).toBeGreaterThan(shown.left);
    });

    it('ignores a stored width for a rail that is not mounted', () => {
      expect(clamp({ storedRight: 500, showActivityRail: false }).right).toBe(0);
    });
  });

  describe('degenerate input', () => {
    it('returns the defaults when there is no window to measure', () => {
      expect(clamp({ windowWidth: 0 })).toEqual({
        left: COMFORTABLE.left,
        right: COMFORTABLE.right,
      });
      expect(clamp({ windowWidth: Number.NaN }).left).toBe(COMFORTABLE.left);
    });

    it('reports whole pixels', () => {
      const widths = clamp({ storedLeft: 333, storedRight: 333, windowWidth: 1103 });

      expect(Number.isInteger(widths.left)).toBe(true);
      expect(Number.isInteger(widths.right)).toBe(true);
    });
  });
});

describe('isRailDefault', () => {
  /**
   * "The minimum" and "the default" being the same number is what lets the
   * inline override be removed rather than written — which is what keeps a
   * later density change working on a rail nobody has dragged.
   */
  it('recognises a rail sitting at its density width', () => {
    expect(isRailDefault(COMFORTABLE.left, COMFORTABLE.left)).toBe(true);
    expect(isRailDefault(COMFORTABLE.left + 1, COMFORTABLE.left)).toBe(false);
  });
});
