import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SlackConfig } from '@shared/config-contract';
import type { SlackSocketStatus, SlackStatus, SlackTokensState } from '@shared/slack-contract';

import {
  SlackGroup,
  type SlackGroupAgent,
} from '@features/settings/components/slack-group';

/**
 * The Slack provider group — variant B (HIVE-123), plus the real-time events
 * sub-group it left a seam for (HIVE-124).
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
const setSlackTokens = vi.fn();
const clearSlackTokens = vi.fn();
const setSlackConfig = vi.fn();
const testSlackSocket = vi.fn();
const subscribeSlackSocketStatus = vi.fn();

vi.mock('@/lib/slack', () => ({
  readSlackStatus: () => status(),
  signIn: () => signIn(),
  signOut: () => signOut(),
  testSlack: () => testSlack(),
  setSlackTokens: (request: unknown) => setSlackTokens(request),
  clearSlackTokens: () => clearSlackTokens(),
  setSlackConfig: (request: unknown) => setSlackConfig(request),
  testSlackSocket: () => testSlackSocket(),
  subscribeSlackSocketStatus: (callback: (next: SlackSocketStatus) => void) =>
    subscribeSlackSocketStatus(callback),
}));

/** The snapshot `useProjectConfig()` answers with — only `.slack` matters here. */
let configSnapshot: { slack: SlackConfig } = {
  slack: { socketMode: false, commanders: [] },
};

vi.mock('@hooks/use-project-config', () => ({
  useProjectConfig: () => configSnapshot,
}));

/** The subscriber `SlackGroup` registered, so a test can push a socket status. */
let emitSocketStatus: ((next: SlackSocketStatus) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  emitSocketStatus = null;
  subscribeSlackSocketStatus.mockImplementation((callback: (next: SlackSocketStatus) => void) => {
    emitSocketStatus = callback;
    return () => {
      emitSocketStatus = null;
    };
  });
  setSlackConfig.mockResolvedValue(null);
  setSlackTokens.mockResolvedValue(null);
  clearSlackTokens.mockResolvedValue(null);
  testSlackSocket.mockResolvedValue(null);
  configSnapshot = { slack: { socketMode: false, commanders: [] } };
});

/**
 * Renders `SlackGroup` with the connection status, the config snapshot's
 * `slack` block, and (test-only — production has no channel to read it back)
 * the stored-token presence, all pre-wired.
 */
function renderGroup(options?: {
  agents?: SlackGroupAgent[];
  slack?: SlackConfig;
  tokens?: SlackTokensState;
  status?: SlackStatus;
}) {
  status.mockResolvedValue(options?.status ?? { kind: 'connected' });
  configSnapshot = {
    slack: options?.slack ?? { socketMode: false, commanders: [] },
  };
  return render(
    <SlackGroup agents={options?.agents ?? []} tokens={options?.tokens} />,
  );
}

/** Opens the `Advanced` disclosure and waits for it to render. */
async function openAdvanced() {
  await userEvent.click(await screen.findByRole('button', { name: /advanced/i }));
}

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

