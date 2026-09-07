import { CaretRight } from '@phosphor-icons/react';
import { useEffect, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Button } from '@components/ui/button';
import { SecretField } from '@components/ui/secret-field';
import { Switch } from '@components/ui/switch';
import { TextField } from '@components/ui/text-field';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { useProjectConfig } from '@hooks/use-project-config';
import { installProjectConfig } from '@lib/project-config';
import {
  readSlackStatus,
  setSlackConfig,
  setSlackTokens,
  signIn,
  signOut,
  subscribeSlackSocketStatus,
  testSlack,
  testSlackSocket,
} from '@lib/slack';
import { DEFAULT_SLACK, type SlackConfig } from '@shared/config-contract';
import { grantsSlackTools, SLACK_CLIENT_ID, SLACK_MCP_URL } from '@shared/slack-contract';
import type {
  SlackSocketStatus,
  SlackSocketTestResult,
  SlackStatus,
  SlackTokensState,
} from '@shared/slack-contract';

/**
 * The Slack provider group — variant B, the chosen design (HIVE-123).
 *
 * https://claude.ai/code/artifact/efe48323-a347-4744-8c00-026f8ff086b8
 *
 * One `SettingsGroup`, not three: a status row (state pill · actions), a
 * hairline, then one caption line and an `Advanced` disclosure. The two
 * alternatives considered — mirroring Jira's three nested groups, and a
 * connection card — both cost roughly three times the height to say one
 * sentence; this is the smallest shape that still answers "am I signed in,
 * and what is using it".
 *
 * ## The caption does double duty
 *
 * It is one slot with a strict precedence — a failed Test, else a failed
 * sign-in, else the approval sentence, else the sign-in promise, else the
 * Used-by summary — and never two at once. That is what lets every state fit
 * without a second block: {@link Caption} is the one place that decision gets
 * made.
 *
 * ## A failed Test is not a failed connection
 *
 * The two errors this pane can show come from different places and want
 * different answers. An error from `status` or `signIn` means the *credential*
 * is the problem, and "Try again" (which re-runs the browser flow) is the
 * remedy. An error from `test` is a failed **tool call** on a connection that
 * may be perfectly healthy — a model turn that timed out, a run that could not
 * start. Folding it into `status` replaced "Signed in" with "Failed" and then
 * pushed the user through a browser re-auth they did not need. So a Test
 * failure is held separately: the pill keeps reporting the connection, the
 * caption reports the Test, and the button offers the Test again.
 *
 * ## Only two fields off `AgentSummary`
 *
 * `agents` is typed narrower than the full summary on purpose — `name` and
 * `tools` are the only two facts this group reads (the Used-by line and
 * {@link grantsSlackTools}'s hint). `AgentSummary` is structurally a superset,
 * so `integrations-section.tsx` passes it straight through.
 */

export interface SlackGroupAgent {
  name: string;
  tools: string[];
}

interface SlackGroupProps {
  agents: SlackGroupAgent[];
  /**
   * Test-only seam for the two Hive-owned tokens' presence (HIVE-124).
   *
   * Unlike every other fact this pane shows, there is no channel that reads
   * it back — `slack:set-tokens` and `slack:clear-tokens` answer with
   * presence, but nothing answers on mount. Production always starts from
   * {@link UNKNOWN_TOKENS} and only learns better once the pane itself sets
   * or clears one; a test supplies this to exercise the "already stored"
   * rendering without going through a save first.
   */
  tokens?: SlackTokensState;
}

/** Nothing known yet — the only honest starting point with no read channel. */
const UNKNOWN_TOKENS: SlackTokensState = {
  hasAppToken: false,
  hasBotToken: false,
  encryptionAvailable: true,
};

/**
 * `readSlackStatus`/`signIn`/`signOut`/`testSlack` all return `null` on a
 * broken bridge (`src/lib/slack.ts`) — reported as an error rather than left
 * to render nothing, the same choice `JiraCredentialGroup` makes for a failed
 * Jira verb.
 */
