import { OVERMIND, type LedgerEntry } from '@shared/ledger-contract';
import type { NotificationAction, NotificationKind } from '@shared/notification-contract';

/**
 * What the hub hands this module. Four functions rather than the hub itself,
 * so the mapping can be tested without one.
 */
export interface LedgerNotifierDeps {
  raise: (input: {
    kind: NotificationKind;
    id: string;
    title: string;
    body?: string;
    action?: NotificationAction;
    createdAt?: number;
  }) => unknown;
  markRead: (id: string) => void;
  dismiss: (id: string) => void;
  /** Whether a party id names a registered agent rather than a session. */
  isAgent: (id: string) => boolean;
}

/** Run outcomes that mean the agent was stopped rather than finished. */
const CUT_OFF = new Set(['failed', 'budget', 'turns']);

const TITLE_BY_OUTCOME: Record<string, string> = {
  turns: 'Ran out of turns',
  budget: 'Hit its budget',
  failed: 'Run failed',
};

/** The first line of a body, and the rest — the card's title and its detail. */
const split = (body: string): [string, string] => {
  const at = body.indexOf('\n');
  return at === -1 ? [body, ''] : [body.slice(0, at), body.slice(at + 1).trim()];
};

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/**
 * Ledger entries into inbox cards (HIVE-118).
 *
 * ## The notification's id is the ask's entry id
 *
 * Which is what makes answering cheap: an `answer` names its thread, the
 * thread *is* the notification, so marking it read is one call with no lookup
 * table to keep. It also makes the whole module idempotent — `raise` dedups on
 * id — so replaying a day's ledger on a restart cannot double-raise.
 *
 * ## Why a run's own receipt is the fallback, not the source
 *
 * `finalizeRun` appends `run.ended — <outcome>` for *every* run, and an agent
 * can also post its own `done`/`failed`. Mapping both would mint two cards per
 * ending. The split drawn here: an agent's own report is the news, because it
 * chose to make it; the run receipt speaks only when the agent could not — a
 * turn cap, a budget cap, a kill, a stall. That is also what keeps a
 * three-hourly watcher that found nothing from filing a green card every wake.
 */
export function createLedgerNotifier(
  deps: LedgerNotifierDeps,
): (entry: LedgerEntry) => void {
  /** Runs whose agent already reported a failure, so the receipt stays quiet. */
  const spokenFor = new Set<string>();

  return (entry) => {
    const meta = entry.meta ?? {};

    if (entry.kind === 'ask' && entry.to === OVERMIND) {
      const permission = meta.kind === 'permission';
      const [first, rest] = split(entry.body);
      deps.raise({
        kind: permission ? 'agent.permission' : 'agent.ask',
        id: entry.id,
        title: meta.quote === undefined ? first : 'Send this reply?',
        body: meta.quote === undefined ? rest : entry.body,
        action: { type: 'ask', thread: entry.id },
        createdAt: entry.ts,
      });
      return;
    }

    if (entry.kind === 'answer' && entry.thread !== undefined) {
      deps.markRead(entry.thread);
      return;
    }

    /*
      A `done` closes its ask whoever sent it — that is the collapsed card
      being replaced. Only an agent's `done` is *news*: a session closing an
      ask it made itself is bookkeeping the user already watched happen.
    */
    if (entry.kind === 'done') {
      if (entry.thread !== undefined) deps.dismiss(entry.thread);
      if (!deps.isAgent(entry.from)) return;
      const [first, rest] = split(entry.body);
      deps.raise({
        kind: 'agent.done',
        id: entry.id,
        title: first,
        body: rest,
        action: { type: 'agent', name: entry.from },
        createdAt: entry.ts,
      });
      return;
    }

    if (entry.kind === 'failed' && deps.isAgent(entry.from)) {
      const run = str(meta.run);
      if (run !== undefined) spokenFor.add(run);
      const [first, rest] = split(entry.body);
      deps.raise({
        kind: 'agent.failed',
        id: entry.id,
        title: first,
        body: rest,
        action: { type: 'agent', name: entry.from },
        createdAt: entry.ts,
      });
      return;
    }

    if (entry.kind !== 'event' || !deps.isAgent(entry.from)) return;

    const outcome = str(meta.outcome);
    if (outcome === undefined || !CUT_OFF.has(outcome)) return;

    const run = str(meta.run);
    if (run !== undefined && spokenFor.has(run)) return;

    deps.raise({
      kind: 'agent.failed',
      id: entry.id,
      title: TITLE_BY_OUTCOME[outcome],
      /*
        `reason` is a bare string, not a union — `killed` and `stalled` are all
        that main produces today — so it is shown verbatim rather than mapped
        into copy that would go stale the moment a new one appears.
      */
      body: outcome === 'failed' ? (str(meta.reason) ?? '') : '',
      action: { type: 'agent', name: entry.from },
      createdAt: entry.ts,
    });
  };
}
