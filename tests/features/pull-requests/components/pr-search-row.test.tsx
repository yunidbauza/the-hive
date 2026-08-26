import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrSearchRow } from '@features/pull-requests/components/pr-search-row';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

/**
 * The search row: the debounce, the scope, and the sentence that says what a
 * search actually returned.
 *
 * `searchPrs` is stubbed on the store rather than at the bridge, because what
 * this component decides is *what to ask for* — a term and, sometimes, a
 * project. Whether GitHub answers is `client.test.ts`'s question.
 */

const searchPrs = vi.fn<(term: string, projectId?: string) => Promise<void>>();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
  searchPrs.mockReset();
  searchPrs.mockResolvedValue(undefined);
  useHiveStore.setState({ searchPrs });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Type into the box the way the panel does, then let the debounce elapse. */
async function type(term: string): Promise<void> {
  await act(async () => {
    useUiStore.getState().setPrSearchTerm(term);
  });
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
}

describe('PrSearchRow', () => {
  it('shows only the box until something is typed', () => {
    render(<PrSearchRow projectId="nova-web" />);

    expect(screen.getByLabelText('Search pull requests')).toBeInTheDocument();
    // A scope control for a search nobody has started is a control for nothing.
    expect(screen.queryByLabelText(/All repos/)).toBeNull();
  });

  it('waits for the typing to stop before asking GitHub', async () => {
    render(<PrSearchRow projectId="nova-web" />);

    await act(async () => {
      useUiStore.getState().setPrSearchTerm('car');
    });
    expect(searchPrs).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    // Every search is a `gh` subprocess; one per character would be three here.
    expect(searchPrs).toHaveBeenCalledTimes(1);
  });

  it('searches the session’s project while All repos is unchecked', async () => {
    render(<PrSearchRow projectId="nova-web" />);
    await type('carapace');

    expect(searchPrs).toHaveBeenLastCalledWith('carapace', 'nova-web');
  });

  it('drops the project when All repos is ticked', async () => {
    render(<PrSearchRow projectId="nova-web" />);
    await type('carapace');

    await act(async () => {
      useUiStore.getState().setPrSearchAllRepos(true);
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    // No project id at all is what main reads as "every mapped project".
    expect(searchPrs).toHaveBeenLastCalledWith('carapace', undefined);
  });

  it('offers no narrower scope when no session is being watched', async () => {
    render(<PrSearchRow projectId={null} />);
    await type('carapace');

    const box = screen.getByLabelText(/All repos/);
    // Checked *and* disabled: there is no single project to narrow to, and a
    // control that pretended otherwise would be lying about what it does.
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
    expect(searchPrs).toHaveBeenLastCalledWith('carapace', undefined);
  });

  it('clears the results the moment the box empties', async () => {
    render(<PrSearchRow projectId="nova-web" />);
    await type('carapace');

    useHiveStore.setState({
      prSearch: { term: 'carapace', results: [], searching: false, error: null },
    });

    await type('');

    // No debounce on the way out — a stale list under an empty box would be the
    // panel contradicting itself.
    expect(useHiveStore.getState().prSearch.results).toBeNull();
  });

  it('says how many results, and that they are by anyone', async () => {
    render(<PrSearchRow projectId="nova-web" />);
    await type('carapace');

    await act(async () => {
      useHiveStore.setState({
        prSearch: {
          term: 'carapace',
          results: [],
          searching: false,
          error: null,
        },
      });
    });

    expect(screen.getByText('0 results · all authors')).toBeInTheDocument();
  });

  it('marks a full page of results as a floor, not a total', async () => {
    render(<PrSearchRow projectId="nova-web" />);
    await type('carapace');

    await act(async () => {
      useHiveStore.setState({
        prSearch: {
          term: 'carapace',
          // Both search connections filled, which is the one case where the
          // count is the cap rather than the answer.
          results: Array.from({ length: 200 }, () => ({}) as never),
          searching: false,
          error: null,
        },
      });
    });

    expect(screen.getByText('200+ results · all authors')).toBeInTheDocument();
  });

  /**
   * The row unmounts on a rail-tab switch while the term lives on in
   * `ui-store`. An unguarded reset effect would uncheck "All repos" and
   * re-query narrowed every time the user left the PRs tab and came back — a
   * scope change they did not make.
   */
  it('keeps the scope across an unmount and remount', async () => {
    const { unmount } = render(<PrSearchRow projectId="nova-web" />);
    await type('carapace');

    await act(async () => {
      useUiStore.getState().setPrSearchAllRepos(true);
    });

    unmount();
    render(<PrSearchRow projectId="nova-web" />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(useUiStore.getState().prSearchAllRepos).toBe(true);
  });

  it('resets the scope when the session changes', async () => {
    const { rerender } = render(<PrSearchRow projectId="nova-web" />);
    await type('carapace');

    await act(async () => {
      useUiStore.getState().setPrSearchAllRepos(true);
    });
    expect(useUiStore.getState().prSearchAllRepos).toBe(true);

    await act(async () => {
      rerender(<PrSearchRow projectId="referral-api" />);
    });

    // A scope set for one question must not silently govern the next.
    expect(useUiStore.getState().prSearchAllRepos).toBe(false);
  });

  it('empties the box from its own clear button', async () => {
    render(<PrSearchRow projectId="nova-web" />);
    await type('carapace');

    await userEvent.click(screen.getByRole('button', { name: /Clear the search/ }));

    expect(useUiStore.getState().prSearchTerm).toBe('');
    expect(useUiStore.getState().prSearchAllRepos).toBe(false);
  });
});
