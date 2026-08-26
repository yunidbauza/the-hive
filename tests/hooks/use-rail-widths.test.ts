import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { RAIL_MIN, railMaxWidth } from '@lib/rail-width';
import { useRailWidths } from '@hooks/use-rail-widths';
import { useAppearanceStore } from '@stores/appearance-store';
import { useUiStore } from '@stores/ui-store';

/**
 * The one place the three sources of a rail width are assembled (HIVE-105).
 *
 * The arithmetic belongs to `tests/lib/rail-width.test.ts` and the storage to
 * the store's own suite. What is only provable here is that the hook actually
 * *reacts* — to the window, to the store, and to the activity rail appearing
 * and disappearing.
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

    expect(result.current.left).toBe(COMFORTABLE.left);
    expect(result.current.right).toBe(COMFORTABLE.right);
    expect(result.current.min).toEqual(COMFORTABLE);
  });

  it('writes a dragged width to the custom property', () => {
    const { result } = renderHook(() => useRailWidths());

    act(() => useAppearanceStore.getState().setRailWidth('left', 400));

    expect(result.current.left).toBe(400);
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
    expect(result.current.left).toBe(500);

    resizeTo(1100);
    expect(result.current.left).toBe(Math.floor(railMaxWidth(1100)));
    expect(result.current.left).toBeLessThan(500);

    resizeTo(1920);
    expect(result.current.left).toBe(500);
  });

  it('reports the per-rail ceiling for the handles', () => {
    const { result } = renderHook(() => useRailWidths());

    resizeTo(1280);
    expect(result.current.max).toBe(railMaxWidth(1280));
  });

  it('gives the right rail no width when it is unmounted', () => {
    const { result } = renderHook(() => useRailWidths());

    act(() => useUiStore.setState({ showActivityRail: false }));

    expect(result.current.right).toBe(0);
    expect(document.body.style.getPropertyValue('--cc-rail-w-right')).toBe('');
  });

  it('follows a density change', () => {
    const { result } = renderHook(() => useRailWidths());

    act(() => useAppearanceStore.getState().setDensity('compact'));

    expect(result.current.min).toEqual(RAIL_MIN.compact);
    expect(result.current.left).toBe(RAIL_MIN.compact.left);
  });

  it('stops listening when it unmounts', () => {
    const { result, unmount } = renderHook(() => useRailWidths());
    const before = result.current.max;

    unmount();
    resizeTo(2560);

    expect(result.current.max).toBe(before);
  });
});
