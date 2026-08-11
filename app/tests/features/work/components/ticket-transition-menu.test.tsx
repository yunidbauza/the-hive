import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TicketTransitionMenu } from '@features/work/components/ticket-transition-menu';
import { useHiveStore } from '@stores/hive-store';
import type { JiraIssue, JiraTransition } from '@shared/jira-contract';

/**
 * The transition control (HIVE-70).
 *
 * Two properties carry the story: the list is read **on open, per issue** —
 * never on render and never cached across issues, because transition ids are
 * per-workflow — and every failure mode reads differently, because "you cannot
 * do this" and "you did not say what resolution" need different actions from
 * the user.
 */

const readJiraTransitions = vi.fn();
const applyJiraTransition = vi.fn();

vi.mock('@/lib/jira', () => ({
  readJiraTransitions: (request: unknown) => readJiraTransitions(request),
  applyJiraTransition: (request: unknown) => applyJiraTransition(request),
  readJiraStatus: () => Promise.resolve(null),
  searchJiraIssues: () => Promise.resolve(null),
  readJiraIssue: () => Promise.resolve(null),
  saveJiraToken: () => Promise.resolve(null),
  clearJiraToken: () => Promise.resolve(null),
  testJiraConnection: () => Promise.resolve(null),
}));

const transition = (over: Partial<JiraTransition> = {}): JiraTransition => ({
  id: '31',
  name: 'Start progress',
  to: { name: 'In Progress', statusCategory: 'in-progress' },
  ...over,
});

const movedIssue: JiraIssue = {
  key: 'HIVE-70',
  summary: 'Transitions from the ticket card',
  status: 'Done',
  statusCategory: 'done',
  issueType: 'Story',
  priority: null,
  assignee: null,
  updated: '2026-08-07T00:00:00.000-0400',
  url: 'https://behiques.atlassian.net/browse/HIVE-70',
};

const open = async (): Promise<ReturnType<typeof userEvent.setup>> => {
  const user = userEvent.setup();
  render(<TicketTransitionMenu issueKey="HIVE-70" status="In Progress" statusCategory="in-progress" />);
  await user.click(screen.getByRole('button', { name: 'In Progress — move HIVE-70' }));
  return user;
};

beforeEach(() => {
  vi.clearAllMocks();
  useHiveStore.getState().reset();
  readJiraTransitions.mockResolvedValue({
    ok: true,
    value: [transition(), transition({ id: '41', name: 'Done', to: { name: 'Done', statusCategory: 'done' } })],
  });
  applyJiraTransition.mockResolvedValue({ ok: true, value: movedIssue });
});

describe('reading the list', () => {
  it('asks for nothing until the menu is opened', () => {
    render(<TicketTransitionMenu issueKey="HIVE-70" status="In Progress" statusCategory="in-progress" />);

    // On render this would be one request per card, every time the panel opens.
    expect(readJiraTransitions).not.toHaveBeenCalled();
  });

  it('reads for this issue when opened', async () => {
    await open();

    expect(readJiraTransitions).toHaveBeenCalledWith({ key: 'HIVE-70' });
  });

  it('offers exactly what Jira reported, with the destination', async () => {
    await open();

    expect(
      await screen.findByRole('menuitem', { name: /Start progress/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Done/ })).toBeInTheDocument();
    // A transition name is a verb; the destination is what the user is choosing.
    expect(screen.getByText('→ In Progress')).toBeInTheDocument();
  });

  it('says so when the workflow offers nothing from here', async () => {
    readJiraTransitions.mockResolvedValue({ ok: true, value: [] });
    await open();

    expect(
      await screen.findByText(/offers nothing from here/i),
    ).toBeInTheDocument();
  });

  it('reports a failed read', async () => {
    readJiraTransitions.mockResolvedValue({
      ok: false,
      error: { kind: 'offline', message: 'Could not reach Jira.' },
    });
    await open();

    expect(await screen.findByText('Could not reach Jira.')).toBeInTheDocument();
  });

  it('distinguishes a broken channel', async () => {
    readJiraTransitions.mockResolvedValue(null);
    await open();

    expect(
      await screen.findByText(/could not reach its own main process/i),
    ).toBeInTheDocument();
  });
});

