import {
  STANDING_LANE,
  repoLane,
  threadLane,
  type AgentLane,
  type AgentStatus,
} from '@shared/agent-contract';
import { OVERMIND, type LedgerEntry } from '@shared/ledger-contract';
import { CLOSING_KINDS, laneOfRun, taskOf } from '@shared/ledger-derive';

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

/**
 * A Slack event's fate, by the agent's state (HIVE-124).
 *
 * Delegates to {@link decideForStatus} rather than repeating the table: an
 * event and an addressed entry are the same question — is this agent able to
 * take a wake right now — and the two answers must not drift apart. What is
 * genuinely different about an event is decided in `bridge.ts`, which
 * coalesces and floors before anything reaches here.
 *
 * Notably there is no `ignore` branch. `onEntry` has one because a broadcast
 * reaches every agent and most of them should not care; an event arrives here
 * only after the subscription index named this agent, so the wanting is
 * already established.
 */
export const decideForEvent = (status: AgentStatus): WakeDecision =>
  decideForStatus(status);

export function decide(
  status: AgentStatus,
  entry: LedgerEntry,
  options?: { sameLane?: boolean },
): WakeDecision {
  // A broadcast wakes nobody — parties read those on their own schedule.
  if (entry.to === undefined) return 'ignore';
  /*
    An agent's own entry is not news to itself.

    Without this a `post` an agent addresses to itself — a note-to-self across
    wakes, which the ledger allows — would wake the agent that just wrote it,
    which would write another, forever.

    Since HIVE-186 an agent's own entry wakes a different lane, which is how
    a standing lane hands work into a repo lane. The loop guard holds,
    because an entry never wakes the lane that wrote it.
  */
  if (entry.from === entry.to && (options?.sameLane ?? true)) return 'ignore';
  if (!WAKING_KINDS.has(entry.kind)) return 'ignore';

  return decideForStatus(status);
}

/** Where an entry goes, or why an ask is turned away (HIVE-186). */
export type LaneRoute = { lane: string } | { refuse: string };

/** `owner/name`, the only `meta.repo` a repo lane keys on. */
const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * A thread lane is done once the ask that opened it is closed: answered,
 * `done`, `failed`, or expired (spec §1). An expiry is the overmind's own
 * event, as `expiredAsks` reads it. `exceptId` leaves out the entry being
 * routed, so the closing entry itself still reaches the lane it closes.
 */
export function isClosedLane(lane: string, entries: readonly LedgerEntry[], exceptId?: string): boolean {
  if (!lane.startsWith('thread:')) return false;
  const ask = lane.slice('thread:'.length);
  return entries.some(
    (item) =>
      item.thread === ask &&
      item.id !== exceptId &&
      (CLOSING_KINDS.has(item.kind) ||
        (item.kind === 'event' && item.from === OVERMIND && item.meta?.['expired'] === ask)),
  );
}

/** The lane a new ask to `agent` opens, by the definition's `lane:`. */
export function openedLane(agent: string, mode: AgentLane | undefined, ask: LedgerEntry): LaneRoute {
  if (mode === 'thread') return { lane: threadLane(ask.id) };
  if (mode !== 'repo') return { lane: STANDING_LANE };
  const repo = ask.meta?.['repo'];
  return typeof repo === 'string' && REPO_SLUG.test(repo)
    ? { lane: repoLane(repo) }
    : { refuse: `${agent} lanes by repository; send meta.repo as owner/name.` };
}

/**
 * The lane an entry addressed to an agent belongs to (HIVE-186, spec §4).
 *
 * 1. A broadcast: standing.
 * 2. An entry in a thread: the thread's ask decides. The agent's own ask
 *    follows the run that wrote it; an ask made of the agent follows the lane
 *    it opened. Either way, a thread lane whose opening ask has closed hands
 *    over to standing.
 * 3. A new ask: the lane it opens.
 * 4. Anything else: standing.
 */
export function laneFor(
  mode: AgentLane | undefined,
  entry: LedgerEntry,
  entries: readonly LedgerEntry[],
): LaneRoute {
  const to = entry.to;
  if (to === undefined) return { lane: STANDING_LANE };

  if (entry.thread !== undefined) {
    const ask = entries.find((item) => item.id === entry.thread && item.kind === 'ask');
    let lane = STANDING_LANE;
    if (ask?.from === to) lane = laneOfRun(to, ask.meta?.['run'], entries);
    else if (ask?.to === to) {
      const opened = openedLane(to, mode, ask);
      if ('lane' in opened) lane = opened.lane;
    }
    return { lane: isClosedLane(lane, entries, entry.id) ? STANDING_LANE : lane };
  }

  if (entry.kind === 'ask') return openedLane(to, mode, entry);
  return { lane: STANDING_LANE };
}

/**
 * Which of an agent's lanes hold work (HIVE-186): an open claim whose claim
 * entry was written by a run of that lane. The shipper claims
 * `<owner>/<repo>#<N>` at intake and releases it at `closed`, so its repo
 * lanes hold work exactly while they hold PRs.
 */
export function laneClaims(agent: string, entries: readonly LedgerEntry[]): Set<string> {
  const held = new Map<string, LedgerEntry>();
  for (const item of entries) {
    const task = taskOf(item);
    if (task === undefined) continue;
    if (item.kind === 'claim') held.set(task, item);
    else if (item.kind === 'release') held.delete(task);
  }
  const lanes = new Set<string>();
  for (const claim of held.values()) {
    if (claim.from === agent) lanes.add(laneOfRun(agent, claim.meta?.['run'], entries));
  }
  return lanes;
}
