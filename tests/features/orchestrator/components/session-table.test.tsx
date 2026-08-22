import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { SessionTable } from '@features/orchestrator/components/session-table';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

const rows = () => screen.getAllByRole('button');

/** The fleet table (story 041) — DOM, so its rows stay clickable. */
describe('SessionTable', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
  });

  /**
   * The orchestrator on a machine where nothing is running.
   *
   * Ten sessions used to be seeded at boot, so this screen always looked busy
   * — the fleet it displayed was the demo's, not the user's. It opens empty
   * now, and the table has to say so rather than showing a header over a void.
   */
  describe('with no sessions', () => {
    beforeEach(() => {
      useHiveStore.getState().reset();
    });

    it('says the fleet is empty, and how to change that', () => {
      render(<SessionTable />);

      expect(screen.getByTestId('session-table-empty')).toHaveTextContent(
        'No sessions running — start one with New session.',
      );
    });

    it('keeps the column header, so the empty area reads as a table', () => {
      render(<SessionTable />);

      expect(screen.getByText('SESSION')).toBeInTheDocument();
      expect(screen.getByText('PROJECT')).toBeInTheDocument();
      expect(screen.getByText('BRANCH')).toBeInTheDocument();
      // `rows()` uses getAllByRole, which throws on an empty fleet — the very
      // case under test.
      expect(screen.queryAllByRole('button')).toHaveLength(0);
    });

    /** An ENDED divider with nothing under it reads as a rendering bug. */
    it('shows no ENDED group', () => {
      render(<SessionTable />);

      expect(screen.queryByText('ENDED')).not.toBeInTheDocument();
    });
  });

  it('drops the empty notice as soon as a session exists', () => {
    render(<SessionTable />);

    expect(screen.queryByTestId('session-table-empty')).not.toBeInTheDocument();
  });

  it('partitions the seeded fleet into 8 active and 2 ended', () => {
    render(<SessionTable />);

    // The exact split the story's acceptance criteria name.
    expect(rows()).toHaveLength(10);
    expect(screen.getByText('ENDED')).toBeInTheDocument();
  });

  it('lists active sessions before the divider and done ones after', () => {
    render(<SessionTable />);
    const labels = rows().map((row) => row.textContent ?? '');

    // `tz-fix` and `ecs-scaling` are the two done fixtures.
    expect(labels.slice(0, 8).join(' ')).not.toContain('tz-fix');
    expect(labels.slice(8).join(' ')).toContain('tz-fix');
    expect(labels.slice(8).join(' ')).toContain('ecs-scaling');
  });

  it('shows id, status, project, branch, and PR for a row', () => {
    render(<SessionTable />);
    const row = rows()[0];

    expect(within(row).getByText('hero-refresh')).toBeInTheDocument();
    expect(within(row).getByText('working')).toBeInTheDocument();
    // Two cells, not one joined string: a `PROJECT · BRANCH` header can never
    // line up with the values under it, because the label sits where the phrase
    // puts it and each branch starts where its project name ends.
    expect(within(row).getByText('apfm-web')).toBeInTheDocument();
    expect(within(row).getByText('feat/hero-refresh')).toBeInTheDocument();
    expect(within(row).getByText('#482')).toBeInTheDocument();
  });

  it('leaves the BRANCH column an em dash until one is observed', () => {
    /**
     * HIVE-78. The fleet table exists to tell thirteen terminals apart, and the
     * branch is one of the two things that does it — so a column full of
     * `feat/sess-01`, `feat/sess-02` was not merely wrong, it was *convincing*.
     * An em dash cannot be mistaken for an answer.
     */
    act(() => {
      useHiveStore.getState().reset();
    });
    const id = useHiveStore.getState().spawnSession('apfm-web');

    render(<SessionTable />);
    const row = rows()[0];

    /**
     * By `title`, not by text: the PR column renders its own em dash for "no
     * pull request", so a bare text query matches two cells. The branch cell is
     * the one that carries the value as a tooltip — which it does precisely
     * because the column truncates.
     */
    expect(within(row).getByTitle('—')).toBeInTheDocument();
    expect(within(row).queryByText(`feat/${id}`)).not.toBeInTheDocument();
  });

  it('names the PR state rather than carrying it in colour alone', () => {
    render(<SessionTable />);
    const row = rows()[0];

    // 34px leaves no room for the state as visible text, but a hue is no
    // signal to a colour-blind user and none at all to a screen reader.
    expect(within(row).getByText('#482')).toHaveAttribute(
      'title',
      '#482 · open',
    );
    expect(row).toHaveAccessibleName(/open/);
  });

  it('renders an em dash for a session with no PR', () => {
    render(<SessionTable />);
    const leadForm = rows().find((row) => row.textContent?.includes('lead-form'));

    expect(within(leadForm!).getByText('—')).toBeInTheDocument();
  });

  it('renames a waiting session to "needs input"', () => {
    render(<SessionTable />);
    const leadForm = rows().find((row) => row.textContent?.includes('lead-form'));

    expect(within(leadForm!).getByText('needs input')).toBeInTheDocument();
  });

  it('names what a quiet session is still running', () => {
    render(<SessionTable />);

    act(() => {
      useHiveStore
        .getState()
        .setSessionStatus('rails-upgrade', 'idle', 'agents');
    });

    const railsUpgrade = rows().find((row) =>
      row.textContent?.includes('rails-upgrade'),
    );

    expect(within(railsUpgrade!).getByText('idle (agents)')).toBeInTheDocument();
  });

  it('selects and opens on click', async () => {
    const user = userEvent.setup();
    render(<SessionTable />);

    const webhooks = rows().find((row) => row.textContent?.includes('webhooks'));
    await user.click(webhooks!);

    // Both, not one: the caret has to follow the user's last action or the
    // keyboard and the mouse disagree about where "here" is.
    expect(useUiStore.getState().activeTab).toBe('webhooks');
    expect(useUiStore.getState().selIdx).toBe(2);
  });

  describe('a terminated session (story 108)', () => {
    const webhooks = () =>
      rows().find((row) => row.textContent?.includes('webhooks'))!;

    const terminate = () =>
      act(() =>
        useHiveStore.getState().setSessionStatus('webhooks', 'terminated'),
      );

    it('says so in the status column', () => {
      render(<SessionTable />);
      terminate();

      // Its own word, not `done`. One finished; the other quit, and the fleet
      // view is where that difference is decided upon.
      expect(within(webhooks()).getByText('terminated')).toBeInTheDocument();
    });

    it('moves under the divider with the other endings', () => {
      render(<SessionTable />);
      terminate();

      const labels = rows().map((row) => row.textContent ?? '');
      expect(labels.slice(0, 7).join(' ')).not.toContain('webhooks');
      expect(labels.slice(7).join(' ')).toContain('webhooks');
    });

    it('cannot be entered, and says why', async () => {
      /**
       * `disabled`, not a silently ignored click. The row's job on this screen
       * is to say what happened to a session, so it stays legible and stays in
       * the list — but a button that looks live and does nothing is worse than
       * one that says it is spent, and `disabled` is the only version of that a
       * screen reader hears too.
       */
      const user = userEvent.setup();
      render(<SessionTable />);
      terminate();

      expect(webhooks()).toBeDisabled();
      expect(webhooks()).toHaveAttribute(
        'title',
        'webhooks has terminated — its process is gone',
      );

      await user.click(webhooks());
      expect(useUiStore.getState().activeTab).toBe('orch');
    });

    it('leaves every other row clickable', async () => {
      const user = userEvent.setup();
      render(<SessionTable />);
      terminate();

      const heroRefresh = rows().find((row) =>
        row.textContent?.includes('hero-refresh'),
      );
      await user.click(heroRefresh!);

      expect(useUiStore.getState().activeTab).toBe('hero-refresh');
    });
  });

  it('shows a newly spawned session immediately', () => {
    render(<SessionTable />);
    expect(rows()).toHaveLength(10);

    act(() => {
      useHiveStore.getState().spawnSession('apfm-web', 'a new thing');
    });

    expect(rows()).toHaveLength(11);
  });

  /**
   * Last run's fleet (HIVE-87).
   *
   * The group exists to answer a different question from ENDED's, so most of
   * what matters here is *where* it sits and that its rows stay inert.
   */
  describe('the PREVIOUS RUN group', () => {
    const restore = () => {
      act(() => {
        useHiveStore.getState().hydrateSessions([
          {
            id: 'old-01',
            project: 'apfm-web',
            task: '',
            status: 'working',
            branch: 'feat/old',
            createdAt: 1,
          },
        ]);
      });
    };

    it('renders restored rows under their own divider', () => {
      restore();
      render(<SessionTable />);

      expect(screen.getByText('PREVIOUS RUN')).toBeInTheDocument();
      expect(screen.getByText('closed')).toBeInTheDocument();
    });

    it('puts that divider above ENDED, not below it', () => {
      // The ordering the design turns on: at launch this is the only group on
      // the table, so it belongs where the eye lands.
      restore();
      render(<SessionTable />);

      const previous = screen.getByText('PREVIOUS RUN');
      const ended = screen.getByText('ENDED');
      expect(previous.compareDocumentPosition(ended)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });

    it('puts a restored row that ended normally in PREVIOUS RUN, not ENDED', () => {
      /**
       * The grouping keys on provenance, not on the status.
       *
       * `settleExit` is the only writer of an ended status, so a session that
       * quit normally last run is recorded — and restored — as `terminated`.
       * Grouping on `closed` alone sent every one of those to ENDED, the group
       * whose job is answering "what did I just finish?" about *this* run, so
       * the first launch after a busy day buried today's endings under
       * yesterday's.
       */
      act(() => {
        useHiveStore.getState().hydrateSessions([
          {
            id: 'old-term',
            project: 'apfm-web',
            task: '',
            status: 'terminated',
            createdAt: 1,
          },
        ]);
      });
      render(<SessionTable />);

      const previous = screen.getByText('PREVIOUS RUN');
      const row = screen
        .getAllByRole('button')
        .find((button) => within(button).queryByText(/old-term/) !== null)!;

      // It sits after the PREVIOUS RUN divider, and before ENDED if there is one.
      expect(previous.compareDocumentPosition(row)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const ended = screen.queryByText('ENDED');
      if (ended) {
        expect(row.compareDocumentPosition(ended)).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }
      // And it keeps the ending that was actually observed.
      expect(within(row).getByText('terminated')).toBeInTheDocument();
    });

    it('is absent entirely when nothing was restored', () => {
      render(<SessionTable />);

      expect(screen.queryByText('PREVIOUS RUN')).not.toBeInTheDocument();
    });

    it('does not count restored rows as an empty fleet', () => {
      useHiveStore.getState().reset();
      restore();
      render(<SessionTable />);

      expect(screen.queryByTestId('session-table-empty')).not.toBeInTheDocument();
    });

    it('refuses to open a restored row, and says why', async () => {
      // Inherited from `openEntity`'s existing gate rather than added: `closed`
      // is an ending, so every ended-row behaviour already applies to it.
      restore();
      render(<SessionTable />);

      const row = screen
        .getAllByRole('button')
        .find((button) => within(button).queryByText('closed') !== null)!;

      expect(row).toBeDisabled();
      expect(row).toHaveAttribute(
        'title',
        'old-01 was open when The Hive last closed — its process did not survive',
      );

      await userEvent.click(row);
      expect(useUiStore.getState().activeTab).not.toBe('old-01');
    });
  });
});