describe('applying one', () => {
  it('sends the id Jira gave for this issue', async () => {
    const user = await open();

    await user.click(
      await screen.findByRole('menuitem', { name: /Start progress/ }),
    );

    expect(applyJiraTransition).toHaveBeenCalledWith({
      key: 'HIVE-70',
      transitionId: '31',
    });
  });

  it('installs the re-read issue rather than an optimistic guess', async () => {
    useHiveStore.getState().hydrateTickets(
      [{ ...movedIssue, status: 'To Do', statusCategory: 'todo' }],
      false,
    );
    const user = await open();

    await user.click(
      await screen.findByRole('menuitem', { name: /Start progress/ }),
    );

    await waitFor(() => {
      expect(useHiveStore.getState().tickets[0]?.status).toBe('Done');
    });
    expect(useHiveStore.getState().tickets[0]?.statusCategory).toBe('done');
  });
});

describe('failing to apply', () => {
  it('names the field Jira asked for, and does not guess it', async () => {
    applyJiraTransition.mockResolvedValue({
      ok: false,
      error: {
        kind: 'bad-query',
        message: 'Jira could not understand the request.',
        details: ["resolution: Field 'resolution' is required"],
      },
    });
    const user = await open();

    await user.click(
      await screen.findByRole('menuitem', { name: /Start progress/ }),
    );

    expect(
      await screen.findByText("resolution: Field 'resolution' is required"),
    ).toBeInTheDocument();
  });

  it('reads a 403 as a permission problem, not a validation failure', async () => {
    applyJiraTransition.mockResolvedValue({
      ok: false,
      error: { kind: 'forbidden', message: 'Authenticated but not permitted.' },
    });
    const user = await open();

    await user.click(
      await screen.findByRole('menuitem', { name: /Start progress/ }),
    );

    expect(
      await screen.findByText(/do not have permission/i),
    ).toBeInTheDocument();
  });

  it('says the issue moved, and re-reads the list', async () => {
    applyJiraTransition.mockResolvedValue({
      ok: false,
      error: {
        kind: 'stale',
        message: 'This issue has moved since its transitions were read.',
      },
    });
    const user = await open();

    await user.click(
      await screen.findByRole('menuitem', { name: /Start progress/ }),
    );

    expect(await screen.findByText(/has moved/i)).toBeInTheDocument();
    // Once on open, once because what the menu held is now known to be wrong.
    await waitFor(() => {
      expect(readJiraTransitions).toHaveBeenCalledTimes(2);
    });
  });

  it('does not re-read on an ordinary failure', async () => {
    applyJiraTransition.mockResolvedValue({
      ok: false,
      error: { kind: 'forbidden', message: 'nope' },
    });
    const user = await open();

    await user.click(
      await screen.findByRole('menuitem', { name: /Start progress/ }),
    );

    await screen.findByText(/do not have permission/i);
    expect(readJiraTransitions).toHaveBeenCalledTimes(1);
  });

  it('leaves the ticket untouched when the move failed', async () => {
    useHiveStore.getState().hydrateTickets(
      [{ ...movedIssue, status: 'To Do', statusCategory: 'todo' }],
      false,
    );
    applyJiraTransition.mockResolvedValue({
      ok: false,
      error: { kind: 'forbidden', message: 'nope' },
    });
    const user = await open();

    await user.click(
      await screen.findByRole('menuitem', { name: /Start progress/ }),
    );

    await screen.findByText(/do not have permission/i);
    expect(useHiveStore.getState().tickets[0]?.status).toBe('To Do');
  });
});