describe('real-time events (HIVE-124)', () => {
  it('shows the switch and the prerequisites, and no token fields, when off', async () => {
    renderGroup({ slack: { socketMode: false, commanders: [] } });
    await openAdvanced();

    expect(screen.getByText('Real-time events')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /socket mode/i })).not.toBeChecked();
    expect(screen.getByText(/needs a slack app of your own/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/app-level token/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/bot token/i)).not.toBeInTheDocument();
  });

  it('shows the fields, the commanders box and Test once it is on', async () => {
    renderGroup({ slack: { socketMode: true, commanders: ['U08BA712189'] } });
    await openAdvanced();

    expect(screen.getByLabelText(/app-level token/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/bot token/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/allowed to command/i)).toHaveValue('U08BA712189');
  });

  it('reports the enabled feature on the collapsed line, so it is never invisible', () => {
    renderGroup({ slack: { socketMode: true, commanders: [] } });
    expect(screen.getByRole('button', { name: /advanced/i })).toHaveTextContent(
      'real-time events on',
    );
  });

  it('says nothing extra on the collapsed line when it is off', () => {
    renderGroup({ slack: { socketMode: false, commanders: [] } });
    expect(screen.getByRole('button', { name: /advanced/i })).not.toHaveTextContent(
      'real-time events',
    );
  });

  /**
   * Scoped to the drawer itself (`data-testid="advanced-drawer"`), not the
   * whole document. The pre-existing top-level caption also says "token held
   * by Claude Code" for any connected status, whether or not `Advanced` is
   * even open — an unscoped query would pass on that markup alone and never
   * exercise a word this drawer's own copy wrote (fix-round-1, HIVE-124).
   */
  it('names the two custodies apart', async () => {
    renderGroup({ slack: { socketMode: true, commanders: ['U1'] } });
    await openAdvanced();

    const drawer = within(screen.getByTestId('advanced-drawer'));
    expect(drawer.getByText(/held by claude code/i)).toBeInTheDocument();
    expect(drawer.getByText(/encrypted on this machine/i)).toBeInTheDocument();
  });

  it('tells the user nobody can command yet when the list is empty', async () => {
    renderGroup({ slack: { socketMode: true, commanders: [] } });
    await openAdvanced();
    expect(screen.getByText(/nobody yet/i)).toBeInTheDocument();
  });

  it('never reads a stored token back into a field', async () => {
    renderGroup({
      slack: { socketMode: true, commanders: [] },
      tokens: { hasAppToken: true, hasBotToken: true, encryptionAvailable: true },
    });
    await openAdvanced();
    expect(screen.getByLabelText(/app-level token/i)).toHaveValue('');
    expect(screen.getByLabelText(/bot token/i)).toHaveValue('');
    expect(screen.getByText(/stored/i)).toBeInTheDocument();
  });

  /**
   * The asymmetric case: only one of the two tokens is stored. Distinct from
   * the both-true case above, which collapses the per-field "Stored." into
   * one shared line instead — this proves that collapse does not also fire
   * when only one is actually stored (fix-round-1, HIVE-124).
   */
  it('says only the stored one is stored, when just one of the two tokens is', async () => {
    renderGroup({
      slack: { socketMode: true, commanders: [] },
      tokens: { hasAppToken: true, hasBotToken: false, encryptionAvailable: true },
    });
    await openAdvanced();

    expect(screen.getByLabelText(/app-level token/i)).toHaveValue('');
    expect(screen.getByLabelText(/bot token/i)).toHaveValue('');
    expect(screen.getByText(/stored/i)).toBeInTheDocument();
  });

  /**
   * `bridgeError()`'s own rule ("reported as an error rather than left to
   * render nothing") applies to every write this drawer makes, not only the
   * ones that predate HIVE-124 — a toggle that never reaches main must not
   * look like a switch that silently declined to move (fix-round-1).
   */
  it('says so when Socket Mode cannot be saved, rather than moving silently', async () => {
    setSlackConfig.mockResolvedValue(null);
    renderGroup({ slack: { socketMode: false, commanders: [] } });
    await openAdvanced();

    await userEvent.click(screen.getByRole('switch', { name: /socket mode/i }));

    expect(
      await screen.findByText(/could not reach its own main process/i),
    ).toBeInTheDocument();
  });

  /**
   * The allow-list defaults to empty and a resolved channel is the only
   * happy path this component can otherwise show — so a name from `wake.on`
   * that Slack could not resolve to a channel id has exactly one place to
   * surface, and it must not be dropped in silence.
   */
  it('reports an unresolved wake.on channel name rather than dropping it', async () => {
    renderGroup({ slack: { socketMode: true, commanders: [] } });
    await openAdvanced();

    act(() => {
      emitSocketStatus?.({
        kind: 'connected',
        workspace: 'behiques',
        bot: 'hive',
        unresolved: ['#no-such-channel'],
      });
    });

    expect(await screen.findByText(/#no-such-channel/)).toBeInTheDocument();
  });
});
