import type { AgentStatus } from '@shared/agent-contract';
import type { LedgerEntry } from '@shared/ledger-contract';

/**
 * What to do with one entry addressed to one agent (HIVE-120).
 *
 * `queue` and `hold` write to the same place — the agent's `pendingWake` — and
 * differ only in who flushes it: a run closing for `queue`, a resume for
 * `hold`. They stay two words rather than one because this function is what the
 * tests interrogate, and a single `queue` would make "why did this not wake"
 * unanswerable from the rule alone.
 */
export type WakeDecision = 'wake' | 'queue' | 'hold' | 'ignore';

/**
 * The kinds that wake an agent they name.
 *
 * `done` and `failed` are here because they are how an asker takes its question
 * back — `CLOSING_KINDS` in `ledger-derive.ts` says the same of the same two —
 * so an agent waiting on a thread learns it was abandoned rather than sleeping
 * on until something unrelated happens to wake it.
 *
 * `event` is **excluded, and the exclusion is load-bearing.** The scheduler
 * appends to the very log it subscribes to (the expiry sweep), and `runs.ts`
 * appends `run.started` and `run.ended` for every wake this set lets through.
 * Including `event` would make each wake cause the next one, forever.
 * `deliver.ts` draws the same line for the same reason, and
 * `docs/agents-and-ledger.md` records it as "a loop guard, not a filter".
 *
 * `claim`, `release` and `handoff` are left out as bookkeeping: they change who
 * holds what, which an agent reads when it next wakes, and none of them is a
 * question anyone is waiting on an answer to.
 */
export const WAKING_KINDS: ReadonlySet<string> = new Set([
  'ask',
  'answer',
  'done',
  'failed',
  'post',
]);

/**
 * The story's whole delivery table, as one pure function.
 *
 * Asked at **arrival** time, which is why `working` is the honest answer for an
 * entry that lands mid-run: whether that queue is later flushed or held is a
 * question about the moment the run *closes*, and it belongs to `onRunClosed`
 * rather than here. HIVE-117 made that distinction matter — a pause may land
 * mid-run, so an entry queued under `working` can face a paused agent by the
 * time anyone acts on it.
 *
 * The kind gate runs before the status is consulted, so a state that would
 * queue never queues an entry that could not have woken the agent anyway.
 */
/**
 * The status half of the rule, for news that is not an entry.
 *
 * The expiry sweep needs this: it has already decided the agent should hear
 * something, and the only open question is whether the agent can take a wake
 * right now. Routing that through {@link decide} would mean handing it a
 * synthetic entry, and the nearest honest one — the agent's own ask — is
 * self-addressed and would be ignored.
 */
export function decideForStatus(status: AgentStatus): WakeDecision {
  if (status === 'working') return 'queue';
  if (status === 'paused') return 'hold';

  return 'wake';
}

export function decide(status: AgentStatus, entry: LedgerEntry): WakeDecision {
  // A broadcast wakes nobody — parties read those on their own schedule.
  if (entry.to === undefined) return 'ignore';
  /*
    An agent's own entry is not news to itself.

    Without this a `post` an agent addresses to itself — a note-to-self across
    wakes, which the ledger allows — would wake the agent that just wrote it,
    which would write another, forever.
  */
  if (entry.from === entry.to) return 'ignore';
  if (!WAKING_KINDS.has(entry.kind)) return 'ignore';

  return decideForStatus(status);
}
