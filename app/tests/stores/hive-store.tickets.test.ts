import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useHiveStore } from '@stores/hive-store';
import type { JiraIssue } from '@shared/jira-contract';

/**
 * The ticket source (HIVE-69).
 *
 * Store actions are plain functions and the highest-value target, per
 * `CLAUDE.md`. The one worth reading twice is `reportTicketFailure`: it does two
 * different things depending on what the store already holds, and the branch
 * that keeps the tickets is the whole "staleness over emptiness" decision.
 */

const issue = (over: Partial<JiraIssue> = {}): JiraIssue => ({
  key: 'HIVE-1',
  summary: 'A real ticket',
  status: 'In Progress',
  statusCategory: 'in-progress',
  issueType: 'Story',
  priority: 'Medium',
  assignee: 'Yunid Bauza',
  updated: '2026-08-07T00:00:00.000-0400',
  url: 'https://behiques.atlassian.net/browse/HIVE-1',
  ...over,
});

const state = () => useHiveStore.getState();

beforeEach(() => {
  state().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the initial source', () => {
  it('is fixtures, with the eight fixture tickets', () => {
    expect(state().ticketSource).toEqual({ kind: 'fixtures' });
    expect(state().tickets).toHaveLength(8);
  });

  it('goes back to fixtures on reset', () => {
    state().hydrateTickets([issue()], false);
    state().reset();

    expect(state().ticketSource).toEqual({ kind: 'fixtures' });
    expect(state().tickets).toHaveLength(8);
  });
});

describe('hydrateTickets', () => {
  it('replaces the fixtures with real issues', () => {
    state().hydrateTickets([issue(), issue({ key: 'HIVE-2' })], false);

    expect(state().tickets.map((t) => t.key)).toEqual(['HIVE-1', 'HIVE-2']);
    expect(state().ticketSource).toEqual({
      kind: 'live',
      stale: false,
      capped: false,
    });
  });

  it('maps summary to title and carries the browse URL', () => {
    state().hydrateTickets([issue()], false);

    expect(state().tickets[0]).toEqual({
      key: 'HIVE-1',
      status: 'In Progress',
      statusCategory: 'in-progress',
      title: 'A real ticket',
      sessions: [],
      url: 'https://behiques.atlassian.net/browse/HIVE-1',
    });
  });

  it('leaves sessions empty, because nothing links one yet', () => {
    state().hydrateTickets([issue()], false);
    expect(state().tickets[0]?.sessions).toEqual([]);
  });

  it('keeps a status Jira invented, verbatim', () => {
    state().hydrateTickets(
      [issue({ status: 'Awaiting deploy', statusCategory: 'in-progress' })],
      false,
    );

    expect(state().tickets[0]?.status).toBe('Awaiting deploy');
    expect(state().tickets[0]?.statusCategory).toBe('in-progress');
  });

  it('carries the capped flag through', () => {
    state().hydrateTickets([issue()], true);
    expect(state().ticketSource).toEqual({
      kind: 'live',
      stale: false,
      capped: true,
    });
  });

  it('clears a stale flag on a successful re-read', () => {
    state().hydrateTickets([issue()], false);
    state().reportTicketFailure('down');
    expect(state().ticketSource).toEqual({
      kind: 'live',
      stale: true,
      capped: false,
    });

    state().hydrateTickets([issue()], false);
    expect(state().ticketSource).toEqual({
      kind: 'live',
      stale: false,
      capped: false,
    });
  });

  it('accepts an empty result — a query can legitimately match nothing', () => {
    state().hydrateTickets([], false);

    expect(state().tickets).toEqual([]);
    expect(state().ticketSource).toEqual({
      kind: 'live',
      stale: false,
      capped: false,
    });
  });
});

describe('reportTicketFailure — staleness over emptiness', () => {
  it('keeps live tickets and only flips stale', () => {
    state().hydrateTickets([issue(), issue({ key: 'HIVE-2' })], false);

    state().reportTicketFailure('Could not reach Jira.');

    // The tickets it is showing were true a minute ago. Replacing a populated
    // panel with an error is the wrong trade for a second-monitor tool.
    expect(state().tickets).toHaveLength(2);
    expect(state().ticketSource).toEqual({
      kind: 'live',
      stale: true,
      capped: false,
    });
  });

  it('preserves capped while going stale', () => {
    state().hydrateTickets([issue()], true);
    state().reportTicketFailure('down');

    expect(state().ticketSource).toEqual({
      kind: 'live',
      stale: true,
      capped: true,
    });
  });

  it('becomes failed when there is nothing to keep', () => {
    state().reportTicketsUnconfigured();

    state().reportTicketFailure('Jira rejected the credential.');

    expect(state().ticketSource).toEqual({
      kind: 'failed',
      message: 'Jira rejected the credential.',
    });
  });

  it('replaces one failure message with the next', () => {
    state().reportTicketsUnconfigured();
    state().reportTicketFailure('first');
    state().reportTicketFailure('second');

    expect(state().ticketSource).toEqual({ kind: 'failed', message: 'second' });
  });
});

describe('reportTicketsUnconfigured', () => {
  it('empties the list rather than leaving fixtures on a desktop panel', () => {
    state().reportTicketsUnconfigured();

    // Showing sample tickets to someone who has not configured Jira would look
    // like their real backlog.
    expect(state().tickets).toEqual([]);
    expect(state().ticketSource).toEqual({ kind: 'unconfigured' });
  });
});

describe('updateTicket (HIVE-70)', () => {
  it('replaces one ticket and leaves the rest alone', () => {
    state().hydrateTickets(
      [issue(), issue({ key: 'HIVE-2' }), issue({ key: 'HIVE-3' })],
      false,
    );

    state().updateTicket(
      issue({ key: 'HIVE-2', status: 'Done', statusCategory: 'done' }),
    );

    expect(state().tickets.map((t) => t.key)).toEqual([
      'HIVE-1',
      'HIVE-2',
      'HIVE-3',
    ]);
    expect(state().tickets[1]?.status).toBe('Done');
    expect(state().tickets[0]?.status).toBe('In Progress');
  });

  it('keeps the position, so the panel does not reorder under the cursor', () => {
    state().hydrateTickets([issue(), issue({ key: 'HIVE-2' })], false);

    state().updateTicket(issue({ key: 'HIVE-2', status: 'Done' }));

    // The default query sorts by `updated`, so a full re-read would jump the
    // just-transitioned issue to the top the instant the user clicked it.
    expect(state().tickets[1]?.key).toBe('HIVE-2');
  });

  it('carries the existing sessions over', () => {
    state().hydrateTickets([issue()], false);
    // A later story may link sessions to real tickets; this must survive it.
    useHiveStore.setState((current) => ({
      tickets: current.tickets.map((t) => ({ ...t, sessions: ['hero-refresh'] })),
    }));

    state().updateTicket(issue({ status: 'Done' }));

    expect(state().tickets[0]?.sessions).toEqual(['hero-refresh']);
  });

  it('is a no-op for a key that is not on screen', () => {
    state().hydrateTickets([issue()], false);

    state().updateTicket(issue({ key: 'OTHER-9' }));

    // Not an append: an unknown key means the list changed underneath, and the
    // next refresh is the right fix rather than an orphan row.
    expect(state().tickets.map((t) => t.key)).toEqual(['HIVE-1']);
  });

  it('leaves the source alone', () => {
    state().hydrateTickets([issue()], true);

    state().updateTicket(issue({ status: 'Done' }));

    expect(state().ticketSource).toEqual({
      kind: 'live',
      stale: false,
      capped: true,
    });
  });
});
