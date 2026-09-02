import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkSearchRow } from '@features/work/components/work-search-row';
import { useHiveStore, type TicketSearchState } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

/**
 * The WORK tab's search row: the debounce, the scope, and the sentence that
 * says what a search actually returned.
 *
 * Mirrors `pr-search-row.test.tsx`, including what it declines to test.
 * `searchTickets` is stubbed on the store rather than at the bridge, because
 * what this component decides is *what to ask for* — a term and a scope.
 * Whether the JQL that results is any good is `tests/lib/jira-search.test.ts`,
 * and whether Jira answers is the store's.
 */

const searchTickets = vi.fn<(term: string, mineOnly: boolean) => Promise<void>>();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
  searchTickets.mockReset();
  searchTickets.mockResolvedValue(undefined);
  useHiveStore.setState({ searchTickets });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Type into the box the way the panel does, then let the debounce elapse. */
async function type(term: string): Promise<void> {
  await act(async () => {
    useUiStore.getState().setWorkSearchTerm(term);
  });
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
}

describe('the box', () => {
  it('shows only the box until something is typed', () => {
    render(<WorkSearchRow />);

    expect(screen.getByLabelText('Search tickets')).toBeInTheDocument();
    // A scope control for a search nobody has started is a control for nothing.
    expect(screen.queryByLabelText(/Mine only/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Clear the search/ }),
    ).toBeNull();
  });

  it('waits for the typing to stop before asking Jira', async () => {
    render(<WorkSearchRow />);

    await act(async () => {
      useUiStore.getState().setWorkSearchTerm('rai');
    });
    expect(searchTickets).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    // One request per keystroke would be three here, each a round trip to
    // Atlassian.
    expect(searchTickets).toHaveBeenCalledTimes(1);
  });

  it('writes what is typed into the store', async () => {
    render(<WorkSearchRow />);

    await userEvent.type(screen.getByLabelText('Search tickets'), 'rails');

    expect(useUiStore.getState().workSearchTerm).toBe('rails');
  });
});

describe('the scope', () => {
  it('searches everyone’s tickets while Mine only is unchecked', async () => {
    render(<WorkSearchRow />);

    await type('rails');

    expect(searchTickets).toHaveBeenCalledWith('rails', false);
  });

  it('narrows to the user when the box is ticked', async () => {
    render(<WorkSearchRow />);
    await type('rails');
    searchTickets.mockClear();

    await act(async () => {
      await userEvent.click(screen.getByLabelText(/Mine only/));
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    // Re-asked rather than filtered: the narrow answer is a different query,
    // and the rows already on screen were never the whole set.
    expect(searchTickets).toHaveBeenCalledWith('rails', true);
  });
});

describe('clearing', () => {
  it('empties the box and drops the results', async () => {
    render(<WorkSearchRow />);
    await type('rails');

    await act(async () => {
      await userEvent.click(
        screen.getByRole('button', { name: /Clear the search/ }),
      );
    });

    expect(useUiStore.getState().workSearchTerm).toBe('');
    expect(useHiveStore.getState().ticketSearch.results).toBeNull();
  });

  it('empties the box on Escape', async () => {
    render(<WorkSearchRow />);
    await type('rails');

    await act(async () => {
      await userEvent.type(screen.getByLabelText('Search tickets'), '{Escape}');
    });

    expect(useUiStore.getState().workSearchTerm).toBe('');
  });

  it('drops the results without waiting for a debounce', async () => {
    render(<WorkSearchRow />);
    await type('rails');

    await act(async () => {
      useUiStore.getState().setWorkSearchTerm('');
    });

    // A stale list under an empty box is the panel contradicting itself, and
    // there is nothing to wait for — no request is going out.
    expect(useHiveStore.getState().ticketSearch.results).toBeNull();
  });
});

describe('what the count says', () => {
  const ticket = (key: string) => ({
    key,
    status: 'To Do',
    statusCategory: 'todo' as const,
    title: key,
    url: `https://example.invalid/${key}`,
  });

  /**
   * Install an answer the way one really arrives: **after** the box has a term.
   *
   * Seeding before the render is the mistake it looks like it is not — mounting
   * with an empty box runs the effect that clears the results, which is the
   * behaviour `drops the results without waiting for a debounce` is about.
   */
  const answer = async (search: Partial<TicketSearchState>) => {
    await act(async () => {
      useHiveStore.setState({
        ticketSearch: {
          term: 'rails',
          results: null,
          searching: false,
          error: null,
          capped: false,
          tooShort: false,
          ...search,
        },
      });
    });
  };

  it('names the scope it searched, because the list above never shows it', async () => {
    render(<WorkSearchRow />);
    await type('rails');

    await answer({
      term: 'rails',
      results: [ticket('INCORP-505')],
      searching: false,
      error: null,
    });

    // A bare "1 issue" would leave the user to infer that a search returns work
    // the standing list never shows. The PRs row says "all authors" for the
    // same reason.
    expect(screen.getByText(/1 issue · all assignees/)).toBeInTheDocument();
  });

  it('counts more than one in the plural', async () => {
    render(<WorkSearchRow />);
    await type('rails');

    await answer({
      term: 'rails',
      results: [ticket('HIVE-1'), ticket('HIVE-2')],
      searching: false,
      error: null,
    });

    expect(screen.getByText(/2 issues · all assignees/)).toBeInTheDocument();
  });

  it('drops the scope wording once the search is narrowed', async () => {
    render(<WorkSearchRow />);
    await type('rails');

    await act(async () => {
      await userEvent.click(screen.getByLabelText(/Mine only/));
    });
    await answer({
      term: 'rails',
      results: [ticket('HIVE-1')],
      searching: false,
      error: null,
    });

    // "all assignees" would now be false — the query names one.
    expect(screen.getByText('1 issue')).toBeInTheDocument();
  });

  it('says it is still looking rather than claiming a count of nothing', async () => {
    render(<WorkSearchRow />);
    await type('rails');

    await answer({
      term: 'rails',
      results: null,
      searching: true,
      error: null,
    });

    expect(screen.getByText('Searching…')).toBeInTheDocument();
  });

  it('marks a capped answer as a floor, not a total', async () => {
    render(<WorkSearchRow />);
    await type('rails');

    await answer({
      term: 'rails',
      results: [ticket('HIVE-1')],
      searching: false,
      error: null,
      capped: true,
      tooShort: false,
    });

    // Main stops paging at 200 and says so. Printing that as "200 issues" is a
    // number the user cannot tell from the truth — a prefix search across
    // summary and description reaches the cap easily.
    expect(screen.getByText(/1\+ issues · all assignees/)).toBeInTheDocument();
  });

  it('asks for more rather than reporting a count nobody asked for', async () => {
    render(<WorkSearchRow />);
    await type('rails');

    await answer({
      term: 'a',
      results: null,
      searching: false,
      error: null,
      capped: false,
      tooShort: true,
    });

    expect(screen.getByText('Keep typing…')).toBeInTheDocument();
    expect(screen.queryByText(/issues?/)).toBeNull();
  });

  it('says nothing at all when the search failed', async () => {
    render(<WorkSearchRow />);
    await type('rails');

    await answer({
      term: 'rails',
      results: [],
      searching: false,
      error: 'Jira refused the query.',
    });

    // The panel prints the error itself; "0 issues" beside it would be a second,
    // misleading account of the same failure.
    expect(screen.queryByText(/issues? · all assignees/)).toBeNull();
  });
});
