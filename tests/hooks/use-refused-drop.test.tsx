import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DECLINED_BACK_MS } from '@/hooks/use-declined-back';
import { useRefusedDrop } from '@/hooks/use-refused-drop';

describe('useRefusedDrop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is quiet until a drop is refused', () => {
    const { result } = renderHook(() => useRefusedDrop('a'));
    expect(result.current.refused).toBe(false);
  });

  it('says so for as long as the declined-back strip does, then goes quiet', () => {
    const { result } = renderHook(() => useRefusedDrop('a'));

    act(() => result.current.refuse());
    expect(result.current.refused).toBe(true);

    act(() => vi.advanceTimersByTime(DECLINED_BACK_MS - 1));
    expect(result.current.refused).toBe(true);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.refused).toBe(false);
  });

  it('restarts the clock on a second refusal', () => {
    const { result } = renderHook(() => useRefusedDrop('a'));

    act(() => result.current.refuse());
    act(() => vi.advanceTimersByTime(DECLINED_BACK_MS - 1));
    act(() => result.current.refuse());
    act(() => vi.advanceTimersByTime(DECLINED_BACK_MS - 1));

    expect(result.current.refused).toBe(true);
  });

  it('clears when the surface on screen changes', () => {
    const { result, rerender } = renderHook(({ surface }) => useRefusedDrop(surface), {
      initialProps: { surface: 'a' },
    });

    act(() => result.current.refuse());
    rerender({ surface: 'b' });

    expect(result.current.refused).toBe(false);
  });

  it('hands back the same refuse across renders', () => {
    const { result, rerender } = renderHook(() => useRefusedDrop('a'));
    const first = result.current.refuse;
    rerender();
    expect(result.current.refuse).toBe(first);
  });
});
