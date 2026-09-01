import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SlackGroup } from '@features/settings/components/slack-group';

/**
 * The Slack provider group — variant B (HIVE-123).
 *
 * One status row, one caption line with a strict precedence (an error, else
 * the approval sentence, else the Used-by summary — never two at once), and
 * an Advanced disclosure that keeps the read-only server URL and client ID
 * out of the resting view.
 */

const status = vi.fn();
const signIn = vi.fn();
const signOut = vi.fn();
const testSlack = vi.fn();

vi.mock('@/lib/slack', () => ({
  readSlackStatus: () => status(),
  signIn: () => signIn(),
  signOut: () => signOut(),
  testSlack: () => testSlack(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SlackGroup', () => {
  it('offers sign-in when the server has never been added', async () => {
    status.mockResolvedValue({ kind: 'not-added' });
    render(<SlackGroup agents={[]} />);

    expect(await screen.findByText('Not signed in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in to Slack' })).toBeInTheDocument();
  });

  it('shows who you are, and the caption names the agents using it', async () => {
    status.mockResolvedValue({
      kind: 'connected',
      connection: { user: '@yunid', workspace: 'behiques.slack.com' },
    });
    render(<SlackGroup agents={[{ name: 'slack-watcher', tools: ['mcp__slack__*'] }]} />);

    expect(await screen.findByText('Signed in')).toBeInTheDocument();
    expect(screen.getByText(/@yunid/)).toBeInTheDocument();
    expect(screen.getByText(/slack-watcher/)).toBeInTheDocument();
  });

  it('warns about an agent that names slack but grants no slack tool', async () => {
    status.mockResolvedValue({ kind: 'connected' });
    render(<SlackGroup agents={[{ name: 'hydralisk', tools: ['Read'] }]} />);

    expect(await screen.findByText(/no slack tools granted/)).toBeInTheDocument();
  });

  it('puts the approval state in the caption, not in a new block', async () => {
    status.mockResolvedValue({ kind: 'pending-approval' });
    render(<SlackGroup agents={[]} />);

    expect(await screen.findByText('Needs approval')).toBeInTheDocument();
    expect(screen.getByText(/workspace admin must approve/i)).toBeInTheDocument();
  });

  it('reports a failed sign-in with the reason, and stays signed out', async () => {
    status.mockResolvedValue({ kind: 'not-added' });
    signIn.mockResolvedValue({ kind: 'error', message: 'callback port 3118 is in use' });
    render(<SlackGroup agents={[]} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Slack' }));

    expect(await screen.findByText(/callback port 3118 is in use/)).toBeInTheDocument();
    expect(await screen.findByText('Failed')).toBeInTheDocument();
  });

  it('keeps the server url and client id behind Advanced', async () => {
    status.mockResolvedValue({ kind: 'connected' });
    render(<SlackGroup agents={[]} />);

    await screen.findByText('Signed in');
    expect(screen.queryByText('https://mcp.slack.com/mcp')).not.toBeInTheDocument();

    const disclosure = screen.getByRole('button', { name: /Advanced/ });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(disclosure);

    expect(screen.getByText('https://mcp.slack.com/mcp')).toBeInTheDocument();
    expect(screen.getByText('1601185624273.8899143856786')).toBeInTheDocument();
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  });

  it('never spends a model turn on mount — no automatic test call', async () => {
    status.mockResolvedValue({ kind: 'connected' });
    render(<SlackGroup agents={[]} />);

    await screen.findByText('Signed in');

    expect(testSlack).not.toHaveBeenCalled();
  });

  it('offers sign-in for an agent whose credential has expired', async () => {
    status.mockResolvedValue({ kind: 'needs-auth' });
    render(<SlackGroup agents={[]} />);

    expect(await screen.findByText('Not signed in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in to Slack' })).toBeInTheDocument();
  });
});