const bridgeError = (): SlackStatus => ({
  kind: 'error',
  message: 'The app could not reach its own main process.',
});

type PillKind = 'off' | 'ok' | 'wait' | 'err';

const PILL_LABEL: Record<PillKind, string> = {
  off: 'Not signed in',
  ok: 'Signed in',
  wait: 'Needs approval',
  err: 'Failed',
};

const PILL_TONE: Record<PillKind, string> = {
  off: 'text-subtle border-border',
  ok: 'text-green border-green',
  wait: 'text-amber border-amber',
  err: 'text-red border-red',
};

/** `not-added` and `needs-auth` read identically — both are "sign in again". */
function pillKindOf(status: SlackStatus): PillKind {
  switch (status.kind) {
    case 'connected':
      return 'ok';
    case 'pending-approval':
      return 'wait';
    case 'error':
      return 'err';
    case 'not-added':
    case 'needs-auth':
      return 'off';
  }
}

/** `label` overrides {@link PILL_LABEL} — the socket pill reports different states. */
function StatePill({ kind, label }: { kind: PillKind; label?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-wide',
        PILL_TONE[kind],
      )}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {label ?? PILL_LABEL[kind]}
    </span>
  );
}

/** The socket's own four states, read onto the same pill the connection uses. */
const SOCKET_PILL: Record<SlackSocketStatus['kind'], { kind: PillKind; label: string }> = {
  off: { kind: 'off', label: 'Off' },
  connecting: { kind: 'wait', label: 'Connecting…' },
  connected: { kind: 'ok', label: 'Connected' },
  failed: { kind: 'err', label: 'Failed' },
};

/**
 * The promise the sign-in makes, on the one screen that offers it.
 *
 * That no Slack credential is ever stored by this app is the security claim the
 * whole story rests on — `claude mcp login` holds the token, in Claude Code's
 * own credential store. This caption and the one below it are the only place
 * the product says so.
 */
const SIGN_IN_PROMISE = 'Opens your browser once. The Hive never sees the token.';

/** The same claim, restated where it matters most: while you are signed in. */
const TOKEN_HOLDER = ' · token held by Claude Code, not the Hive';

/** Who is using it — the fallback slot when there is no error and no approval to report. */
function usedBySummary(agents: SlackGroupAgent[]): ReactNode {
  if (agents.length === 0) {
    return 'No agent names Slack yet.';
  }

  const missingGrant = agents.some((agent) => !grantsSlackTools(agent.tools));

  return (
    <>
      Used by{' '}
      {agents.map((agent, index) => (
        <span key={agent.name} className="font-mono text-ink">
          {agent.name}
          {index < agents.length - 1 ? ', ' : ''}
        </span>
      ))}
      {missingGrant && <span className="text-amber"> · no slack tools granted</span>}
    </>
  );
}

/**
 * The caption's precedence, in one place: an error, else the approval
 * sentence, else Used-by. Never two of them at once (the design's own
 * answer to "where does admin-approval go, and where does a failure go").
 */
function Caption({
  status,
  agents,
  testError,
}: {
  status: SlackStatus;
  agents: SlackGroupAgent[];
  testError: string | null;
}) {
  if (testError !== null) {
    return (
      <p className="text-[11.5px] text-red">
        <span className="font-semibold text-ink">Test failed.</span> {testError}
      </p>
    );
  }

  if (status.kind === 'error') {
    return <p className="text-[11.5px] text-red">{status.message}</p>;
  }

  if (status.kind === 'pending-approval') {
    return (
      <p className="text-[11.5px] text-amber">
        <span className="font-semibold text-ink">
          A workspace admin must approve Slack&rsquo;s MCP server.
        </span>{' '}
        Wakes skip until then.
      </p>
    );
  }

  if (status.kind === 'not-added' || status.kind === 'needs-auth') {
    return <p className="text-[11.5px] text-subtle">{SIGN_IN_PROMISE}</p>;
  }

  return (
    <p className="text-[11.5px] text-subtle">
      {usedBySummary(agents)}
      {TOKEN_HOLDER}
    </p>
  );
}

