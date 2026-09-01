import { CaretRight } from '@phosphor-icons/react';
import { useEffect, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Button } from '@components/ui/button';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { readSlackStatus, signIn, signOut, testSlack } from '@lib/slack';
import { grantsSlackTools, SLACK_CLIENT_ID, SLACK_MCP_URL } from '@shared/slack-contract';
import type { SlackStatus } from '@shared/slack-contract';

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
}

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

function StatePill({ kind }: { kind: PillKind }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-wide',
        PILL_TONE[kind],
      )}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {PILL_LABEL[kind]}
    </span>
  );
}

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
 * Read-only today — only the "Slack app" half. HIVE-124 adds a second,
 * `Real-time events` sub-group beneath it (a Socket Mode app-level token and
 * bot token, with its own switch); this drawer already holds more than one
 * sub-group's worth of vertical rhythm so that addition is a sibling `<div
 * className="grp">`, not a restructure.
 */
function AdvancedFields() {
  return (
    <div className="flex flex-col gap-2 pt-1">
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
  );
}

/**
 * `Advanced` reports an enabled feature rather than hiding it (HIVE-124's
 * requirement on this drawer). `suffix` is where that lives — always `null`
 * until the real-time-events sub-group exists to fill it with e.g. `real-time
 * events on`; the slot is here now so that addition needs no restructure.
 */
function advancedSuffix(): string | null {
  return null;
}

export function SlackGroup({ agents }: SlackGroupProps) {
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

  const suffix = advancedSuffix();

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

        {open && <AdvancedFields />}
      </div>
    </SettingsGroup>
  );
}
