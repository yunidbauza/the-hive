import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TicketConversation } from '@features/work/components/ticket-conversation';
import type { JiraComment, JiraLink } from '@shared/jira-contract';

/**
 * The conversation section (HIVE-71).
 *
 * Two things carry the story. It is **collapsed until asked for**, because the
 * WORK panel is a rail and a card that opened with forty comments in it would
 * push every other ticket off screen. And a link's **direction wording** is
 * rendered, because "blocks" and "is blocked by" are opposite facts and a row
 * showing only the key says one of them at random.
 */

const readJiraComments = vi.fn();
const readJiraLinks = vi.fn();
const addJiraComment = vi.fn();

vi.mock('@/lib/jira', () => ({
  readJiraComments: (request: unknown) => readJiraComments(request),
  readJiraLinks: (request: unknown) => readJiraLinks(request),
  addJiraComment: (request: unknown) => addJiraComment(request),
  readJiraStatus: () => Promise.resolve(null),
  searchJiraIssues: () => Promise.resolve(null),
  readJiraIssue: () => Promise.resolve(null),
  readJiraTransitions: () => Promise.resolve(null),
  applyJiraTransition: () => Promise.resolve(null),
  saveJiraToken: () => Promise.resolve(null),
  clearJiraToken: () => Promise.resolve(null),
  testJiraConnection: () => Promise.resolve(null),
}));

const comment = (over: Partial<JiraComment> = {}): JiraComment => ({
  id: '1',
  author: 'Yunid Bauza',
  created: '2026-08-07T00:41:13.497-0400',
  body: [{ kind: 'paragraph', runs: [{ text: 'Looks good.', marks: [] }] }],
  ...over,
});

const link = (over: Partial<JiraLink> = {}): JiraLink => ({
  kind: 'issue',
  title: 'HIVE-72 — A bug',
  url: 'https://behiques.atlassian.net/browse/HIVE-72',
  relationship: 'blocks',
  ...over,
});

const openIt = async (): Promise<ReturnType<typeof userEvent.setup>> => {
  const user = userEvent.setup();
  render(<TicketConversation issueKey="HIVE-71" />);
  await user.click(screen.getByRole('button', { name: /Conversation/ }));
  return user;
};

beforeEach(() => {
  vi.clearAllMocks();
  readJiraComments.mockResolvedValue({ ok: true, value: [comment()] });
  readJiraLinks.mockResolvedValue({ ok: true, value: [] });
  addJiraComment.mockResolvedValue({
    ok: true,
    value: comment({ id: '2', body: [{ kind: 'paragraph', runs: [{ text: 'Mine.', marks: [] }] }] }),
  });
});

