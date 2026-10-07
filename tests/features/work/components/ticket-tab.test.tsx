import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Ticket, TicketDetail } from '@/types/ticket';
import { TicketTab } from '@features/work/components/ticket-tab';
import { commentTime } from '@features/work/ticket-presentation';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';
import type { AdfBlock, JiraComment, JiraLink, JiraStatusCategory } from '@shared/jira-contract';

/** The session panel's Ticket tab (HIVE-202). */

const readJiraDetail = vi.fn();
const readJiraComments = vi.fn();
const readJiraTransitions = vi.fn();
const readJiraIssue = vi.fn();
const readJiraLinks = vi.fn();

vi.mock('@/lib/jira', () => ({
  readJiraStatus: () => Promise.resolve(null),
  searchJiraIssues: () => Promise.resolve(null),
  readJiraDetail: (request: unknown) => readJiraDetail(request),
  readJiraComments: (request: unknown) => readJiraComments(request),
  readJiraTransitions: (request: unknown) => readJiraTransitions(request),
  readJiraIssue: (request: unknown) => readJiraIssue(request),
  readJiraLinks: (request: unknown) => readJiraLinks(request),
  applyJiraTransition: () => Promise.resolve(null),
  addJiraComment: () => Promise.resolve(null),
}));

const ok = <T,>(value: T) => ({ ok: true as const, value });
/**
 * A read that does not answer during the test, so whatever it seeded stays as
 * seeded. Each is answered (with no bridge) after the test, so no poller sweep
 * is left in flight to swallow the next test's.
 */
const unanswered: ((value: null) => void)[] = [];
const pending = () =>
  new Promise<null>((resolve) => {
    unanswered.push(resolve);
  });

const text = (value: string) => [{ text: value, marks: [] }];
const para = (value: string): AdfBlock => ({ kind: 'paragraph', runs: text(value) });

const ticket: Ticket = {
  key: 'HIVE-193',
  status: 'In Progress',
  statusCategory: 'in-progress',
  title: '[BE] Fix it',
  priority: null,
  assignee: null,
  issueType: 'Bug',
};

const comment: JiraComment = {
  id: '1',
  author: 'Yunid',
  created: '2026-10-02T09:15:00.000-0400',
  body: [para('Shipped the fix')],
};

const criteria: AdfBlock[] = [
  para('Intro'),
  { kind: 'heading', level: 2, runs: text('Acceptance criteria') },
  { kind: 'bullet', runs: text('One') },
  { kind: 'bullet', runs: text('Two') },
  { kind: 'bullet', runs: text('Three') },
];

const seed = (entry: Partial<TicketDetail> = {}) =>
  useHiveStore.setState({
    ticketDetails: {
      'HIVE-193': {
        key: 'HIVE-193',
        problems: {},
        detail: { description: criteria, parent: null },
        comments: [comment],
        ...entry,
      },
    },
  });

beforeEach(() => {
  vi.clearAllMocks();
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
  seedDemoFleet();
  useHiveStore.setState({ tickets: [ticket], prs: [], ledger: [] });
  for (const reader of [readJiraDetail, readJiraComments, readJiraTransitions, readJiraIssue, readJiraLinks]) {
    reader.mockImplementation(pending);
  }
});

afterEach(async () => {
  vi.useRealTimers();
  for (const resolve of unanswered.splice(0)) resolve(null);
  await act(async () => {
    await Promise.resolve();
  });
});

