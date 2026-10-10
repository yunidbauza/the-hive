import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SYNC_LATCH_MS, useScrollSync } from '@features/editor/hooks/use-scroll-sync';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useScrollSync', () => {
  it('drives the preview from the source, and the source from the preview', () => {
    const { result } = renderHook(() => useScrollSync());

    act(() => result.current.onSourceTopLine(12));
    expect(result.current.previewTopLine).toBe(12);

    vi.setSystemTime(SYNC_LATCH_MS);
    act(() => result.current.onPreviewTopLine(30));
    expect(result.current.revealLine).toBe(30);

    act(() => result.current.onRevealApplied());
    expect(result.current.revealLine).toBeNull();
  });

  /*
    Moving one side scrolls the other, which reports a scroll of its own. Without
    the latch that echo would drive the first side back, and the two would
    fight for as long as either moved.
  */
  it('ignores the other side’s echo inside the latch window', () => {
    const { result } = renderHook(() => useScrollSync());

    act(() => result.current.onSourceTopLine(12));
    vi.setSystemTime(SYNC_LATCH_MS - 1);
    act(() => result.current.onPreviewTopLine(11));
    expect(result.current.revealLine).toBeNull();
  });

  it('keeps the latch while the owner keeps scrolling', () => {
    const { result } = renderHook(() => useScrollSync());

    act(() => result.current.onSourceTopLine(1));
    vi.setSystemTime(80);
    act(() => result.current.onSourceTopLine(2));
    vi.setSystemTime(150);
    act(() => result.current.onPreviewTopLine(9));
    expect(result.current.revealLine).toBeNull();
    expect(result.current.previewTopLine).toBe(2);
  });
});
