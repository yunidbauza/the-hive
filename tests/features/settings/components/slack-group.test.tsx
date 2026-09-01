import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SlackGroup } from '@features/settings/components/slack-group';

/**
 * The Slack provider group — variant B (HIVE-123).
 *
 * One status row, one caption line with a strict precedence (a failed Test,
 * else a failed sign-in, else the approval sentence, else the sign-in promise,
 * else the Used-by summary — never two at once), and an Advanced disclosure
 * that keeps the read-only server URL and client ID out of the resting view.
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

  it('names the agents using it, and says who actually holds the token', async () => {
    status.mockResolvedValue({ kind: 'connected' });
    render(<SlackGroup agents={[{ name: 'slack-watcher', tools: ['mcp__slack__*'] }]} />);

    expect(await screen.findByText('Signed in')).toBeInTheDocument();
    expect(screen.getByText(/slack-watcher/)).toBeInTheDocument();
    expect(
      screen.getByText(/token held by Claude Code, not the Hive/),
    ).toBeInTheDocument();
  });

  /**
   * The reassurance the approved design leads with, and the security claim the
   * whole story rests on. This is the only screen that states it.
   */
  it('promises the browser flow costs no stored token, before you start it', async () => {
    status.mockResolvedValue({ kind: 'not-added' });
    render(<SlackGroup agents={[]} />);

    expect(
      await screen.findByText('Opens your browser once. The Hive never sees the token.'),
    ).toBeInTheDocument();
    // The Used-by summary is the *fallback*, and must not pre-empt it.
    expect(screen.queryByText(/No agent names Slack yet/)).not.toBeInTheDocument();
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
    // A credential failure *is* the case where re-running the browser flow helps.
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
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

  /**
   * A failed Test is a failed **tool call**, not a failed credential. Letting it
   * overwrite the status turned "Signed in" into "Failed" and offered a browser
   * re-auth as the remedy for, say, a model turn that timed out.
   */
  it('keeps you signed in when the Test itself fails, and offers the Test again', async () => {
    status.mockResolvedValue({ kind: 'connected' });
    testSlack.mockResolvedValue({
      kind: 'error',
      message: 'claude did not answer in time. Try again.',
    });
    render(<SlackGroup agents={[]} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Test' }));

    expect(await screen.findByText(/did not answer in time/)).toBeInTheDocument();
    // The pill still reports the connection, which nothing has said is broken.
    expect(screen.getByText('Signed in')).toBeInTheDocument();
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
    // And the remedy on offer is the Test, not a browser round-trip.
    expect(screen.getByRole('button', { name: 'Test again' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Try again' }),
    ).not.toBeInTheDocument();
    expect(signIn).not.toHaveBeenCalled();
  });

  /** A probe that reports a real credential problem still moves the pill. */
  it('does move the pill when the Test reports the credential itself is the problem', async () => {
    status.mockResolvedValue({ kind: 'connected' });
    testSlack.mockResolvedValue({ kind: 'pending-approval' });
    render(<SlackGroup agents={[]} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Test' }));

    expect(await screen.findByText('Needs approval')).toBeInTheDocument();
    expect(screen.getByText(/workspace admin must approve/i)).toBeInTheDocument();
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

  /**
   * `signIn` waits on a 10-minute browser OAuth round-trip. With no in-flight
   * state a second click would run a second `claude mcp add` + `claude mcp
   * login` and contend for the single registered callback port 3118.
   */
  it('disables sign-in while one is already in flight, so a second click cannot fire a second one', async () => {
    status.mockResolvedValue({ kind: 'not-added' });
    let resolveSignIn: (result: { kind: string }) => void = () => {};
    signIn.mockReturnValue(
      new Promise((resolve) => {
        resolveSignIn = resolve;
      }),
    );
    render(<SlackGroup agents={[]} />);

    const button = await screen.findByRole('button', { name: 'Sign in to Slack' });
    await userEvent.click(button);

    const pending = await screen.findByRole('button', { name: 'Signing in…' });
    expect(pending).toBeDisabled();

    await userEvent.click(pending);
    expect(signIn).toHaveBeenCalledTimes(1);

    resolveSignIn({ kind: 'connected' });

    expect(await screen.findByRole('button', { name: 'Test' })).toBeInTheDocument();
  });
});
