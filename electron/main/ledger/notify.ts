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
    /** The party this row is about, resolved to a name at presentation time. */
    subject?: string;
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
 *
 * ## Why `spokenFor` is keyed on the party, not the run (whole-branch review,
 * finding 2)
 *
 * It used to be keyed on `meta.run`, which only `finalizeRun` ever stamps —
 * the run receipt itself. An agent's own `ledger_failed` goes through
 * `mcp-host/tools.ts`, whose schema (`ledger-tools.ts`) has no run field and
 * whose `AGENT_PREAMBLE` never tells an agent its own run id, so the
 * agent-posted `failed` this dedup exists to notice never carried one. The
 * dedup could not fire in production, and the old test proved nothing because
 * it hand-built a `meta.run` shape nothing real produces.
 *
 * The party is what both entries agree on: an agent's `failed` and the
 * `run.ended` receipt for the run that just ended are both entries `from` that
 * same agent, and one agent has at most one run in flight. That is a fact
 * this module can already ask `isAgent` about, with no run-tracking to keep in
 * step with `runs.ts`.
 */
export function createLedgerNotifier(
  deps: LedgerNotifierDeps,
): (entry: LedgerEntry) => void {
  /**
   * Agents whose own `ledger_failed` has already been turned into a card, so
   * the run receipt that follows stays quiet.
   *
   * A run's `event` — the receipt below — is what **consumes** an entry here,
   * on *any* outcome, not only the ones that would otherwise raise a second
   * card. An agent that posts `ledger_failed` and then has that same run end
   * `done` must not leave the flag standing: the next run's genuine failure
   * would silently find it already set and go unreported.
   */
  const spokenFor = new Set<string>();

  return (entry) => {
    const meta = entry.meta ?? {};

    if (entry.kind === 'ask' && entry.to === OVERMIND) {
      const permission = meta.kind === 'permission';
      const [first, rest] = split(entry.body);
      /*
        `str`, not `!== undefined` — the same "non-empty string" guard the card
        applies (`ask-card.tsx`), and it has to be the same one.

        `mcp-host/tools.ts` admits `quote: ''` (`typeof quote === 'string'`),
        and any non-string can reach `meta` through the passthrough. Under the
        looser test one ask got two presentations: this notification titled
        itself "Send this reply?" and offered a body that was the whole entry,
        while the card next to it drew the ordinary title, the ordinary detail
        and no quote block at all.
      */
      const quote = str(meta.quote);
      deps.raise({
        kind: permission ? 'agent.permission' : 'agent.ask',
        id: entry.id,
        title: quote === undefined ? first : 'Send this reply?',
        body: quote === undefined ? rest : entry.body,
        /*
          The asker, so three agents asking at once give three distinguishable
          toasts rather than three reading "Send this reply?" (HIVE-118).

          `subject` rather than a name pasted into the title, and the choice
          matters for the commonest asker of all: since HIVE-108 a session
          opens *unnamed* and titles itself some turns in, so a name frozen
          here would say `sess-11` for ever — the exact bug `subject` was
          introduced to close. `hub.ts` resolves it at the moment the toast is
          presented instead.

          A **party** id, which is a terminal id when a session asked and an
          agent's own name when an agent did. `subjectName` resolves the first
          and falls back to the raw id for the second, which is already the
          right answer — an agent's id *is* its display name. Nothing on the
          renderer side reads `subject` for an ask: `notification-card.tsx`
          forks an `ask` action to `AskCard` before it touches the field, so
          the session lookup this branch closed twice cannot run on an agent
          name here either.
        */
        subject: entry.from,
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
      A `done` or a `failed` closes the ask it names, whoever sent it, and the
      card goes with it (HIVE-118).

      **Symmetric on purpose.** These two were not, and the asymmetry was the
      bug: a `done` dismissed the card, a `failed` did not, so the user kept a
      live card with working-looking buttons for a question its asker had
      already abandoned — and `Ledger.append` would refuse every one of those
      buttons, because `openAsks` no longer holds the thread open. The schema
      the model reads makes them the same act (`ledger-tools.ts`: "the ask this
      completes", "the ask this abandons"), and `CLOSING_KINDS` in
      `ledger-derive.ts` is the other half of this decision — the two must
      agree, or the card and the badge disagree about the same thread.

      Only an agent's report is *news*, and that is a separate question from
      closing the ask: a session closing an ask it made itself is bookkeeping
      the user already watched happen, so the dismissal lands and no card is
      minted.
    */
    if (entry.kind === 'done' || entry.kind === 'failed') {
      if (entry.thread !== undefined) deps.dismiss(entry.thread);
      if (!deps.isAgent(entry.from)) return;
      if (entry.kind === 'failed') spokenFor.add(entry.from);
      const [first, rest] = split(entry.body);
      deps.raise({
        kind: entry.kind === 'done' ? 'agent.done' : 'agent.failed',
        id: entry.id,
        title: first,
        body: rest,
        action: { type: 'agent', name: entry.from },
        createdAt: entry.ts,
      });
      return;
    }

    /*
      An ask that time retired takes its card with it (HIVE-120).

      Ahead of the run-receipt branch below rather than folded into it, because
      that branch is gated on `isAgent(entry.from)` and this event comes from
      the **overmind**: main retires the question, whoever asked it.

      And gated on that `from`, rather than merely documented as coming from it.
      `meta` is a free-form rider the tool layer passes through verbatim, so
      without the check any session or agent could post an event carrying
      `meta.expired` and dismiss another party's card. `ledger-derive.ts` applies
      the same rule to the sweep's dedup, and the two have to agree.

      Dismissed rather than left standing with an `expired` word on it. The
      thread is closed, so `Ledger.append` refuses every button the card
      offers — a live card bearing working-looking buttons over a dead thread
      is exactly the asymmetry the `done`/`failed` branch above was fixed to
      remove.
    */
    const expired = str(meta.expired);

    if (entry.kind === 'event' && expired !== undefined && entry.from === OVERMIND) {
      deps.dismiss(expired);
      return;
    }

    /*
      A day's ceiling reached (HIVE-121).

      Gated on the **overmind**, exactly as the expiry branch above is, and for
      its reason: `meta` is a free-form rider the tool layer passes through
      verbatim, so a branch keyed off an agent's own `from` is one any agent
      could fire for itself by posting an event. Main is what declined to start
      the run, so main is what says so — and the agent it is about rides in
      `meta.agent` rather than in `from`.

      Above the run-receipt path rather than folded into it, because that path
      consumes `spokenFor` on any outcome and this is not a run receipt: no run
      ended. Falling through would eat the dedup token and swallow the agent's
      next real report.

      `agent.failed` rather than a new kind: the kinds are a closed set the user
      configures delivery on, and "the agent stopped early" is what this one
      already means. The title names which ceiling it was, since the per-wake
      budget raises the same kind.
    */
    if (entry.kind === 'event' && entry.from === OVERMIND) {
      const subjectAgent = str(meta.agent);

      if (
        typeof meta.dailyCap === 'number' &&
        subjectAgent !== undefined &&
        deps.isAgent(subjectAgent)
      ) {
        deps.raise({
          kind: 'agent.failed',
          id: entry.id,
          title: 'Hit its daily cap',
          subject: subjectAgent,
          body: entry.body,
          action: { type: 'agent', name: subjectAgent },
          createdAt: entry.ts,
        });
      }

      /*
        `agent.failed` rather than a new kind, for the reason the daily cap is:
        the kinds are a closed set the user configures delivery on, and "this
        agent stopped doing what it should" is what this one already means. The
        title names the specific ceiling, since three kinds share it.
      */
      if (
        typeof meta.rotateFailed === 'number' &&
        subjectAgent !== undefined &&
        deps.isAgent(subjectAgent)
      ) {
        deps.raise({
          kind: 'agent.failed',
          id: entry.id,
          title: 'Could not rotate its session',
          subject: subjectAgent,
          body: entry.body,
          action: { type: 'agent', name: subjectAgent },
          createdAt: entry.ts,
        });
      }

      return;
    }

    if (entry.kind !== 'event' || !deps.isAgent(entry.from)) return;

    const outcome = str(meta.outcome);
    if (outcome === undefined) return;

    /*
      Consumed here, on any outcome — this is the run that `spokenFor` was
      remembering, whatever it ended as. `Set.delete` answers whether the
      party was in fact spoken for, which is exactly the dedup check: only
      suppress the receipt when the agent's own report got there first.
    */
    const alreadyReported = spokenFor.delete(entry.from);
    if (!CUT_OFF.has(outcome) || alreadyReported) return;

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
