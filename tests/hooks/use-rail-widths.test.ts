import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useRailWidths } from '@hooks/use-rail-widths';
import { RAIL_MIN, railMaxWidth } from '@lib/rail-width';
import { useAppearanceStore } from '@stores/appearance-store';
import { useUiStore } from '@stores/ui-store';

/**
 * The one place the three sources of a rail width are assembled (HIVE-105).
 *
 * The arithmetic belongs to `tests/lib/rail-width.test.ts` and the storage to
 * the store's own suite. What is only provable here is that the hook actually
 * *reacts* — to the window, to the store, and to the activity rail appearing
 * and disappearing — and that the bounds it hands a handle are coherent.
 */

const COMFORTABLE = RAIL_MIN.comfortable;

/** happy-dom lets `innerWidth` be assigned, and dispatches a real resize event. */
function resizeTo(width: number) {
  act(() => {
    window.innerWidth = width;
    window.dispatchEvent(new Event('resize'));
  });
}

beforeEach(() => {
  document.body.style.removeProperty('--cc-rail-w-left');
  document.body.style.removeProperty('--cc-rail-w-right');
  useAppearanceStore.getState().reset();
  useUiStore.setState({ showActivityRail: true });
  window.innerWidth = 1440;
});

describe('useRailWidths', () => {
  it('reports the density defaults before anything is dragged', () => {
    const { result } = renderHook(() => useRailWidths());

    expect(result.current.left.value).toBe(COMFORTABLE.left);
    expect(result.current.right.value).toBe(COMFORTABLE.right);
    expect(result.current.left.min).toBe(COMFORTABLE.left);
  });

  it('writes a dragged width to the custom property', () => {
    const { result } = renderHook(() => useRailWidths());

    act(() => useAppearanceStore.getState().setRailWidth('left', 400));

    expect(result.current.left.value).toBe(400);
    expect(document.body.style.getPropertyValue('--cc-rail-w-left')).toBe('400px');
  });

  /**
   * The reason a resize listener exists at all. A width that fits a wide window
   * has to be pulled in when the window narrows — and, just as importantly,
   * released again when it grows back.
   */
  it('re-clamps on a window resize and restores the width afterwards', () => {
    const { result } = renderHook(() => useRailWidths());

    /* 500px needs a window of at least 1667px to be inside the 30% share. */
    resizeTo(1920);
    act(() => useAppearanceStore.getState().setRailWidth('left', 500));
    expect(result.current.left.value).toBe(500);

    resizeTo(1100);
    expect(result.current.left.value).toBe(Math.floor(railMaxWidth(1100)));
    expect(result.current.left.value).toBeLessThan(500);

    resizeTo(1920);
    expect(result.current.left.value).toBe(500);
  });

  it('reports the per-rail ceiling for the handles', () => {
    const { result } = renderHook(() => useRailWidths());

    resizeTo(1280);
    expect(result.current.left.max).toBe(railMaxWidth(1280));
  });

  it('gives the right rail no width when it is unmounted', () => {
    const { result } = renderHook(() => useRailWidths());

    act(() => useUiStore.setState({ showActivityRail: false }));

    expect(result.current.right.value).toBe(0);
    expect(document.body.style.getPropertyValue('--cc-rail-w-right')).toBe('');
  });

  it('follows a density change', () => {
    const { result } = renderHook(() => useRailWidths());

    act(() => useAppearanceStore.getState().setDensity('compact'));

    expect(result.current.left.min).toBe(RAIL_MIN.compact.left);
    expect(result.current.left.value).toBe(RAIL_MIN.compact.left);
  });

  it('stops listening when it unmounts', () => {
    const { result, unmount } = renderHook(() => useRailWidths());
    const before = result.current.left.max;

    unmount();
    resizeTo(2560);

    expect(result.current.left.max).toBe(before);
  });

  /**
   * The bounds handed to a handle have to stay coherent even where the stage
   * floor has pushed a rail below its own minimum.
   *
   * Found in review: handing over the *unreduced* minimum there produces a
   * slider whose `min` exceeds its `value`, which is invalid to announce and
   * actively wrong to drive — the shrink key evaluates `Math.max(min, …)` and
   * *grows* the rail, storing a width the user never chose.
   */
  describe('below the window the defaults need', () => {
    it('never reports a minimum above the painted width', () => {
      const { result } = renderHook(() => useRailWidths());

      resizeTo(700);

      expect(result.current.left.value).toBeLessThan(COMFORTABLE.left);
      expect(result.current.left.min).toBeLessThanOrEqual(result.current.left.value);
      expect(result.current.right.min).toBeLessThanOrEqual(result.current.right.value);
    });

    /** A ceiling under the floor is not a range anything can be driven within. */
    it('never reports a maximum below the minimum', () => {
      const { result } = renderHook(() => useRailWidths());

      for (const width of [400, 600, 700, 800, 900, 1100, 1440, 2560]) {
        resizeTo(width);

        expect(result.current.left.max).toBeGreaterThanOrEqual(result.current.left.min);
        expect(result.current.right.max).toBeGreaterThanOrEqual(
          result.current.right.min,
        );
      }
    });

    it('collapses the range to the painted width, so the rail cannot move', () => {
      const { result } = renderHook(() => useRailWidths());

      resizeTo(700);

      expect(result.current.left.min).toBe(result.current.left.value);
      expect(result.current.left.max).toBe(result.current.left.value);
    });
  });

  describe('a collapsed rail', () => {
    it('paints the strip width', () => {
      useAppearanceStore.getState().setRailCollapsed('left', true);

      renderHook(() => useRailWidths());

      expect(document.body.style.getPropertyValue('--cc-rail-w-left')).toBe('44px');
    });

    it('leaves the other rail following the stylesheet', () => {
      // The expanded rail is at its default, so its property is *removed* and
      // `tokens.css` — density rules included — takes back over.
      useAppearanceStore.getState().setRailCollapsed('left', true);

      renderHook(() => useRailWidths());

      expect(document.body.style.getPropertyValue('--cc-rail-w-right')).toBe('');
    });

    /**
     * The `-open` pair is the rail's width with collapse ignored, and the two
     * pairs are asserted **together** on purpose.
     *
     * `header.tsx` sizes its zones from `-open` so that collapsing a rail does
     * not reflow the header — that is the bug this pair exists for. But the
     * plain pair must still report the truth, because it is what the rail
     * itself is painted with. Split these into two tests and a change that
     * quietly pointed one at the other would keep both of them green.
     *
     * A dragged width is used rather than the default: `applyRailWidths`
     * *removes* a property sitting at its density default so `tokens.css` can
     * take over, so at the default this would read `''` for reasons that have
     * nothing to do with collapse.
     */
    it('keeps the open width while the plain token paints the strip', () => {
      useAppearanceStore.getState().setRailWidth('left', 400);
      useAppearanceStore.getState().setRailCollapsed('left', true);

      renderHook(() => useRailWidths());

      expect(document.body.style.getPropertyValue('--cc-rail-w-left')).toBe('44px');
      expect(document.body.style.getPropertyValue('--cc-rail-w-left-open')).toBe('400px');
    });

    it('does the same for the activity rail', () => {
      useAppearanceStore.getState().setRailWidth('right', 400);
      useAppearanceStore.getState().setRailCollapsed('right', true);

      renderHook(() => useRailWidths());

      expect(document.body.style.getPropertyValue('--cc-rail-w-right')).toBe('44px');
      expect(document.body.style.getPropertyValue('--cc-rail-w-right-open')).toBe('400px');
    });

    it('reports handle bounds a slider can legally announce', () => {
      // aria-valuemin above aria-valuenow is invalid to announce and wrong to
      // drive. `bounds` already guards this via Math.min(floor, value); this
      // locks that in for the collapsed case.
      useAppearanceStore.getState().setRailCollapsed('left', true);

      const { result } = renderHook(() => useRailWidths());

      expect(result.current.left.value).toBe(44);
      expect(result.current.left.min).toBeLessThanOrEqual(result.current.left.value);
      expect(result.current.left.max).toBeGreaterThanOrEqual(result.current.left.value);
    });
  });
});
