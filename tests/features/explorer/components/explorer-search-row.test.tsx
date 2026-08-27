import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { ExplorerSearchRow } from '@features/explorer/components/explorer-search-row';
import { useUiStore } from '@stores/ui-store';

/**
 * The Explorer's search box.
 *
 * Mirrors `pr-search-row.test.tsx`: the box and its store, never the walk. What
 * main does with the query is `tests/electron/main/fs/search.test.ts`.
 */

const box = () => screen.getByLabelText('Search files');

beforeEach(() => {
  useUiStore.getState().clearExplorerSearch();
});

describe('the box', () => {
  it('starts empty, with no mode to choose yet', () => {
    render(<ExplorerSearchRow />);

    expect(box()).toHaveValue('');
    // An empty box has no mode worth offering, and no way out to offer either.
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Clear the search/ }),
    ).not.toBeInTheDocument();
  });

  it('writes what is typed into the store', async () => {
    render(<ExplorerSearchRow />);

    await userEvent.type(box(), 'badge');

    expect(useUiStore.getState().explorerSearchTerm).toBe('badge');
  });

  it('offers the mode switch once something is typed', async () => {
    render(<ExplorerSearchRow />);
    await userEvent.type(box(), 'badge');

    expect(screen.getByRole('radio', { name: 'Name' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Text' })).not.toBeChecked();
  });

  it('switches to searching contents', async () => {
    render(<ExplorerSearchRow />);
    await userEvent.type(box(), 'badge');

    await userEvent.click(screen.getByRole('radio', { name: 'Text' }));

    expect(useUiStore.getState().explorerSearchMode).toBe('text');
  });
});

describe('clearing', () => {
  /**
   * A mode set for one question must not silently govern the next — the rule
   * `prSearchAllRepos` states for its own scope.
   */
  it('puts the mode back to names when the box empties', async () => {
    render(<ExplorerSearchRow />);
    await userEvent.type(box(), 'badge');
    await userEvent.click(screen.getByRole('radio', { name: 'Text' }));

    await userEvent.click(
      screen.getByRole('button', { name: /Clear the search/ }),
    );

    expect(useUiStore.getState().explorerSearchTerm).toBe('');
    expect(useUiStore.getState().explorerSearchMode).toBe('name');
  });

  it('empties from Escape as well as from the button', async () => {
    render(<ExplorerSearchRow />);
    await userEvent.type(box(), 'badge');

    await userEvent.type(box(), '{Escape}');

    expect(useUiStore.getState().explorerSearchTerm).toBe('');
  });
});

describe('the count', () => {
  it('shows what it was given, and nothing when there is none', async () => {
    const { rerender } = render(<ExplorerSearchRow status="7 in 3 files" />);
    await userEvent.type(box(), 'badge');

    expect(screen.getByText('7 in 3 files')).toBeInTheDocument();

    rerender(<ExplorerSearchRow />);
    expect(screen.queryByText('7 in 3 files')).not.toBeInTheDocument();
  });
});
