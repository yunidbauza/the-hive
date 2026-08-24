import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { SessionTable } from '@features/orchestrator/components/session-table';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

const rows = () => screen.getAllByRole('button');

/**
 * The whole row, not just the button inside it.
 *
 * `PR` and Resume are siblings of that button rather than cells within it —
 * they are a link and a button, and neither may be nested inside one
 * (HIVE-93, HIVE-100). So an assertion about a row's pull request has to be
 * scoped to the shell that holds all three, or it escapes to the table.
 */
const shellOf = (row: HTMLElement): HTMLElement => {
  const shell = row.closest('[data-testid="session-row"]');
  if (!(shell instanceof HTMLElement)) {
    throw new Error('row button is not inside a session-row shell');
  }
  return shell;
};

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
    /*
      Resolved from the live PR list by branch, not read off the session
      (HIVE-100). `Session.pr` was the field this column used to read and nothing
      ever wrote it, so every row showed `—` in the running app while the
      fixtures made it look populated. The fixture now supplies only what GitHub
      supplies — a `PrRecord` on `feat/hero-refresh` — and the column derives
      the rest.
    */
    expect(within(shellOf(row)).getByText('#482')).toBeInTheDocument();
  });

  it('links the PR to its GitHub page', () => {
    render(<SessionTable />);

    /*
      A real anchor, so middle-click and "copy link" work — the same treatment
      `pr-card` and `ticket-pr-row` give the number. The underline is what says
      so in a monospace table, where `#482` would otherwise look like any other
      cell value.
    */
    const link = within(shellOf(rows()[0])).getByRole('link');

    expect(link).toHaveAttribute(
      'href',
      'https://github.com/demo/apfm-web/pull/482',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveClass('underline');
  });

  /**
   * Two rows on one branch is the ordinary case after a `/clear`: the successor
   * inherits the branch, so both point at the same pull request and neither may
   * claim it exclusively.
   *
   * This is the behaviour that replaced `hive-store.clear-session`'s old
   * "successor carries no PR" assertion. That one passed for the wrong reason —
   * nothing wrote `Session.pr`, so *no* session had one — and a PR belongs to
   * the branch both rows are on.
   */
  it('gives the same PR to both rows after a clear', () => {
    act(() => {
      useHiveStore.getState().clearSession('hero-refresh');
    });
    render(<SessionTable />);

    expect(screen.getAllByRole('link', { name: /#482/ })).toHaveLength(2);
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
    const link = within(shellOf(row)).getByRole('link');

    expect(link).toHaveAttribute('title', '#482 · open — open on GitHub');
    /*
      On the link's own accessible name, and *not* in an `sr-only` span beside
      the number: `aria-label` replaces an element's content for accessibility,
      so a hidden word inside this anchor would be computed away and announced
      to nobody — leaving colour as the only carrier of the state, which is the
      failure this test exists to catch.
    */
    expect(link).toHaveAccessibleName(/open$/);
  });

  it('renders an em dash for a session with no PR', () => {
    render(<SessionTable />);
    const leadForm = rows().find((row) => row.textContent?.includes('lead-form'));

    /*
      `fix/lead-form-validation` carries no `PrRecord`, so the cell says so —
      and says it as plain text rather than a link, since there is no page to
      open. The em dash is scoped to the PR cell by `title`: the BRANCH column
      renders its own for an unobserved branch (HIVE-78).
    */
    const cell = within(shellOf(leadForm!)).getByTitle('no pull request');

    expect(cell).toHaveTextContent('—');
    expect(within(shellOf(leadForm!)).queryByRole('link')).toBeNull();
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
            resumable: true,
          },
        ]);
      });
    };

    it('renders restored rows under their own divider', () => {
      restore();
      render(<SessionTable />);

      expect(screen.getByText('PREVIOUS RUN')).toBeInTheDocument();
      // `closed` folded into `done` (HIVE-93) — the word the user sees for
      // every deliberate ending, with the *how* carried by `endedBy`.
      expect(screen.getAllByText('done').length).toBeGreaterThan(0);
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

    it('offers resume on a restored row rather than opening it (HIVE-93)', async () => {
      /*
        The affordance moved off the status and onto a control. The row itself
        is now disabled like every other ending — clicking it would show a pty
        that is gone — and `resume` is what picks the conversation back up.
      */
      restore();
      render(<SessionTable />);

      const row = screen
        .getAllByRole('button')
        .find((button) => within(button).queryByText('old-01') !== null)!;
      expect(row).toBeDisabled();
      expect(row).toHaveAttribute(
        'title',
        'old-01 was open when The Hive last closed — resume to pick it back up',
      );

      const resume = screen.getByRole('button', { name: /^resume old-01/ });
      await userEvent.click(resume);

      expect(useUiStore.getState().activeTab).toBe('old-01');
    });

    it('offers no resume where there is no conversation to reopen', () => {
      /*
        `resumable` is main's answer, not a guess from the status: it holds the
        uuid and knows whether that conversation is already open. A row without
        one must not offer a control that would fail after the click.
      */
      act(() => {
        useHiveStore.getState().hydrateSessions([
          {
            id: 'gone-01',
            project: 'apfm-web',
            task: '',
            status: 'terminated',
            createdAt: 1,
          },
        ]);
      });
      render(<SessionTable />);

      expect(
        screen.queryByRole('button', { name: /^resume gone-01/ }),
      ).not.toBeInTheDocument();
    });

    /**
     * The Resume column is reserved by the *table*, not by the row (HIVE-100).
     *
     * Resume is a sibling of the row's button, so it takes width from the flex
     * line that the cells share. Left unreserved, it pushed every cell out from
     * under the header word naming it — which is how `PR` came to sit above a
     * stack of `resume`s in the screenshot that opened this story.
     *
     * These two assertions pin the count, which is all happy-dom can see; that
     * the reserved cell actually lands the columns on a shared x is measured in
     * a real browser by `tests/e2e/electron/table-alignment.spec.ts`, because
     * no layout happens here.
     */
    it('reserves the resume column on every row once any row needs it', () => {
      restore();
      render(<SessionTable />);

      /*
        One per row **plus the header**. The header's cell is the whole point:
        the rows agreeing with each other and not with the heading above them
        is the defect, not the fix.

        The count also says the slot is on rows that will never draw a button:
        `restore()` adds one resumable row to a demo fleet of ten that are not,
        so exactly one Resume exists and eleven rows reserve room for it. A slot
        drawn per-*control* rather than per-*table* would leave those ten
        disagreeing with the eleventh about where `PR` starts.
      */
      const rows = screen.getAllByTestId('session-row').length;
      expect(document.querySelectorAll('[data-col="action"]')).toHaveLength(
        rows + 1,
      );
      expect(screen.getAllByRole('button', { name: /^resume / })).toHaveLength(
        1,
      );
    });

    it('reserves nothing while no row can be resumed', () => {
      render(<SessionTable />);

      /*
        The demo fleet ends two sessions and resumes neither, so the column is
        not merely empty — it is absent, and the table is 52px narrower for it.
        That is the reason this is a table-wide answer rather than a permanent
        column: `COL` documents the width budget it would otherwise spend.
      */
      expect(screen.queryByRole('button', { name: /^resume / })).toBeNull();
      expect(document.querySelectorAll('[data-col="action"]')).toHaveLength(0);
    });

    it('moves a revived row to ACTIVE and draws it exactly once', () => {
      /**
       * The bug itself (HIVE-88). Before the fix the row kept `restored` after
       * its process reported `working`, so it satisfied both groups' selectors
       * and the table painted it under ACTIVE *and* under PREVIOUS RUN — two
       * rows, one agent.
       */
      restore();
      render(<SessionTable />);
      act(() => {
        useHiveStore.getState().setSessionStatus('old-01', 'working');
      });

      const rows = screen
        .getAllByRole('button')
        .filter((button) => within(button).queryByText(/old-01/) !== null);
      expect(rows).toHaveLength(1);
      expect(within(rows[0]!).getByText('working')).toBeInTheDocument();
      expect(screen.queryByText('PREVIOUS RUN')).not.toBeInTheDocument();
      // The active group has no divider of its own: it is everything above
      // ENDED. Being above that divider is being in ACTIVE.
      const ended = screen.getByText('ENDED');
      expect(rows[0]!.compareDocumentPosition(ended)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });

    it('keeps a row main still runs out of PREVIOUS RUN from the start', () => {
      // A window reopened in front of running ptys: main marks those live, and
      // they are this run's fleet from the first paint.
      act(() => {
        useHiveStore.getState().hydrateSessions([
          {
            id: 'live-01',
            project: 'apfm-web',
            task: '',
            status: 'idle',
            createdAt: 1,
            live: true,
          },
        ]);
      });
      render(<SessionTable />);

      expect(screen.queryByText('PREVIOUS RUN')).not.toBeInTheDocument();
      const rows = screen
        .getAllByRole('button')
        .filter((button) => within(button).queryByText(/live-01/) !== null);
      expect(rows).toHaveLength(1);
      expect(within(rows[0]!).getByText('idle')).toBeInTheDocument();
    });
  });
});