/** `Test` until one has failed, `Test again` after — the retry it actually needs. */
function testLabel(testing: boolean, failed: boolean): string {
  if (testing) return 'Testing…';

  return failed ? 'Test again' : 'Test';
}

/**
 * `Sign in to Slack`/`Try again` until one is in flight, `Signing in…` while
 * it waits on the browser round-trip — the same idiom as {@link testLabel},
 * because the failure this button needs to survive is a second click, not a
 * second label.
 */
function signInLabel(signingIn: boolean, failed: boolean): string {
  if (signingIn) return 'Signing in…';

  return failed ? 'Try again' : 'Sign in to Slack';
}

function Actions({
  status,
  testing,
  testFailed,
  signingIn,
  onSignIn,
  onSignOut,
  onTest,
}: {
  status: SlackStatus;
  testing: boolean;
  testFailed: boolean;
  signingIn: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  onTest: () => void;
}) {
  switch (status.kind) {
    case 'not-added':
    case 'needs-auth':
      return (
        <Button variant="primary" onClick={onSignIn} disabled={signingIn}>
          {signInLabel(signingIn, false)}
        </Button>
      );
    case 'connected':
      return (
        <>
          <Button onClick={onTest} disabled={testing}>
            {testLabel(testing, testFailed)}
          </Button>
          <Button variant="danger" onClick={onSignOut}>
            Sign out
          </Button>
        </>
      );
    case 'pending-approval':
      return (
        <Button onClick={onTest} disabled={testing}>
          {testLabel(testing, true)}
        </Button>
      );
    case 'error':
      return (
        <Button variant="primary" onClick={onSignIn} disabled={signingIn}>
          {signInLabel(signingIn, true)}
        </Button>
      );
  }
}

/**
 * The one line of prose that answers "who holds which credential", stated
 * where it matters most — beside the two fields it distinguishes from the
 * OAuth token above (HIVE-124).
 *
 * `TOKEN_HOLDER` (above) already makes the "held by Claude Code" claim about
 * the OAuth token, in the caption every connected state shows — so this
 * names only the *other* half rather than repeating it verbatim, which
 * would read as two different claims about the same token to anyone
 * (a screen reader included) hearing both in one pass.
 */
const CUSTODY_NOTE =
  'The token above stays with Claude Code — in ~/.claude/.credentials.json, ' +
  'refreshed by it, never read by this app. These two are the Hive’s own, ' +
  'encrypted on this machine.';

/**
 * Whether a hint may say "Stored." on its own — `false` once *both* tokens
 * are, so the two SecretFields do not each repeat the word: two matches for
 * one fact reads as two facts, to a screen reader and to a test alike.
 */
function tokenHint(has: boolean, bothStored: boolean, purpose: string): string {
  if (!has) return purpose;
  return bothStored ? purpose : `Stored. ${purpose}`;
}

/** The app-level token's hint: what it is for, and whether one is already stored. */
function appTokenHint(tokens: SlackTokensState): string {
  const bothStored = tokens.hasAppToken && tokens.hasBotToken;
  return tokenHint(
    tokens.hasAppToken,
    bothStored,
    tokens.hasAppToken
      ? 'Scope connections:write. Paste a new one to replace it.'
      : 'Opens the socket. Scope connections:write.',
  );
}

/** The bot token's hint: what it is for, and whether one is already stored. */
function botTokenHint(tokens: SlackTokensState): string {
  const bothStored = tokens.hasAppToken && tokens.hasBotToken;
  return tokenHint(
    tokens.hasBotToken,
    bothStored,
    tokens.hasBotToken
      ? 'Never posts. Paste a new one to replace it.'
      : 'Never posts. Names the workspace and reads channel ids.',
  );
}

