import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectConfig } from '@shared/config-contract';

import { ProjectsList } from '@features/settings/components/projects-list';
import { useHiveStore } from '@stores/hive-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

const chooseProjectDirectory = vi.fn();
const removeProjectFromConfig = vi.fn();
const renameProjectInConfig = vi.fn();
const repointProjectInConfig = vi.fn();
const reorderProjectsInConfig = vi.fn();

vi.mock('@/lib/project-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/project-config')>();
  return {
    ...actual,
    chooseProjectDirectory: () => chooseProjectDirectory(),
    removeProjectFromConfig: (request: unknown) =>
      removeProjectFromConfig(request),
    renameProjectInConfig: (request: unknown) => renameProjectInConfig(request),
    repointProjectInConfig: (request: unknown) =>
      repointProjectInConfig(request),
    reorderProjectsInConfig: (request: unknown) =>
      reorderProjectsInConfig(request),
  };
});

/** A resolved v2 entry, with only the interesting fields varying. */
const entry = (over: Partial<ProjectConfig> & { id: string }): ProjectConfig => ({
  name: over.id,
  path: `/repos/${over.id}`,
  icon: 'ph-folder',
  origin: 'local',
  status: 'ok',
  isRepo: true,
  ...over,
});

const abc = [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })];

const openMenu = (name: string) =>
  userEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));

const choose = (label: RegExp) =>
  userEvent.click(screen.getByRole('menuitem', { name: label }));

/**
 * The projects list (story 103).
 *
 * Extracted from `projects-section.tsx` because the drag state has to live
 * above the rows, and a row that grew a grip, a menu, an inline editor and an
 * inline confirmation would have been doing too much on its own.
 *
 * The live-session gate is exercised through the **real** store rather than a
 * mocked hook, following `projects-section.test.tsx`: the fixtures already run
 * live sessions on `apfm-web`, so declaring that id is how a test produces a
 * project that owns one.
 */
