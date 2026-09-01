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
 * One `SettingsGroup`, not three: a status row (state pill · identity ·
 * actions), a hairline, then one caption line and an `Advanced` disclosure.
 * The two alternatives considered — mirroring Jira's three nested groups, and
 * a connection card — both cost roughly three times the height to say one
 * sentence; this is the smallest shape that still answers "am I signed in,
 * as whom, and what is using it".
 *
 * ## The caption does double duty
 *
 * It is one slot with a strict precedence — an error message, else the
 * approval sentence, else the Used-by summary — and never two at once. That
 * is what lets `pending-approval` and a failed sign-in fit without a fourth
 * block: {@link Caption} is the one place that decision gets made.
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

/** `@yunid`, and `· workspace` only when the probe that discovered it named one. */
function identityOf(status: SlackStatus): string | null {
  if (status.kind !== 'connected' && status.kind !== 'pending-approval') return null;

  const { connection } = status;
  if (connection === undefined) return null;

  return connection.workspace
    ? `${connection.user} · ${connection.workspace}`
    : connection.user;
}

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
}: {
  status: SlackStatus;
  agents: SlackGroupAgent[];
}) {
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

  return <p className="text-[11.5px] text-subtle">{usedBySummary(agents)}</p>;
}

function Actions({
  status,
  testing,
  onSignIn,
  onSignOut,
  onTest,
}: {
  status: SlackStatus;
  testing: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  onTest: () => void;
}) {
  switch (status.kind) {
    case 'not-added':
    case 'needs-auth':
      return (
        <Button variant="primary" onClick={onSignIn}>
          Sign in to Slack
        </Button>
      );
    case 'connected':
      return (
        <>
          <Button onClick={onTest} disabled={testing}>
            {testing ? 'Testing…' : 'Test'}
          </Button>
          <Button variant="danger" onClick={onSignOut}>
            Sign out
          </Button>
        </>
      );
    case 'pending-approval':
      return (
        <Button onClick={onTest} disabled={testing}>
          {testing ? 'Testing…' : 'Test again'}
        </Button>
      );
    case 'error':
      return (
        <Button variant="primary" onClick={onSignIn}>
          Try again
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
  const [testing, setTesting] = useState(false);
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
  };

  const handleSignIn = () => {
    void signIn().then(applyResult);
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
      applyResult(result);
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
              <>
                <StatePill kind={pillKindOf(status)} />
                {identityOf(status) !== null && (
                  <span className="text-[12.5px] text-muted">{identityOf(status)}</span>
                )}
              </>
            )}
          </div>

          {status !== null && (
            <div className="flex items-center gap-2">
              <Actions
                status={status}
                testing={testing}
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
            <Caption status={status} agents={agents} />
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