/** Said once, above both fields, when the pair as a whole is already stored. */
function bothStoredNote(tokens: SlackTokensState): string | null {
  return tokens.hasAppToken && tokens.hasBotToken
    ? 'Both tokens are already stored. Paste a new one below to replace it.'
    : null;
}

/**
 * The `@hive` half of the Wakes-on summary.
 *
 * Empty is the default (`SlackConfig.commanders`'s own doc comment), and an
 * empty allow-list means `wake.on: [slack.app_mention]` produces no wakes at
 * all — the one place that fact is surfaced, so it says so in words rather
 * than rendering an empty chip that looks identical to "loading".
 */
function commanderSummary(commanders: string[]): string {
  return commanders.length === 0
    ? '@hive → nobody yet · add a Slack user id'
    : `@hive → ${commanders.join(', ')}`;
}

/** What `Test` answers with, once it has answered. */
function SocketTestVerdict({ result }: { result: SlackSocketTestResult }) {
  if (result.kind === 'ok') {
    return (
      <p className="text-[11.5px] text-green">
        Reached <span className="font-mono text-ink">{result.workspace}</span>{' '}
        as <span className="font-mono text-ink">{result.bot}</span>.
      </p>
    );
  }

  return <p className="text-[11.5px] text-red">{result.message}</p>;
}

interface RealTimeFieldsProps {
  slack: SlackConfig;
  tokens: SlackTokensState;
  socket: SlackSocketStatus;
  testing: boolean;
  testResult: SlackSocketTestResult | null;
  onChange: (next: SlackConfig) => void;
  onSetAppToken: (value: string) => void;
  onSetBotToken: (value: string) => void;
  onTest: () => void;
}

/**
 * The fields Socket Mode needs, rendered only once it is on (HIVE-124).
 *
 * Order matches the design record: the state pill and the workspace
 * `auth.test` actually returned, then the app-level token, the bot token, who
 * may command with `@hive`, the Wakes-on summary, and `Test` last.
 */
function RealTimeFields({
  slack,
  tokens,
  socket,
  testing,
  testResult,
  onChange,
  onSetAppToken,
  onSetBotToken,
  onTest,
}: RealTimeFieldsProps) {
  const [appDraft, setAppDraft] = useState('');
  const [botDraft, setBotDraft] = useState('');
  /*
    Seeded once from the config and re-synced only when the *saved* value
    changes underneath us (a config reload, a reset) — the same
    render-time comparator `container-alias-group.tsx` uses, and for the
    same reason: an effect would run one render late and let a blur commit
    the stale value straight back.
  */
  const [seenCommanders, setSeenCommanders] = useState(slack.commanders);
  const [commandersDraft, setCommandersDraft] = useState(() =>
    slack.commanders.join(', '),
  );
  if (seenCommanders !== slack.commanders) {
    setSeenCommanders(slack.commanders);
    setCommandersDraft(slack.commanders.join(', '));
  }

  const commitCommanders = () => {
    const next = commandersDraft
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');
    onChange({ ...slack, commanders: next });
  };

  const commitAppToken = () => {
    const value = appDraft.trim();
    if (value === '') return;
    onSetAppToken(value);
    setAppDraft('');
  };

  const commitBotToken = () => {
    const value = botDraft.trim();
    if (value === '') return;
    onSetBotToken(value);
    setBotDraft('');
  };

  const pill = SOCKET_PILL[socket.kind];

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <StatePill kind={pill.kind} label={pill.label} />
        {socket.kind === 'connected' && (
          <span className="font-mono text-[11.5px] text-subtle">
            {socket.workspace ?? '—'} · {socket.bot ?? '—'}
          </span>
        )}
        {socket.kind === 'failed' && (
          <span className="text-[11.5px] text-red">{socket.message}</span>
        )}
      </div>

      <p className="text-[11.5px] text-subtle">{CUSTODY_NOTE}</p>
      {bothStoredNote(tokens) !== null && (
        <p className="text-[11.5px] text-subtle">{bothStoredNote(tokens)}</p>
      )}

      <SecretField
        label="App-level token"
        value={appDraft}
        onChange={setAppDraft}
        onCommit={commitAppToken}
        placeholder={tokens.hasAppToken ? 'Replace the stored token' : 'xapp-…'}
        hint={appTokenHint(tokens)}
      />

      <SecretField
        label="Bot token"
        value={botDraft}
        onChange={setBotDraft}
        onCommit={commitBotToken}
        placeholder={tokens.hasBotToken ? 'Replace the stored token' : 'xoxb-…'}
        hint={botTokenHint(tokens)}
      />

      <TextField
        label="Allowed to command"
        value={commandersDraft}
        onChange={setCommandersDraft}
        onCommit={commitCommanders}
        placeholder="U08BA712189, U0123ABCD"
        hint="Comma-separated Slack user ids. Only these can command an agent with @hive."
      />

      <div className="flex flex-col gap-1">
        <h5 className="font-mono text-[10.5px] font-semibold uppercase tracking-wide text-subtle">
          Wakes on
        </h5>
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded-[4px] bg-chip px-1.5 py-0.5 font-mono text-[11px] text-muted">
            {commanderSummary(slack.commanders)}
          </span>
          {socket.kind === 'connected' &&
            socket.unresolved.map((name) => (
              <span
                key={name}
                className="rounded-[4px] bg-chip px-1.5 py-0.5 font-mono text-[11px] text-amber"
                title="Named in wake.on, but Slack could not resolve it to a channel."
              >
                {name} → unresolved
              </span>
            ))}
        </div>
      </div>

      <div>
        <Button onClick={onTest} disabled={testing}>
          {testing ? 'Testing…' : 'Test'}
        </Button>
      </div>

      {testResult !== null && <SocketTestVerdict result={testResult} />}
    </>
  );
}

