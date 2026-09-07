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
const readSlackSocketState = vi.fn();

vi.mock('@/lib/slack', () => ({
  SLACK_BRIDGE_ERROR: 'The app could not reach its own main process.',
  readSlackStatus: () => status(),
  signIn: () => signIn(),
  signOut: () => signOut(),
  testSlack: () => testSlack(),
  setSlackTokens: (request: unknown) => setSlackTokens(request),
  clearSlackTokens: () => clearSlackTokens(),
  setSlackConfig: (request: unknown) => setSlackConfig(request),
  testSlackSocket: () => testSlackSocket(),
  readSlackSocketState: () => readSlackSocketState(),
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
  /*
    The three writes answer with a `SlackWrite` (HIVE-124, fix-round-3): a
    refusal now carries main's own sentence rather than collapsing to `null`,
    because `assertCommanderId` and a missing keyring are both reachable by
    ordinary typing and neither is a broken IPC bridge.
  */
  setSlackConfig.mockResolvedValue({ ok: false, message: 'unused in this test' });
  setSlackTokens.mockResolvedValue({ ok: false, message: 'unused in this test' });
  clearSlackTokens.mockResolvedValue({ ok: false, message: 'unused in this test' });
  testSlackSocket.mockResolvedValue(null);
  readSlackSocketState.mockResolvedValue(null);
  configSnapshot = { slack: { socketMode: false, commanders: [] } };
});

/** Nothing stored — the default `slack:socket-state` answer for most tests. */
const NO_TOKENS: SlackTokensState = {
  hasAppToken: false,
  hasBotToken: false,
  encryptionAvailable: true,
};

/**
 * Renders `SlackGroup` with the connection status, the config snapshot's
 * `slack` block, and the `slack:socket-state` answer — token presence and the
 * last socket status — all pre-wired.
 *
 * `tokens` and `socket` go through the *real* read verb rather than a prop:
 * there is a channel for both now (HIVE-124 fix-round-2), and a test seam that
 * bypassed it would be the one thing not proving the pane can hydrate after a
 * restart.
 */
function renderGroup(options?: {
  agents?: SlackGroupAgent[];
  slack?: SlackConfig;
  tokens?: SlackTokensState;
  socket?: SlackSocketStatus;
  status?: SlackStatus;
}) {
  status.mockResolvedValue(options?.status ?? { kind: 'connected' });
  readSlackSocketState.mockResolvedValue({
    tokens: options?.tokens ?? NO_TOKENS,
    socket: options?.socket ?? { kind: 'off' },
  });
  configSnapshot = {
    slack: options?.slack ?? { socketMode: false, commanders: [] },
  };
  return render(<SlackGroup agents={options?.agents ?? []} />);
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

  /*
    `findBy`, not `getBy`, in these two alone: they assert on markup that is
    there from the first frame, so a synchronous read passes — and leaves the
    mount reads (`slack:status` and `slack:socket-state`) to settle after the
    test has returned, which React reports as a state update outside `act`.
    Awaiting once absorbs both.
  */
  it('reports the enabled feature on the collapsed line, so it is never invisible', async () => {
    renderGroup({ slack: { socketMode: true, commanders: [] } });
    expect(await screen.findByRole('button', { name: /advanced/i })).toHaveTextContent(
      'real-time events on',
    );
  });

  it('says nothing extra on the collapsed line when it is off', async () => {
    renderGroup({ slack: { socketMode: false, commanders: [] } });
    expect(
      await screen.findByRole('button', { name: /advanced/i }),
    ).not.toHaveTextContent('real-time events');
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
   *
   * Asserted against each field's **accessible description**, not against the
   * document. `getByText(/stored/i)` passed whichever field the word landed
   * beside, so swapping `appTokenHint` and `botTokenHint` between the two
   * inputs went undetected (fix-round-2).
   */
  it('says only the stored one is stored, when just one of the two tokens is', async () => {
    renderGroup({
      slack: { socketMode: true, commanders: [] },
      tokens: { hasAppToken: true, hasBotToken: false, encryptionAvailable: true },
    });
    await openAdvanced();

    const app = await screen.findByLabelText(/app-level token/i);
    const bot = screen.getByLabelText(/bot token/i);

    expect(app).toHaveValue('');
    expect(bot).toHaveValue('');
    // The word belongs to the field that actually has one behind it.
    expect(app).toHaveAccessibleDescription(/stored/i);
    expect(bot).not.toHaveAccessibleDescription(/stored/i);
    // And the shared note is for the both-stored case, which this is not.
    expect(screen.queryByText(/both tokens are already stored/i)).not.toBeInTheDocument();
  });

  /**
   * The mirror image, so the assertion above cannot pass by the fields being
   * swapped *and* the presence flags being read the wrong way round too.
   */
  it('says so on the bot field when the bot token is the stored one', async () => {
    renderGroup({
      slack: { socketMode: true, commanders: [] },
      tokens: { hasAppToken: false, hasBotToken: true, encryptionAvailable: true },
    });
    await openAdvanced();

    expect(await screen.findByLabelText(/bot token/i)).toHaveAccessibleDescription(
      /stored/i,
    );
    expect(screen.getByLabelText(/app-level token/i)).not.toHaveAccessibleDescription(
      /stored/i,
    );
  });

  /**
   * The scope the setup instructions did not ask for, said where the user is
   * pasting the token it belongs to. `conversations.list` asks for private
   * channels, and Slack fails the whole call with `missing_scope` without
   * `groups:read` — so a bot token granted only what §12 originally listed
   * opened no socket at all (fix-round-2, HIVE-124).
   */
  it('names groups:read on the bot-token field, which the code needs and the setup missed', async () => {
    renderGroup({ slack: { socketMode: true, commanders: [] } });
    await openAdvanced();

    expect(await screen.findByLabelText(/bot token/i)).toHaveAccessibleDescription(
      /groups:read/,
    );
  });

  /**
   * Hydration after a restart (fix-round-2, HIVE-124).
   *
   * Socket status is push-only, `send` buffers nothing and the bridge drops a
   * repeat of the last status — so a bridge that connected at boot has already
   * said everything it will say by the time Settings is opened. Without the
   * mount read, this drawer rendered a working socket as `off` with two empty
   * `xapp-…`/`xoxb-…` placeholders, and `unresolved` — which rides on the
   * `connected` push — was unreachable in the state a user actually opens it in.
   */
  it('hydrates a connected bridge on mount, without waiting for a push that already happened', async () => {
    renderGroup({
      slack: { socketMode: true, commanders: ['U1'] },
      tokens: { hasAppToken: true, hasBotToken: true, encryptionAvailable: true },
      socket: {
        kind: 'connected',
        workspace: 'behiques',
        bot: 'hive',
        unresolved: ['#no-such-channel'],
      },
    });
    await openAdvanced();

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText(/behiques/)).toBeInTheDocument();
    // The one place an unresolved wake.on name is ever reported.
    expect(screen.getByText(/#no-such-channel/)).toBeInTheDocument();
    // And both fields say a token is held, rather than inviting a fresh paste.
    expect(screen.getByLabelText(/app-level token/i)).toHaveAttribute(
      'placeholder',
      'Replace the stored token',
    );
    expect(screen.getByText(/both tokens are already stored/i)).toBeInTheDocument();
    // Never emitted here, so it cannot be a push that painted any of it.
    expect(emitSocketStatus).not.toBeNull();
  });

  /**
   * A push that arrives first wins: the read must not overwrite fresher news.
   *
   * Rendered directly rather than through {@link renderGroup}, because the
   * whole point is a `slack:socket-state` that has *not* answered yet — so the
   * two mocks `renderGroup` would set are set here instead, explicitly.
   * `vi.clearAllMocks()` clears calls but not implementations, so a test that
   * left `status` unset would inherit whichever value an earlier one happened
   * to leave behind and pass only in file order (fix-round-3).
   */
  it('keeps a status pushed before the mount read answered', async () => {
    status.mockResolvedValue({ kind: 'connected' });
    configSnapshot = { slack: { socketMode: true, commanders: [] } };

    let answer: (state: unknown) => void = () => {};
    readSlackSocketState.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    render(<SlackGroup agents={[]} />);

    await screen.findByRole('button', { name: /advanced/i });
    act(() => {
      emitSocketStatus?.({ kind: 'failed', message: 'invalid app token' });
    });

    await act(async () => {
      answer({ tokens: NO_TOKENS, socket: { kind: 'off' } });
    });

    await userEvent.click(screen.getByRole('button', { name: /advanced/i }));
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/invalid app token/)).toBeInTheDocument();
  });

  /**
   * The pill sits directly beneath a switch that is visibly on, so `● OFF`
   * read as the toggle not having taken — the symptom found by driving the
   * built app. In this position `off` can only mean "not connected", and when
   * a token is missing the pill says what to do next instead (fix-round-2).
   */
  it('says Needs tokens, not Off, beneath a switch that is on with nothing stored', async () => {
    renderGroup({ slack: { socketMode: true, commanders: [] } });
    await openAdvanced();

    expect(await screen.findByText('Needs tokens')).toBeInTheDocument();
    expect(screen.queryByText('Off')).not.toBeInTheDocument();
  });

  it('says Not connected once both tokens are stored and the socket is still down', async () => {
    renderGroup({
      slack: { socketMode: true, commanders: [] },
      tokens: { hasAppToken: true, hasBotToken: true, encryptionAvailable: true },
    });
    await openAdvanced();

    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(screen.queryByText('Off')).not.toBeInTheDocument();
  });

  /**
   * `bridgeError()`'s own rule ("reported as an error rather than left to
   * render nothing") applies to every write this drawer makes, not only the
   * ones that predate HIVE-124 — a toggle that never reaches main must not
   * look like a switch that silently declined to move (fix-round-1).
   */
  it('says so when Socket Mode cannot be saved, rather than moving silently', async () => {
    setSlackConfig.mockResolvedValue({
      ok: false,
      message: 'The app could not reach its own main process.',
    });
    renderGroup({ slack: { socketMode: false, commanders: [] } });
    await openAdvanced();

    await userEvent.click(screen.getByRole('switch', { name: /socket mode/i }));

    expect(
      await screen.findByText(/could not reach its own main process/i),
    ).toBeInTheDocument();
  });

  /* ------------------------------------------------- HIVE-124, fix-round-3 */

  /**
   * The only way to remove a stored token.
   *
   * `CH.slackClearTokens` existed end to end — contract, preload, handler,
   * `lib/slack.ts` wrapper — and nothing in `src/` called it, so turning Socket
   * Mode off left both tokens on disk and deleting `slack-tokens.bin` by hand
   * was the remedy. The control follows `jira-credential-group.tsx`'s.
   */
  it('offers a Clear control once a token is stored, and forgets both', async () => {
    clearSlackTokens.mockResolvedValue({
      ok: true,
      value: { hasAppToken: false, hasBotToken: false, encryptionAvailable: true },
    });
    renderGroup({
      slack: { socketMode: true, commanders: [] },
      tokens: { hasAppToken: true, hasBotToken: true, encryptionAvailable: true },
    });
    await openAdvanced();

    await userEvent.click(await screen.findByRole('button', { name: /clear tokens/i }));

    expect(clearSlackTokens).toHaveBeenCalledTimes(1);
    // The presence answer it returns is applied, so the hints stop saying Stored.
    expect(
      await screen.findByPlaceholderText('xapp-\u2026'),
    ).toBeInTheDocument();
  });

  it('does not offer a Clear control when there is nothing stored', async () => {
    renderGroup({ slack: { socketMode: true, commanders: [] } });
    await openAdvanced();

    expect(await screen.findByLabelText(/app-level token/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear tokens/i })).not.toBeInTheDocument();
  });

  /**
   * `encryptionAvailable` was plumbed all the way to this pane and never read.
   * `tokens.ts` throws rather than writing a token in plaintext, so the fields
   * accepted a paste, the save threw, and the pane blamed its own IPC bridge —
   * on a machine whose only actual problem is a missing keyring.
   */
  it('hides the token fields when the machine has no keyring, and says why', async () => {
    renderGroup({
      slack: { socketMode: true, commanders: [] },
      tokens: { hasAppToken: false, hasBotToken: false, encryptionAvailable: false },
    });
    await openAdvanced();

    expect(await screen.findByText(/has no keyring/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/app-level token/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/bot token/i)).not.toBeInTheDocument();
  });

  /**
   * `U08BA712189 U0123ABCD` is what pasting two ids out of Slack looks like.
   * Split on `,` alone it became one entry with a space in it,
   * `assertCommanderId` refused the **whole** write, and the pane reported a
   * broken main process for a stray space in a text field.
   */
  it('accepts ids separated by spaces as well as commas', async () => {
    setSlackConfig.mockResolvedValue({ ok: true, value: { slack: {} } });
    renderGroup({ slack: { socketMode: true, commanders: [] } });
    await openAdvanced();

    const field = await screen.findByLabelText(/allowed to command/i);
    await userEvent.type(field, 'U08BA712189 U0123ABCD');
    await userEvent.tab();

    expect(setSlackConfig).toHaveBeenCalledWith({
      socketMode: true,
      commanders: ['U08BA712189', 'U0123ABCD'],
    });
  });

  /** And the refusal, when it comes, is main's sentence rather than the pane's. */
  it('reports the guard’s own words rather than blaming the main process', async () => {
    setSlackConfig.mockResolvedValue({
      ok: false,
      message: 'setSlack.commanders[0]: must not contain whitespace',
    });
    renderGroup({ slack: { socketMode: true, commanders: [] } });
    await openAdvanced();

    const field = await screen.findByLabelText(/allowed to command/i);
    await userEvent.type(field, 'U08BA712189');
    await userEvent.tab();

    expect(await screen.findByText(/must not contain whitespace/)).toBeInTheDocument();
    expect(
      screen.queryByText(/could not reach its own main process/i),
    ).not.toBeInTheDocument();
  });

  /**
   * The draft was compared by array **identity**, and every config parse builds
   * a fresh `commanders` array — so any unrelated write, a switch one field
   * away included, silently threw away what the user was half-way through
   * typing. Compared on the joined string now, as `container-alias-group.tsx`
   * compares its own (a `string` prop, which is why copying its shape without
   * its type was the bug).
   */
  it('keeps a half-typed allow-list when an unrelated config write lands', async () => {
    renderGroup({ slack: { socketMode: true, commanders: ['U08BA712189'] } });
    await openAdvanced();

    const field = await screen.findByLabelText(/allowed to command/i);
    await userEvent.type(field, ', U0123ABCD');
    expect(field).toHaveValue('U08BA712189, U0123ABCD');

    /* A fresh parse of the *same* saved value: new array, identical contents. */
    act(() => {
      configSnapshot = { slack: { socketMode: true, commanders: ['U08BA712189'] } };
      emitSocketStatus?.({ kind: 'connecting' });
    });

    expect(screen.getByLabelText(/allowed to command/i)).toHaveValue(
      'U08BA712189, U0123ABCD',
    );
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