describe('TicketTab (HIVE-202)', () => {
  it('heads with the key, the type and the status, and the title without its tags', () => {
    seed();
    render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    const sub = screen.getByText('HIVE-193').closest('p');
    expect(sub).toHaveTextContent(/HIVE-193\s*· Bug ·\s*In Progress/);
    expect(screen.getByRole('heading', { name: 'Fix it' })).toBeInTheDocument();
  });

  it('lists the acceptance criteria with a count and no checkbox', () => {
    seed();
    render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    expect(screen.getByRole('heading', { name: 'Acceptance criteria 3' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['One', 'Two', 'Three']);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('falls back to the description, and shows neither for an empty one', () => {
    seed({ detail: { description: [para('Just prose')], parent: null } });
    const { unmount } = render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    expect(screen.getByRole('heading', { name: 'Description' })).toBeInTheDocument();
    expect(screen.getByText('Just prose')).toBeInTheDocument();
    unmount();

    seed({ detail: { description: [], parent: null } });
    render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    expect(screen.queryByRole('heading', { name: 'Description' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Acceptance criteria/ })).not.toBeInTheDocument();
  });

  it('shows the latest comment, and no heading without one', () => {
    seed();
    const { unmount } = render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    expect(screen.getByRole('heading', { name: 'Latest comment' })).toBeInTheDocument();
    expect(screen.getByText(`Yunid · ${commentTime(comment.created)}`)).toBeInTheDocument();
    expect(screen.getByText('Shipped the fix')).toBeInTheDocument();
    unmount();

    seed({ comments: [] });
    render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    expect(screen.queryByRole('heading', { name: 'Latest comment' })).not.toBeInTheDocument();
  });

  it('opens the ticket on Work', async () => {
    seed();
    render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    await userEvent.click(screen.getByRole('button', { name: 'Open the ticket' }));

    expect(useUiStore.getState().workTicket).toBe('HIVE-193');
    expect(useUiStore.getState().place).toBe('work');
  });

  it('says Jira is not connected when nothing is read and Jira is unconfigured', () => {
    useHiveStore.setState({ tickets: [], ticketSource: { kind: 'unconfigured' } });
    render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    expect(screen.getByText('Jira is not connected.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows a skeleton while nothing is read', () => {
    useHiveStore.setState({ tickets: [] });
    render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    expect(screen.getByRole('status', { name: 'Loading ticket' })).toBeInTheDocument();
  });

  it('keeps the data beside a problem, and retries', async () => {
    seed({ problems: { detail: 'Jira is down' }, readAt: Date.now() });
    render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    expect(screen.getByText('Jira is down')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Acceptance criteria 3' })).toBeInTheDocument();
    const before = readJiraDetail.mock.calls.length;

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(readJiraDetail.mock.calls.length).toBe(before + 1);
    expect(readJiraLinks).toHaveBeenLastCalledWith({ key: 'HIVE-193' });
  });

  it('reads on mount and again a minute later', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    readJiraDetail.mockResolvedValue(ok({ description: criteria, parent: null }));
    readJiraComments.mockResolvedValue(ok({ comments: [comment], total: 1 }));
    readJiraTransitions.mockResolvedValue(ok([]));
    readJiraLinks.mockResolvedValue(ok([]));
    render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    await screen.findByRole('heading', { name: 'Acceptance criteria 3' });
    expect(readJiraDetail).toHaveBeenCalledTimes(1);
    expect(readJiraDetail).toHaveBeenCalledWith({ key: 'HIVE-193' });
    expect(readJiraLinks).toHaveBeenCalledTimes(1);
    expect(readJiraLinks).toHaveBeenCalledWith({ key: 'HIVE-193' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(readJiraDetail).toHaveBeenCalledTimes(2);
    expect(readJiraLinks).toHaveBeenCalledTimes(2);
  });

  it('reads a key the map already holds once on mount', async () => {
    seed();
    render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    await waitFor(() => expect(readJiraDetail).toHaveBeenCalled());
    expect(readJiraDetail).toHaveBeenCalledTimes(1);
    expect(readJiraLinks).toHaveBeenCalledTimes(1);
  });
});

const link = (
  key: string,
  statusCategory: JiraStatusCategory,
  linkType: string,
  direction: 'inward' | 'outward',
): JiraLink => ({
  kind: 'issue',
  title: `${key} — t`,
  url: `https://x/browse/${key}`,
  relationship: 'r',
  status: 'S',
  key,
  summary: `${key} title`,
  statusCategory,
  linkType,
  direction,
});
const remote: JiraLink = { kind: 'remote', title: 'Doc', url: 'https://doc' };
const three = [
  link('HIVE-188', 'done', 'Blocks', 'inward'),
  link('HIVE-194', 'todo', 'Blocks', 'outward'),
  link('HIVE-179', 'done', 'Relates', 'outward'),
  remote,
];

describe('TicketTab links (HIVE-202)', () => {
  it('counts the linked tickets and says whether it is clear to go', () => {
    seed({ links: three });
    const { unmount } = render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    expect(screen.getByRole('heading', { name: 'Links 3' })).toBeInTheDocument();
    const lead = screen.getByText('Clear to go.');
    expect(lead.tagName).toBe('B');
    const clear = lead.closest('p')!;
    expect(clear).toHaveTextContent('Clear to go. Its one blocker is done; 1 ticket waits on it.');
    // Both tones sit in their soft box, with a leading icon (HIVE-229).
    expect(clear).toHaveClass('text-green', 'bg-green-soft');
    expect(clear.firstElementChild).toHaveAttribute('data-icon', 'check');
    unmount();

    seed({ links: [link('HIVE-188', 'todo', 'Blocks', 'inward')] });
    render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    const blocked = screen.getByText('Blocked by 1 open:').closest('p')!;
    expect(blocked).toHaveClass('text-amber-text', 'bg-amber-soft');
    expect(blocked.firstElementChild).toHaveAttribute('data-icon', 'x');
  });

  it('says there are no linked tickets, with no drawing, when only remote links exist', () => {
    seed({ links: [remote] });
    render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    expect(screen.getByRole('heading', { name: 'Links 0' })).toBeInTheDocument();
    expect(screen.getByText('No linked tickets')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /^Links of/ })).toBeNull();
  });

  it('draws a row per non-empty arc, each opening its list', async () => {
    seed({ links: three.slice(0, 2) });
    render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    const waits = screen.getByRole('button', { name: /^Waits on/ });
    expect(waits).toHaveTextContent('Waits on1✓1');
    const blocks = screen.getByRole('button', { name: /^Blocks/ });
    expect(blocks).toHaveTextContent('Blocks1◌1');
    expect(blocks).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /^Relates to/ })).not.toBeInTheDocument();

    await userEvent.click(blocks);

    expect(blocks).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'HIVE-194 HIVE-194 title S' }));
    expect(useUiStore.getState().workTicket).toBe('HIVE-194');

    await userEvent.click(blocks);
    expect(screen.queryByRole('button', { name: 'HIVE-194 HIVE-194 title S' })).not.toBeInTheDocument();
  });

  it('shows the relates row with its counts', () => {
    seed({ links: three });
    render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    expect(screen.getByRole('button', { name: /^Relates to/ })).toHaveTextContent('Relates to1✓1');
  });

  it('opens a constellation cell on Work', async () => {
    seed({ links: three });
    render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    await userEvent.click(screen.getByRole('button', { name: /^HIVE-188/ }));

    expect(useUiStore.getState().workTicket).toBe('HIVE-188');
  });

  it('opens the Waits-on list from the rest cell (D7)', async () => {
    const many = Array.from({ length: 7 }, (_, i) => link(`HIVE-1${String(i + 10)}`, 'todo', 'Blocks', 'inward'));
    seed({ links: many });
    render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    await userEvent.click(screen.getByRole('button', { name: '2 more' }));

    expect(screen.getByRole('button', { name: /^Waits on/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'HIVE-116 HIVE-116 title S' })).toBeInTheDocument();
  });

  it('shows a links problem with Retry in the section when no links were read', async () => {
    seed({ problems: { links: 'Links are down' } });
    render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    expect(screen.getByRole('heading', { name: 'Links' })).toBeInTheDocument();
    expect(screen.getByText('Links are down')).toBeInTheDocument();
    const before = readJiraLinks.mock.calls.length;

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(readJiraLinks.mock.calls.length).toBe(before + 1);
  });

  it('has no links section before the links are read', () => {
    seed();
    render(<TicketTab ticketKey="HIVE-193" sessionId="hero-refresh" />);

    expect(screen.queryByRole('heading', { name: /^Links/ })).not.toBeInTheDocument();
  });
});