interface AdvancedFieldsProps {
  slack: SlackConfig;
  tokens: SlackTokensState;
  socket: SlackSocketStatus;
  testing: boolean;
  testResult: SlackSocketTestResult | null;
  onChange: (next: SlackConfig) => void;
  onSetAppToken: (value: string) => void;
  onSetBotToken: (value: string) => void;
  onTest: () => void;
}

/**
 * Two sub-groups (HIVE-123, HIVE-124).
 *
 * `Real-time events` is a sibling `grp`, not a restructure, exactly as this
 * comment promised before it existed.
 *
 * **Off is the resting state and the default, so it is the state that is
 * optimised.** Off, the sub-group is a heading, the switch and one line naming
 * both prerequisites; the token fields appear only once it is on. Staging them
 * as two empty boxes was drawn and rejected: it doubles the drawer's height for
 * a feature nobody has agreed to configure, and describing the cost reads
 * better than pre-printing the forms for it.
 */
function AdvancedFields({
  slack,
  tokens,
  socket,
  testing,
  testResult,
  onChange,
  onSetAppToken,
  onSetBotToken,
  onTest,
}: AdvancedFieldsProps) {
  return (
    <div className="flex flex-col gap-4 pt-1">
      <div className="flex flex-col gap-2">
        <h5 className="font-mono text-[11px] font-semibold uppercase tracking-wide text-subtle">
          Slack app
        </h5>
        <p className="text-[11.5px] text-subtle">
          Only if your org runs its own. Changing either signs you out.
        </p>
        <div className="flex items-center justify-between gap-2 rounded-[6px] border border-border bg-bg px-2.5 py-1.5 font-mono text-[12px] text-subtle">
          <span>{SLACK_MCP_URL}</span>
          <span className="text-subtle">server</span>
        </div>
        <div className="flex items-center justify-between gap-2 rounded-[6px] border border-border bg-bg px-2.5 py-1.5 font-mono text-[12px] text-muted">
          <span>{SLACK_CLIENT_ID}</span>
          <span className="text-subtle">client ID</span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h5 className="font-mono text-[11px] font-semibold uppercase tracking-wide text-subtle">
          Real-time events
        </h5>

        <Switch
          label="Socket Mode"
          checked={slack.socketMode}
          onCheckedChange={(next) => onChange({ ...slack, socketMode: next })}
        />

        {!slack.socketMode ? (
          <p className="text-[11.5px] text-subtle">
            Off, agents reach Slack on their own schedule. On, they wake within
            seconds and <span className="font-mono">@hive</span> can command one.
            Needs a Slack app of your own, and two tokens the Hive stores.
          </p>
        ) : (
          <RealTimeFields
            slack={slack}
            tokens={tokens}
            socket={socket}
            testing={testing}
            testResult={testResult}
            onChange={onChange}
            onSetAppToken={onSetAppToken}
            onSetBotToken={onSetBotToken}
            onTest={onTest}
          />
        )}
      </div>
    </div>
  );
}

