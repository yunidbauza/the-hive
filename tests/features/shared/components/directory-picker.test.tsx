import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DirectoryPicker } from '@features/shared/components/directory-picker';
import type { BrowseListing } from '@shared/config-contract';

const browse = vi.hoisted(() => vi.fn());
vi.mock('@lib/project-config', () => ({ browseServerDirectory: browse }));

const HOME = '/Users/me';

function listing(over: Partial<BrowseListing> = {}) {
  return {
    ok: true as const,
    value: {
      path: HOME,
      home: HOME,
      entries: [
        {
          name: 'Projects',
          path: `${HOME}/Projects`,
          kind: 'directory' as const,
          childCount: 2,
        },
        {
          name: 'locked',
          path: `${HOME}/locked`,
          kind: 'directory' as const,
          childCount: null,
        },
      ],
      ...over,
    },
  };
}

/**
 * A folder row, scoped to the list.
 *
 * Scoped rather than a bare `getByRole('button')` because the breadcrumb holds
 * a button per path segment, so at `~/Projects/app` a bare query for
 * `/Projects/` would match the crumb as well as any row.
 */
const rows = () => within(screen.getByRole('list', { name: 'Folders' }));
const row = (name: RegExp) => rows().getByRole('button', { name });
const findRow = (name: RegExp) => rows().findByRole('button', { name });

function open(onChoose = vi.fn(), onOpenChange = vi.fn()) {
  render(
    <DirectoryPicker
      open
      onOpenChange={onOpenChange}
      onChoose={onChoose}
      serverName="mini"
    />,
  );
  return { onChoose, onOpenChange };
}

beforeEach(() => {
  browse.mockReset();
  browse.mockResolvedValue(listing());
});

describe('DirectoryPicker', () => {
  it('browses home on open and names the machine being read', async () => {
    open();

    await waitFor(() => expect(browse).toHaveBeenCalledWith(''));
    expect(await screen.findByText(/reading mini/)).toBeInTheDocument();
  });

  it('lists the directories it was given, with their child counts', async () => {
    open();

    const projects = await findRow(/Projects/);
    expect(projects).toBeInTheDocument();
    expect(projects).toHaveTextContent('2 items');
  });

  it('descends into a folder on click', async () => {
    open();
    await findRow(/Projects/);
    browse.mockResolvedValue(
      listing({ path: `${HOME}/Projects`, entries: [] }),
    );

    await userEvent.click(row(/Projects/));

    await waitFor(() =>
      expect(browse).toHaveBeenLastCalledWith(`${HOME}/Projects`),
    );
  });

  it('climbs back through the breadcrumb', async () => {
    browse.mockResolvedValue(
      listing({
        path: `${HOME}/Projects/app`,
        entries: [],
      }),
    );
    open();
    await waitFor(() => expect(browse).toHaveBeenCalled());

    await userEvent.click(await screen.findByRole('button', { name: '~' }));

    await waitFor(() => expect(browse).toHaveBeenLastCalledWith(HOME));
  });

  it('renders home as ~ and marks the deepest crumb current', async () => {
    browse.mockResolvedValue(
      listing({
        path: `${HOME}/Projects/app`,
        entries: [],
      }),
    );
    open();

    expect(await screen.findByRole('button', { name: '~' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'app' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  /**
   * The selection is the directory whose contents are on screen, never a
   * highlighted row. A row click descends; the button adds where you stand.
   */
  it('chooses the directory it is standing in', async () => {
    const { onChoose } = open();
    await findRow(/Projects/);

    await userEvent.click(screen.getByRole('button', { name: 'Use this folder' }));

    expect(onChoose).toHaveBeenCalledWith(HOME);
  });

  it('cannot descend into a folder it could not read', async () => {
    open();

    const locked = await findRow(/locked/);
    expect(locked).toBeDisabled();
    expect(locked).toHaveTextContent('no access');
  });

  it('shows a refusal without closing, keeping the last good listing', async () => {
    open();
    await findRow(/Projects/);
    browse.mockResolvedValue({
      ok: false,
      error: { code: 'EOUTSIDE', message: 'cannot browse that path' },
    });

    await userEvent.click(row(/Projects/));

    expect(await screen.findByText('cannot browse that path')).toBeInTheDocument();
    // Still standing where it was, so the user can simply pick something else.
    expect(row(/Projects/)).toBeInTheDocument();
  });

  it('says so when a folder is empty, and still offers it', async () => {
    browse.mockResolvedValue(listing({ entries: [] }));
    open();

    expect(await screen.findByText(/No folders here/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeEnabled();
  });

  it('reports the browser target rather than rendering an empty folder', async () => {
    browse.mockResolvedValue(null);
    open();

    expect(await screen.findByText(/desktop app/)).toBeInTheDocument();
  });

  /**
   * Two clicks race, and the slower one would otherwise win by arriving last —
   * a fast child overwritten by its own slow parent. Only the most recent
   * request may paint.
   */
  it('ignores a stale response that arrives after a newer one', async () => {
    open();
    await findRow(/Projects/);

    // Descending into Projects is slow and will settle last.
    let settleSlow: (value: unknown) => void = () => {};
    browse.mockReturnValueOnce(
      new Promise((resolve) => {
        settleSlow = resolve;
      }),
    );
    await userEvent.click(row(/Projects/));

    // Climbing back home is fast and settles first.
    browse.mockResolvedValue(listing());
    await userEvent.click(screen.getByRole('button', { name: '~' }));
    await waitFor(() => expect(browse).toHaveBeenLastCalledWith(HOME));

    // Now the earlier, slower descent arrives. It must not repaint.
    settleSlow(listing({ path: `${HOME}/Projects`, entries: [] }));

    await waitFor(() =>
      expect(row(/Projects/)).toBeInTheDocument(),
    );
    expect(screen.getByText(HOME)).toBeInTheDocument();
  });

  it('closes on Cancel without choosing', async () => {
    const { onChoose, onOpenChange } = open();
    await findRow(/Projects/);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChoose).not.toHaveBeenCalled();
  });
});
