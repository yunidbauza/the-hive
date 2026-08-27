import type { SearchHit } from '@shared/fs-contract';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ExplorerResults } from '@features/explorer/components/explorer-results';

/**
 * What a search answers with.
 *
 * The interesting assertions here are the ones about *not lying*: a group that
 * shows twenty of a hundred hits has to say so, and a highlight has to land on
 * the match main actually counted rather than the first lookalike.
 */

const textHit = (over: Partial<SearchHit> = {}): SearchHit => ({
  relPath: 'src/components/ui/badge.tsx',
  name: 'badge.tsx',
  total: 2,
  lines: [
    { line: 6, text: "danger: 'bg-danger-solid text-on-danger',", column: 33 },
    { line: 7, text: '// `on-danger`, not `on-brand`', column: 4 },
  ],
  ...over,
});

const nameHit = (over: Partial<SearchHit> = {}): SearchHit => ({
  relPath: 'src/components/ui/badge.tsx',
  name: 'badge.tsx',
  total: 1,
  lines: [],
  ...over,
});

describe('text results', () => {
  it('groups the lines under their file, open by default', () => {
    render(
      <ExplorerResults hits={[textHit()]} query="on-danger" onOpenFile={vi.fn()} />,
    );

    expect(screen.getByText('badge.tsx')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('collapses and reopens a group from its row', async () => {
    render(
      <ExplorerResults hits={[textHit()]} query="on-danger" onOpenFile={vi.fn()} />,
    );

    await userEvent.click(screen.getByTitle('src/components/ui/badge.tsx'));
    expect(screen.queryByText('6')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTitle('src/components/ui/badge.tsx'));
    expect(screen.getByText('6')).toBeInTheDocument();
  });

  it('shows the directory beneath the name rather than in front of it', () => {
    render(
      <ExplorerResults hits={[textHit()]} query="on-danger" onOpenFile={vi.fn()} />,
    );

    // The filename is the part that was searched for, so it keeps the row.
    expect(screen.getByText('src/components/ui/')).toBeInTheDocument();
  });

  it('opens the file when a line is clicked', async () => {
    const onOpenFile = vi.fn();
    render(
      <ExplorerResults hits={[textHit()]} query="on-danger" onOpenFile={onOpenFile} />,
    );

    await userEvent.click(screen.getByText('6'));

    expect(onOpenFile).toHaveBeenCalledWith(
      'src/components/ui/badge.tsx',
      'badge.tsx',
    );
  });

  /**
   * A group that silently showed twenty of a hundred is the same untruth as a
   * total printed over a truncated set.
   */
  it('says how many hits it is not showing', () => {
    render(
      <ExplorerResults
        hits={[textHit({ total: 40 })]}
        query="on-danger"
        onOpenFile={vi.fn()}
      />,
    );

    expect(screen.getByText(/38 more in this file/)).toBeInTheDocument();
  });

  it('counts the file’s hits on the row', () => {
    render(
      <ExplorerResults
        hits={[textHit({ total: 9 })]}
        query="on-danger"
        onOpenFile={vi.fn()}
      />,
    );

    expect(screen.getByText('9')).toBeInTheDocument();
  });
});

describe('name results', () => {
  it('opens the file directly, having nothing to expand', async () => {
    const onOpenFile = vi.fn();
    render(
      <ExplorerResults hits={[nameHit()]} query="badge" onOpenFile={onOpenFile} />,
    );

    await userEvent.click(screen.getByTitle('src/components/ui/badge.tsx'));

    expect(onOpenFile).toHaveBeenCalledWith(
      'src/components/ui/badge.tsx',
      'badge.tsx',
    );
  });

  it('highlights the query inside the filename', () => {
    render(
      <ExplorerResults hits={[nameHit()]} query="badge" onOpenFile={vi.fn()} />,
    );

    const mark = screen.getByText('badge', { selector: 'mark' });
    expect(mark).toBeInTheDocument();
  });
});

describe('highlighting', () => {
  /**
   * Main answers with a column, and the row uses it: a line containing the
   * query twice must mark the occurrence main counted, not the first one.
   */
  it('marks the column main reported, not the first lookalike', () => {
    render(
      <ExplorerResults
        hits={[
          // A name that does not contain the query, so the only mark on
          // screen is the line's — the filename highlights too, correctly.
          textHit({
            name: 'tone.ts',
            lines: [{ line: 1, text: 'aa BADGE aa badge', column: 12 }],
          }),
        ]}
        query="badge"
        onOpenFile={vi.fn()}
      />,
    );

    const mark = screen.getByText('badge', { selector: 'mark' });
    // Everything before the mark, which is what proves index 12 was used
    // rather than the `BADGE` sitting at index 3.
    expect(mark.previousSibling?.textContent).toBe('aa BADGE aa ');
    expect(mark.parentElement?.textContent).toBe('aa BADGE aa badge');
  });

  it('renders the text plainly when the column cannot be trusted', () => {
    render(
      <ExplorerResults
        hits={[
          textHit({
            name: 'tone.ts',
            lines: [{ line: 1, text: 'short', column: 99 }],
          }),
        ]}
        query="badge"
        onOpenFile={vi.fn()}
      />,
    );

    expect(screen.getByText('short')).toBeInTheDocument();
    expect(document.querySelector('mark')).toBeNull();
  });
});