describe('ProjectsList', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    vi.clearAllMocks();
    chooseProjectDirectory.mockResolvedValue('/repos/moved');
    removeProjectFromConfig.mockResolvedValue(undefined);
    renameProjectInConfig.mockResolvedValue(undefined);
    repointProjectInConfig.mockResolvedValue(undefined);
    reorderProjectsInConfig.mockResolvedValue(undefined);
  });

  it('renders one row per entry, in the order given', () => {
    render(<ProjectsList entries={abc} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(
      screen.getAllByRole('listitem').map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining('a'),
      expect.stringContaining('b'),
      expect.stringContaining('c'),
    ]);
  });

  describe('reordering by menu', () => {
    it('posts the whole new order when moving a row down', async () => {
      render(<ProjectsList entries={abc} />);

      await openMenu('a');
      await choose(/move down/i);

      expect(reorderProjectsInConfig).toHaveBeenCalledWith({
        ids: ['b', 'a', 'c'],
      });
    });

    it('posts the whole new order when moving a row up', async () => {
      render(<ProjectsList entries={abc} />);

      await openMenu('c');
      await choose(/move up/i);

      expect(reorderProjectsInConfig).toHaveBeenCalledWith({
        ids: ['a', 'c', 'b'],
      });
    });

    it('disables the move that would fall off either end', async () => {
      render(<ProjectsList entries={abc} />);

      await openMenu('a');
      expect(screen.getByRole('menuitem', { name: /move up/i })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await userEvent.keyboard('{Escape}');

      await openMenu('c');
      expect(
        screen.getByRole('menuitem', { name: /move down/i }),
      ).toHaveAttribute('aria-disabled', 'true');
    });
  });

  describe('reordering by drag', () => {
    it('reorders when a row is dropped on another', () => {
      render(<ProjectsList entries={abc} />);
      const rows = screen.getAllByRole('listitem');

      fireEvent.dragStart(rows[0]!);
      fireEvent.dragEnter(rows[2]!);
      fireEvent.drop(rows[2]!);

      expect(reorderProjectsInConfig).toHaveBeenCalledWith({
        ids: ['b', 'c', 'a'],
      });
    });

    it('writes nothing when a drag ends where it began', () => {
      render(<ProjectsList entries={abc} />);
      const rows = screen.getAllByRole('listitem');

      fireEvent.dragStart(rows[0]!);
      fireEvent.dragEnter(rows[0]!);
      fireEvent.drop(rows[0]!);

      expect(reorderProjectsInConfig).not.toHaveBeenCalled();
    });

    /**
     * The regression that the original index caused.
     *
     * `index` must be the row's **painted** position. Reading its position in
     * the pre-drag `entries` instead made every reversal lag by one, and made
     * the original order unreachable: a row dragged down could never be
     * dragged back to the top.
     */
    it('follows the pointer back up again, and can return a row to the top', () => {
      render(
        <ProjectsList
          entries={[entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })]}
        />,
      );
      const at = (i: number) => screen.getAllByRole('listitem')[i]!;

      fireEvent.dragStart(at(0));
      fireEvent.dragEnter(at(1));
      fireEvent.dragEnter(at(2));
      // Now painted b, c, a — reverse all the way back.
      fireEvent.dragEnter(at(1));
      fireEvent.dragEnter(at(0));
      fireEvent.drop(at(0));

      // Back where it started, so there is nothing to write.
      expect(reorderProjectsInConfig).not.toHaveBeenCalled();
    });

    it('paints a live preview of where the row will land', () => {
      render(
        <ProjectsList
          entries={[entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })]}
        />,
      );
      const names = () =>
        screen
          .getAllByRole('listitem')
          .map((row) => row.textContent?.match(/^[abc]/)?.[0]);

      expect(names()).toEqual(['a', 'b', 'c']);

      fireEvent.dragStart(screen.getAllByRole('listitem')[0]!);
      fireEvent.dragEnter(screen.getAllByRole('listitem')[1]!);

      // The preview moved before any write — this is what the derived
      // `ordered` memo exists for.
      expect(names()).toEqual(['b', 'a', 'c']);
      expect(reorderProjectsInConfig).not.toHaveBeenCalled();
    });

    /**
     * `dragend` fires even when a drag is abandoned — dropped outside the list
     * or cancelled with Escape. Committing there would reorder on a drag the
     * user backed out of, so the write belongs on `drop`.
     */
    it('writes nothing when a drag is abandoned rather than dropped', () => {
      render(<ProjectsList entries={abc} />);
      const rows = screen.getAllByRole('listitem');

      fireEvent.dragStart(rows[0]!);
      fireEvent.dragEnter(rows[2]!);
      fireEvent.dragEnd(rows[0]!);

      expect(reorderProjectsInConfig).not.toHaveBeenCalled();
    });
  });

  describe('renaming', () => {
    it('writes the new name', async () => {
      render(<ProjectsList entries={[entry({ id: 'a', name: 'Old' })]} />);

      await openMenu('Old');
      await choose(/rename/i);
      await userEvent.clear(screen.getByRole('textbox'));
      await userEvent.type(screen.getByRole('textbox'), 'New{Enter}');

      expect(renameProjectInConfig).toHaveBeenCalledWith({
        id: 'a',
        name: 'New',
      });
    });

    it('leaves the editor and writes nothing when cancelled', async () => {
      render(<ProjectsList entries={[entry({ id: 'a', name: 'Old' })]} />);

      await openMenu('Old');
      await choose(/rename/i);
      await userEvent.type(screen.getByRole('textbox'), '{Escape}');

      expect(renameProjectInConfig).not.toHaveBeenCalled();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });
  });

  describe('re-pointing', () => {
    it('asks main for a directory and writes the one it returns', async () => {
      render(<ProjectsList entries={[entry({ id: 'a' })]} />);

      await openMenu('a');
      await choose(/change folder/i);

      expect(chooseProjectDirectory).toHaveBeenCalled();
      expect(repointProjectInConfig).toHaveBeenCalledWith({
        id: 'a',
        path: '/repos/moved',
      });
    });

    /** Cancelled dialog: nothing to write, and nothing to say. */
    it('writes nothing when the dialog is cancelled', async () => {
      chooseProjectDirectory.mockResolvedValue(null);
      render(<ProjectsList entries={[entry({ id: 'a' })]} />);

      await openMenu('a');
      await choose(/change folder/i);

      expect(repointProjectInConfig).not.toHaveBeenCalled();
    });
  });

  describe('removing', () => {
    it('removes a project with no live sessions in one click', async () => {
      render(<ProjectsList entries={[entry({ id: 'a' })]} />);

      await openMenu('a');
      await choose(/remove/i);

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(removeProjectFromConfig).toHaveBeenCalledWith({ id: 'a' });
    });

    it('confirms first when the project owns live sessions', async () => {
      render(<ProjectsList entries={[entry({ id: 'apfm-web', name: 'APFM' })]} />);

      await openMenu('APFM');
      await choose(/remove/i);

      expect(removeProjectFromConfig).not.toHaveBeenCalled();
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /^remove$/i }));
      expect(removeProjectFromConfig).toHaveBeenCalledWith({ id: 'apfm-web' });
    });

    it('writes nothing when the confirmation is cancelled', async () => {
      render(<ProjectsList entries={[entry({ id: 'apfm-web', name: 'APFM' })]} />);

      await openMenu('APFM');
      await choose(/remove/i);
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

      expect(removeProjectFromConfig).not.toHaveBeenCalled();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    /**
     * The count must be the real one.
     *
     * `useProjectsOwningLiveSessions` deduplicates — it answers "may this be
     * removed?" — so counting *it* always yielded 1, and the confirmation read
     * "1 live session will keep running — **they** just stop resolving",
     * disagreeing with itself in one sentence.
     */
    it('states how many live sessions the project actually owns', async () => {
      const live = useHiveStore
        .getState()
        .order.map((id) => useHiveStore.getState().entities[id])
        .filter(
          (entity) =>
            entity?.kind === 'session' &&
            entity.project === 'apfm-web' &&
            entity.status !== 'done',
        ).length;
      // The fixtures are the point of this test; guard against them changing.
      expect(live).toBeGreaterThan(1);

      render(<ProjectsList entries={[entry({ id: 'apfm-web', name: 'APFM' })]} />);
      await openMenu('APFM');
      await choose(/remove/i);

      expect(
        screen.getByText(new RegExp(`${live} live sessions will keep running`)),
      ).toBeInTheDocument();
    });
  });
});
