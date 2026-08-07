import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { WorkPanel } from '@features/work/components/work-panel';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

const card = (key: string) =>
  screen.getByText(key).closest('article') as HTMLElement;

describe('WorkPanel', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    /**
     * Stub the mount-time read.
     *
     * The panel refreshes when it mounts, and the real action settles on
     * `unconfigured` in a test environment — no bridge, therefore no Jira —
     * which would wipe the seeded tickets before a single assertion ran. These
     * cases are about how a ticket *renders*, not where it came from;
     * `work-panel.states.test.tsx` owns the source states.
     */
    useHiveStore.setState({ refreshTickets: () => Promise.resolve() });
    useUiStore.getState().reset();
  });

  it('renders all eight seeded tickets, in order', () => {
    render(<WorkPanel />);

    const keys = screen
      .getAllByRole('article')
      .map((el) => el.querySelector('span')?.textContent);

    expect(keys).toEqual([
      'GRAC-3018',
      'GRAC-3022',
      'GRAC-2991',
      'GRAC-3010',
      'GRAC-2977',
      'GRAC-3005',
      'GRAC-2810',
      'GRAC-2954',
    ]);
  });

  it('shows each ticket’s title and status', () => {
    render(<WorkPanel />);

    expect(
      within(card('GRAC-3018')).getByText(
        'Hero refresh: migrate to semantic tokens',
      ),
    ).toBeInTheDocument();
    expect(
      within(card('GRAC-3018')).getByText('In Progress'),
    ).toBeInTheDocument();
  });

  /**
   * Colour comes from `statusCategory`, not from the status name (HIVE-69).
   *
   * "In Review" is `indeterminate` in Jira — the same bucket as "In Progress" —
   * so it is brand-coloured rather than amber. That is a deliberate change: the
   * app now agrees with the colour Jira paints its own lozenge, instead of
   * holding a second opinion in a table that would need a new row every time
   * somebody added a workflow state.
   */
  it('colours the status pill by category, not by name', () => {
    render(<WorkPanel />);

    expect(within(card('GRAC-3018')).getByText('In Progress')).toHaveClass(
      'text-brand',
    );
    expect(within(card('GRAC-2991')).getByText('In Review')).toHaveClass(
      'text-brand',
    );
    expect(within(card('GRAC-2810')).getByText('Done')).toHaveClass(
      'text-green',
    );
  });

  /** The AC: GRAC-3010 is the two-session ticket. */
  it('lists every linked session', () => {
    render(<WorkPanel />);

    const ticket = within(card('GRAC-3010'));
    expect(ticket.getByText('nplusone')).toBeInTheDocument();
    expect(ticket.getByText('e2e-quote')).toBeInTheDocument();
  });

  it('shows each session’s project beside it', () => {
    render(<WorkPanel />);

    const ticket = within(card('GRAC-3010'));
    expect(ticket.getByText('referral-api')).toBeInTheDocument();
    expect(ticket.getByText('apfm-web')).toBeInTheDocument();
  });

  it('opens a session’s tab from its row', async () => {
    render(<WorkPanel />);

    await userEvent.click(
      within(card('GRAC-3018')).getByRole('button', { name: /hero-refresh/ }),
    );

    expect(useUiStore.getState().activeTab).toBe('hero-refresh');
  });

  it('renders a PR row with its number, repo, and state', () => {
    render(<WorkPanel />);

    const ticket = within(card('GRAC-3018'));
    expect(ticket.getByText('#482')).toBeInTheDocument();
    expect(ticket.getByText('open')).toBeInTheDocument();
  });

  /** The single-source-of-truth rule, end to end. */
  it('shows the global PR state, not the session’s stale copy', () => {
    render(<WorkPanel />);

    // #219 is `approved` globally but still `open` on the webhooks session.
    expect(within(card('GRAC-2991')).getByText('approved')).toBeInTheDocument();
    expect(
      within(card('GRAC-2991')).queryByText('open'),
    ).not.toBeInTheDocument();
  });

  /**
   * The fallback the selector was rewritten for: #31 is on `ecs-scaling` but
   * absent from the global list, and must still appear.
   */
  it('shows a PR the global list does not know', () => {
    render(<WorkPanel />);

    const ticket = within(card('GRAC-2954'));
    expect(ticket.getByText('#31')).toBeInTheDocument();
    expect(ticket.getByText('merged')).toBeInTheDocument();
  });

  it('flags open findings and describes them for screen readers', () => {
    render(<WorkPanel />);

    const ticket = within(card('GRAC-3018'));
    expect(ticket.getByText('⚠ 2')).toBeInTheDocument();
    expect(ticket.getByText('2 open findings')).toBeInTheDocument();
  });

  it('omits the findings flag when a PR has none', () => {
    render(<WorkPanel />);

    expect(within(card('GRAC-2991')).queryByText(/⚠/)).not.toBeInTheDocument();
  });

  /** No PRs must mean no divider either — an empty rule reads as a bug. */
  it('omits the PR section entirely for a ticket with no PRs', () => {
    render(<WorkPanel />);

    const ticket = card('GRAC-3010');
    expect(within(ticket).queryByText(/^#\d+$/)).not.toBeInTheDocument();
    expect(ticket.querySelector('.border-t')).toBeNull();
  });

  it('opens the owning session’s tab from a PR row', async () => {
    render(<WorkPanel />);

    await userEvent.click(
      within(card('GRAC-3018')).getByRole('button', { name: /#482/ }),
    );

    expect(useUiStore.getState().activeTab).toBe('hero-refresh');
  });

  /** Defensive: the simulation may not create everything a ticket names. */
  it('skips a session the store does not know, without throwing', () => {
    act(() => {
      useHiveStore.setState({
        tickets: [
          {
            key: 'GHOST-1',
            status: 'To Do',
            statusCategory: 'todo',
            title: 'Names a session that never existed',
            sessions: ['not-a-session', 'hero-refresh'],
          },
        ],
      });
    });

    render(<WorkPanel />);

    expect(screen.getByText('hero-refresh')).toBeInTheDocument();
    expect(screen.queryByText('not-a-session')).not.toBeInTheDocument();
  });

  it('keeps findings in sync with the PRs list', () => {
    render(<WorkPanel />);
    expect(within(card('GRAC-3018')).getByText('⚠ 2')).toBeInTheDocument();

    act(() => {
      useHiveStore.setState((state) => ({
        prs: state.prs.map((pr) => (pr.n === 482 ? { ...pr, findings: 5 } : pr)),
      }));
    });

    expect(within(card('GRAC-3018')).getByText('⚠ 5')).toBeInTheDocument();
  });
});
