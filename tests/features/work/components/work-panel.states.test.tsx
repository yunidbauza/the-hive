import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkPanel } from '@features/work/components/work-panel';
import { useHiveStore } from '@stores/hive-store';
import type { JiraIssue } from '@shared/jira-contract';

/**
 * One case per `TicketSource` (HIVE-69).
 *
 * The panel's whole job beyond mapping over tickets is saying *which* of the
 * five states it is in, and every one of them has something to say — including
 * `loading`, which says it with a skeleton. Kept separate from
 * `work-panel.test.tsx`, which covers how a ticket renders once it is there.
 */

const refreshTickets = vi.fn(() => Promise.resolve());

const issue = (over: Partial<JiraIssue> = {}): JiraIssue => ({
  key: 'HIVE-1',
  summary: 'A real ticket',
  status: 'In Progress',
  statusCategory: 'in-progress',
  issueType: 'Story',
  priority: null,
  assignee: null,
  updated: '2026-08-07T00:00:00.000-0400',
  url: 'https://behiques.atlassian.net/browse/HIVE-1',
  ...over,
});

const state = () => useHiveStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  state().reset();
  // The mount effect is not what these cases are about; each one installs the
  // source it wants and asserts what the panel says about it.
  useHiveStore.setState({ refreshTickets });
});

afterEach(() => {
  state().reset();
});

/**
 * The state this whole change exists to produce.
 *
 * There used to be a `fixtures` state here, asserting the panel said nothing
 * because eight seeded tickets were already on screen — which is exactly the
 * bug: a real read then replaced them a frame later, so the user watched sample
 * data turn into their backlog. The store boots `loading` now and has nothing
 * to show until Jira answers.
 */
describe('the loading state', () => {
  it('is where the panel starts, before any read has answered', () => {
    expect(state().ticketSource).toEqual({ kind: 'loading' });
  });

  it('shows a skeleton instead of tickets it does not have yet', () => {
    render(<WorkPanel />);

    expect(screen.getByRole('status', { name: 'Loading tickets' })).toBeInTheDocument();
    expect(screen.queryAllByRole('article')).toHaveLength(0);
  });

  it('says none of the things the settled states say', () => {
    render(<WorkPanel />);

    expect(screen.queryByText(/out of date/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No Jira connection yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No issues matched/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  /**
   * The load-bearing assertion, stated as a negative because that is what the
   * bug was: no seeded ticket key can reach the screen, in any state, because
   * no seeded ticket exists to reach it.
   */
  it('never paints a seeded ticket key', () => {
    render(<WorkPanel />);

    expect(screen.queryByText(/^GRAC-/)).not.toBeInTheDocument();
  });

  it('leaves loading once a read resolves', () => {
    render(<WorkPanel />);
    expect(screen.getByRole('status', { name: 'Loading tickets' })).toBeInTheDocument();

    act(() => {
      state().hydrateTickets([issue()], false);
    });

    expect(screen.queryByRole('status', { name: 'Loading tickets' })).not.toBeInTheDocument();
    expect(screen.getByText('HIVE-1')).toBeInTheDocument();
  });
});

describe('the unconfigured state', () => {
  beforeEach(() => {
    state().reportTicketsUnconfigured();
  });

  it('explains rather than showing an empty panel', () => {
    render(<WorkPanel />);

    expect(screen.getByText(/No Jira connection yet/i)).toBeInTheDocument();
    expect(screen.getByText('Settings → Integrations')).toBeInTheDocument();
  });

  it('shows no fixture tickets — those would look like a real backlog', () => {
    render(<WorkPanel />);
    expect(screen.queryByText('GRAC-3018')).not.toBeInTheDocument();
  });
});

describe('the live state', () => {
  it('renders the issues, with no notice', () => {
    state().hydrateTickets([issue(), issue({ key: 'HIVE-2' })], false);
    render(<WorkPanel />);

    expect(screen.getByText('HIVE-1')).toBeInTheDocument();
    expect(screen.getByText('HIVE-2')).toBeInTheDocument();
    expect(screen.queryByText(/out of date/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/first 200/i)).not.toBeInTheDocument();
  });

  it('links a real ticket out to Jira', () => {
    state().hydrateTickets([issue()], false);
    render(<WorkPanel />);

    expect(screen.getByRole('link', { name: 'HIVE-1' })).toHaveAttribute(
      'href',
      'https://behiques.atlassian.net/browse/HIVE-1',
    );
  });

  it('says so when the cap stopped paging', () => {
    state().hydrateTickets([issue()], true);
    render(<WorkPanel />);

    expect(screen.getByText(/first 200/i)).toBeInTheDocument();
  });

  it('says a query matched nothing rather than rendering a blank column', () => {
    state().hydrateTickets([], false);
    render(<WorkPanel />);

    expect(screen.getByText(/No issues matched your query/i)).toBeInTheDocument();
  });

  it('leads that answer with a spire at rail size', () => {
    state().hydrateTickets([], false);
    render(<WorkPanel />);

    const img = screen.getByRole('presentation', { hidden: true });

    expect(img).toHaveAttribute('data-creature', 'spire');
    expect(img).toHaveStyle({ height: '44px' });
  });
});

describe('the stale state', () => {
  beforeEach(() => {
    state().hydrateTickets([issue()], false);
    state().reportTicketFailure('Could not reach Jira.');
  });

  it('keeps the tickets on screen', () => {
    render(<WorkPanel />);

    // Staleness over emptiness: these were true a minute ago.
    expect(screen.getByText('HIVE-1')).toBeInTheDocument();
  });

  it('says they may be out of date, and offers a retry', async () => {
    const user = userEvent.setup();
    render(<WorkPanel />);

    expect(screen.getByText(/may be out of date/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Try again/i }));
    expect(refreshTickets).toHaveBeenCalled();
  });
});

describe('the failed state', () => {
  beforeEach(() => {
    state().reportTicketsUnconfigured();
    state().reportTicketFailure('Jira rejected the credential.');
  });

  it("shows main's own message", () => {
    render(<WorkPanel />);
    expect(
      screen.getByText('Jira rejected the credential.'),
    ).toBeInTheDocument();
  });

  it('offers a retry', async () => {
    const user = userEvent.setup();
    render(<WorkPanel />);

    await user.click(screen.getByRole('button', { name: /Try again/i }));
    expect(refreshTickets).toHaveBeenCalled();
  });
});

describe('refresh on open', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads once immediately on mount', () => {
    render(<WorkPanel />);

    // The left rail unmounts panels on tab switch, so mounting *is* the pane
    // opening — the refresh is as frequent as the user looking at it.
    expect(refreshTickets).toHaveBeenCalledTimes(1);
  });

  /**
   * The panel used to stop there (HIVE-81): one read on mount, and nothing
   * again until the tab was closed and reopened. `useTicketRefresh` keeps it
   * current on the same minute cadence the PR rows already had.
   */
  it('reads again after the interval', async () => {
    render(<WorkPanel />);
    // Let the mount sweep's promise settle before clearing — otherwise the
    // in-flight guard is still holding it and the next tick is a silent no-op.
    await act(async () => {
      await Promise.resolve();
    });
    refreshTickets.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });

    expect(refreshTickets).toHaveBeenCalledTimes(1);
  });
});