/**
 * `Advanced` reports an enabled feature rather than hiding it (HIVE-124).
 *
 * A disclosure that hides a feature toggle can make the feature undiscoverable.
 * Without this, a user who turned Socket Mode on cannot see that it is on
 * without opening the drawer.
 */
function advancedSuffix(slack: SlackConfig): string | null {
  return slack.socketMode ? 'real-time events on' : null;
}

export function SlackGroup({ agents, tokens: tokensProp }: SlackGroupProps) {
  const [status, setStatus] = useState<SlackStatus | null>(null);
  /**
   * The last Test failure, held apart from {@link status}.
   *
   * See the module comment: a failed tool call is not a failed connection, and
   * letting it overwrite the status turned "Signed in" into "Failed" and
   * offered a browser re-auth as the fix.
   */
  const [testError, setTestError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  /**
   * Guards `handleSignIn` against a second click. `signIn` waits on a
   * 10-minute browser OAuth round-trip with no other visible feedback; a
   * second click would run a second `claude mcp add` + `claude mcp login`
   * and contend for the single registered callback port 3118.
   */
  const [signingIn, setSigningIn] = useState(false);
  const [open, setOpen] = useState(false);

  /**
   * The socket-mode switch and allow-list, read from the workspace config
   * (HIVE-124) — not local state, so a reload or a reset is reflected the
   * same way every other settings field bound to {@link useProjectConfig}
   * already is.
   */
  const projectConfig = useProjectConfig();
  const slack = projectConfig?.slack ?? DEFAULT_SLACK;

  /**
   * Presence of the two Hive-owned tokens. `tokensProp` is the test seam
   * documented on {@link SlackGroupProps.tokens}; production has no channel
   * that reads this back, so it always starts unknown and only improves once
   * a save or a clear answers.
   */
  const [tokens, setTokens] = useState<SlackTokensState>(
    tokensProp ?? UNKNOWN_TOKENS,
  );
  const [socket, setSocket] = useState<SlackSocketStatus>({ kind: 'off' });
  const [socketTesting, setSocketTesting] = useState(false);
  const [socketTestResult, setSocketTestResult] =
    useState<SlackSocketTestResult | null>(null);

  /*
    Read on mount only — `claude mcp get slack`, parsed, answers in well under
    a second and spends no model turn. This is the one effect in this
    component; every other transition is a direct response to a click.
  */
  useEffect(() => {
    let cancelled = false;

    void readSlackStatus().then((next) => {
      if (!cancelled) setStatus(next ?? bridgeError());
    });

    return () => {
      cancelled = true;
    };
  }, []);

  /*
    The socket's own status is a push, not a poll (`lib/slack.ts`'s doc
    comment on `subscribeSlackSocketStatus`) — main knows the moment it
    changes, and this pane has nothing to gain by asking again.
  */
  useEffect(() => {
    return subscribeSlackSocketStatus(setSocket);
  }, []);

  /**
   * Writes the switch or the allow-list, then installs the fresh snapshot
   * main returns so every consumer of {@link useProjectConfig} — this pane
   * included — renders it on the next tick. `setSlackConfig` (`lib/slack.ts`)
   * answers with the same `ConfigSnapshot` every other settings write does,
   * it just is not routed through `lib/project-config.ts`'s own `mutate`
   * (that module names no Slack verb); `installProjectConfig` is the same
   * escape hatch a main-pushed clone snapshot uses, for the same reason.
   */
  const handleSlackChange = (next: SlackConfig) => {
    void setSlackConfig({
      socketMode: next.socketMode,
      commanders: next.commanders,
    }).then((snapshot) => {
      if (snapshot) installProjectConfig(snapshot);
    });
  };

  const handleSetAppToken = (value: string) => {
    void setSlackTokens({ appToken: value }).then((next) => {
      if (next) setTokens(next);
    });
  };

  const handleSetBotToken = (value: string) => {
    void setSlackTokens({ botToken: value }).then((next) => {
      if (next) setTokens(next);
    });
  };

  const handleSocketTest = () => {
    setSocketTesting(true);
    void testSlackSocket().then((result) => {
      setSocketTesting(false);
      setSocketTestResult(
        result ?? {
          kind: 'error',
          message: 'The app could not reach its own main process.',
        },
      );
    });
  };

  const applyResult = (result: SlackStatus | null) => {
    setStatus(result ?? bridgeError());
    // Any fresh answer about the credential retires the old Test's verdict.
    setTestError(null);
  };

  const handleSignIn = () => {
    setSigningIn(true);
    void signIn().then((result) => {
      setSigningIn(false);
      applyResult(result);
    });
  };

  const handleSignOut = () => {
    void signOut().then(applyResult);
  };

  /*
    The only verb that spends a real model turn. It fires from exactly one
    place — this click handler — and nowhere else in the component: no
    effect, no interval, no automatic retry.
  */
  const handleTest = () => {
    setTesting(true);
    void testSlack().then((result) => {
      setTesting(false);

      const next = result ?? bridgeError();

      /*
        Only the failure is held aside. Every other answer the probe can give —
        `connected`, `needs-auth`, `pending-approval` — is real news about the
        credential and belongs in the pill, which is the whole reason the turn
        was spent.
      */
      if (next.kind === 'error') {
        setTestError(next.message);
        return;
      }

      applyResult(next);
    });
  };

  const suffix = advancedSuffix(slack);

  return (
    <SettingsGroup
      title="Connection"
      description="Agents reach Slack as you, through Slack's own MCP server."
    >
      <div className="flex flex-col gap-3 rounded-[7px] border border-border-soft p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {status === null ? (
              <span className="text-[11.5px] text-subtle">…</span>
            ) : (
              <StatePill kind={pillKindOf(status)} />
            )}
          </div>

          {status !== null && (
            <div className="flex items-center gap-2">
              <Actions
                status={status}
                testing={testing}
                testFailed={testError !== null}
                signingIn={signingIn}
                onSignIn={handleSignIn}
                onSignOut={handleSignOut}
                onTest={handleTest}
              />
            </div>
          )}
        </div>

        <div className="h-px bg-border-soft" />

        <div className="flex flex-wrap items-center justify-between gap-3">
          {status === null ? (
            <p className="text-[11.5px] text-subtle">…</p>
          ) : (
            <Caption status={status} agents={agents} testError={testError} />
          )}

          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="flex shrink-0 items-center gap-1 text-[12px] text-brand hover:text-ink"
          >
            <CaretRight
              size={11}
              className={cn('transition-transform', open && 'rotate-90')}
            />
            Advanced
            {suffix !== null && <span className="text-green"> · {suffix}</span>}
          </button>
        </div>

        {open && (
          <AdvancedFields
            slack={slack}
            tokens={tokens}
            socket={socket}
            testing={socketTesting}
            testResult={socketTestResult}
            onChange={handleSlackChange}
            onSetAppToken={handleSetAppToken}
            onSetBotToken={handleSetBotToken}
            onTest={handleSocketTest}
          />
        )}
      </div>
    </SettingsGroup>
  );
}