describe('collapsed by default', () => {
  it('asks for nothing until it is opened', () => {
    render(<TicketConversation issueKey="HIVE-71" />);

    // A card that opened with forty comments would push every other ticket off
    // the rail.
    expect(readJiraComments).not.toHaveBeenCalled();
    expect(readJiraLinks).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Conversation/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('reads both halves when opened', async () => {
    await openIt();

    expect(readJiraComments).toHaveBeenCalledWith({ key: 'HIVE-71' });
    expect(readJiraLinks).toHaveBeenCalledWith({ key: 'HIVE-71' });
  });

  it('collapses again without a second read', async () => {
    const user = await openIt();
    await screen.findByText('Looks good.');

    await user.click(screen.getByRole('button', { name: /Conversation/ }));

    expect(screen.queryByText('Looks good.')).not.toBeInTheDocument();
    expect(readJiraComments).toHaveBeenCalledTimes(1);
  });
});

describe('comments', () => {
  it('renders author, time and body', async () => {
    await openIt();

    expect(await screen.findByText('Looks good.')).toBeInTheDocument();
    expect(screen.getByText('Yunid Bauza')).toBeInTheDocument();
  });

  it('marks an edited comment, and only an edited one', async () => {
    readJiraComments.mockResolvedValue({
      ok: true,
      value: [comment(), comment({ id: '2', updated: '2026-08-08T09:00:00Z' })],
    });
    await openIt();

    // Two comments, so two authors — `findAll`, not `find`.
    expect(await screen.findAllByText('Yunid Bauza')).toHaveLength(2);
    expect(screen.getAllByText(/edited/)).toHaveLength(1);
  });

  it('says so when there are none', async () => {
    readJiraComments.mockResolvedValue({ ok: true, value: [] });
    await openIt();

    expect(await screen.findByText('No comments yet.')).toBeInTheDocument();
  });

  it('reports a failed read', async () => {
    readJiraComments.mockResolvedValue({
      ok: false,
      error: { kind: 'forbidden', message: 'Not permitted.' },
    });
    await openIt();

    expect(await screen.findByText('Not permitted.')).toBeInTheDocument();
  });

  it('distinguishes a broken channel', async () => {
    readJiraLinks.mockResolvedValue(null);
    await openIt();

    expect(
      await screen.findByText(/could not reach its own main process/i),
    ).toBeInTheDocument();
  });
});

describe('links', () => {
  it('renders the direction wording beside the link', async () => {
    readJiraLinks.mockResolvedValue({ ok: true, value: [link()] });
    await openIt();

    // Without this, "blocks" and "is blocked by" are the same row.
    expect(await screen.findByText('blocks')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /HIVE-72/ }),
    ).toHaveAttribute('href', 'https://behiques.atlassian.net/browse/HIVE-72');
  });

  it('renders a remote link without inventing a direction', async () => {
    readJiraLinks.mockResolvedValue({
      ok: true,
      value: [
        {
          kind: 'remote',
          title: 'The design doc',
          url: 'https://example.invalid/doc',
        },
      ],
    });
    await openIt();

    expect(
      await screen.findByRole('link', { name: 'The design doc' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('blocks')).not.toBeInTheDocument();
  });

  it('shows the linked issue’s status when Jira sent one', async () => {
    readJiraLinks.mockResolvedValue({
      ok: true,
      value: [link({ status: 'In Progress' })],
    });
    await openIt();

    expect(await screen.findByText('(In Progress)')).toBeInTheDocument();
  });
});

describe('adding a comment', () => {
  it('sends the markdown and clears the box', async () => {
    const user = await openIt();
    await screen.findByText('Looks good.');

    const box = screen.getByLabelText(/Add a comment/);
    await user.type(box, 'Ship it **now**');
    await user.click(screen.getByRole('button', { name: 'Comment' }));

    expect(addJiraComment).toHaveBeenCalledWith({
      key: 'HIVE-71',
      markdown: 'Ship it **now**',
    });
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('appends the created comment rather than re-reading the thread', async () => {
    const user = await openIt();
    await screen.findByText('Looks good.');

    await user.type(screen.getByLabelText(/Add a comment/), 'hi');
    await user.click(screen.getByRole('button', { name: 'Comment' }));

    expect(await screen.findByText('Mine.')).toBeInTheDocument();
    // The answer *is* the new comment; asking again would cost a request to
    // learn something already in hand.
    expect(readJiraComments).toHaveBeenCalledTimes(1);
  });

  it('refuses to post an empty box', async () => {
    await openIt();
    await screen.findByText('Looks good.');

    expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled();
    expect(addJiraComment).not.toHaveBeenCalled();
  });

  it('shows the message and every detail when the post is refused', async () => {
    addJiraComment.mockResolvedValue({
      ok: false,
      error: {
        kind: 'bad-query',
        message: 'That comment could not be turned into a valid document.',
        details: ['mark_exclusivity at content[0].content[0]: code is exclusive'],
      },
    });
    const user = await openIt();
    await screen.findByText('Looks good.');

    await user.type(screen.getByLabelText(/Add a comment/), 'hi');
    await user.click(screen.getByRole('button', { name: 'Comment' }));

    expect(
      await screen.findByText(/could not be turned into a valid document/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/mark_exclusivity at content\[0\]/),
    ).toBeInTheDocument();
  });

  it('keeps the draft when the post failed', async () => {
    addJiraComment.mockResolvedValue({
      ok: false,
      error: { kind: 'forbidden', message: 'Not permitted.' },
    });
    const user = await openIt();
    await screen.findByText('Looks good.');

    const box = screen.getByLabelText(/Add a comment/);
    await user.type(box, 'worth keeping');
    await user.click(screen.getByRole('button', { name: 'Comment' }));

    await screen.findByText('Not permitted.');
    // Losing what the user typed because Jira said no would be the second
    // failure in a row.
    expect(box).toHaveValue('worth keeping');
  });
});
