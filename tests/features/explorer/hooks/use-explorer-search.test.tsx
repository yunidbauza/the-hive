import type { FsResult, SearchResults } from '@shared/fs-contract';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { searchProject } = vi.hoisted(() => ({ searchProject: vi.fn() }));

vi.mock('@lib/explorer/fs-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  searchProject,
}));

const { useExplorerSearch } = await import(
  '@features/explorer/hooks/use-explorer-search'
);

/**
 * The Explorer's debounce and its stale-answer guard.
 *
 * Fake timers throughout — the repo's rule, and here it is the only way to
 * assert that a walk was *not* started, which is most of what this hook is for.
 */

const results = (files: number): FsResult<SearchResults> => ({
  ok: true,
  value: { hits: [], files, matches: files, capped: false },
});

/**
 * Advance past the debounce **and** let the walk's promise settle.
 *
 * `advanceTimersByTimeAsync` rather than `waitFor`: testing-library's waiter
 * runs on real timers and simply hangs while fake ones are installed, which is
 * the trap this whole file would otherwise fall into four times.
 */
const settle = async (ms = 300): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const run = (term: string, enabled = true, projectId: string | null = 'nova-web') =>
  renderHook(
    ({ t }: { t: string }) =>
      useExplorerSearch(projectId, t, 'text', enabled, undefined),
    { initialProps: { t: term } },
  );

beforeEach(() => {
  vi.useFakeTimers();
  searchProject.mockResolvedValue(results(1));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('the debounce', () => {
  /**
   * A keystroke here starts a recursive walk of the project, so this matters
   * more than it does on a list filter: one walk per character would have four
   * racing before the word is finished.
   */
  it('asks for nothing until the typing stops', () => {
    const { rerender } = run('ba');
    rerender({ t: 'bad' });
    rerender({ t: 'badge' });

    expect(searchProject).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(searchProject).toHaveBeenCalledTimes(1);
    expect(searchProject).toHaveBeenCalledWith(
      'nova-web',
      'badge',
      'text',
      undefined,
    );
  });

  it('reports that it is working while the walk is out', () => {
    const { result } = run('badge');
    expect(result.current.searching).toBe(true);
  });
});

describe('what it refuses to walk', () => {
  it('says nothing for a query below the floor', () => {
    run('b');
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(searchProject).not.toHaveBeenCalled();
  });

  it('stays idle while the panel cannot search', () => {
    run('badge', false);
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(searchProject).not.toHaveBeenCalled();
  });

  it('stays idle with no project', () => {
    run('badge', true, null);
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(searchProject).not.toHaveBeenCalled();
  });

  it('drops back to idle when the box empties', async () => {
    const { result, rerender } = run('badge');
    await settle();
    expect(result.current.results).not.toBeNull();

    rerender({ t: '' });

    expect(result.current.results).toBeNull();
    expect(result.current.searching).toBe(false);
  });
});

describe('the answer', () => {
  it('holds what came back', async () => {
    const { result } = run('badge');
    await settle();

    expect(result.current.results?.files).toBe(1);
    expect(result.current.searching).toBe(false);
  });

  it('surfaces a failure as a message rather than throwing', async () => {
    searchProject.mockResolvedValue({
      ok: false,
      error: { code: 'EPROJECT', message: 'no such project' },
    });

    const { result } = run('badge');
    await settle();

    expect(result.current.error).toBe('no such project');
    expect(result.current.results).toBeNull();
  });

  /**
   * The race the ticket exists for: a slow walk followed by a fast one would
   * otherwise land second and paint results for a query the box no longer
   * holds.
   */
  it('ignores a slow answer that arrives after a newer one', async () => {
    let releaseSlow: (value: FsResult<SearchResults>) => void = () => {};
    searchProject.mockReturnValueOnce(
      new Promise<FsResult<SearchResults>>((resolve) => {
        releaseSlow = resolve;
      }),
    );

    const { result, rerender } = run('slow');
    await settle();

    // A second query, answered immediately.
    searchProject.mockResolvedValue(results(2));
    rerender({ t: 'fast' });
    await settle();
    expect(result.current.results?.files).toBe(2);

    // The first walk finally finishes. Its answer is for a dead ticket.
    await act(async () => {
      releaseSlow(results(99));
    });

    expect(result.current.results?.files).toBe(2);
  });
});
