/**
 * Reading the ledger forward (HIVE-111).
 *
 * Pure and dependency-free, and in `@shared` rather than beside the store in
 * main for one reason: the renderer's selectors need exactly these rules, and
 * `src/**` may not import `electron/main/**`. Putting them here is what keeps
 * one definition of "open" instead of two that drift.
 */

import {
  LEDGER_ASK_TTL_MS,
  LEDGER_REF_PREFIX,
  type LedgerEntry,
  type LedgerReadQuery,
  type OpenAsk,
} from './ledger-contract';

/**
 * `meta.task`, when it is a non-empty string.
 *
 * Exported because `Ledger.append` needs the *same* answer when it decides
 * whether a `release` is allowed. Two readings of "which task does this entry
 * name" would let a write pass the rule under one and change `claims()` under
 * the other.
 */
export const taskOf = (entry: Pick<LedgerEntry, 'meta'>): string | undefined => {
  const task = entry.meta?.task;
  return typeof task === 'string' && task !== '' ? task : undefined;
};

/**
 * The kinds that close a thread they name.
 *
 * An `answer` is the obvious one — the question got its reply. `done` and
 * `failed` are the two the *asker* uses to take the question back, and
 * `ledger-tools.ts` says so in the schema the model reads: `thread` on
 * `ledger_done` is "the ask this completes", on `ledger_failed` "the ask this
 * abandons". Either way nobody is owed a reply any more.
 *
 * They were missing here, and the gap was visible on screen (HIVE-118): the
 * notifier dismissed the card on a `done` while this function kept the ask
 * open, so the left rail's Agents badge — counted straight off the ledger and
 * immune to notification state — stayed lit with nothing behind it to answer.
 * A `failed` was the mirror image: the ask closed nowhere and the user kept a
 * live, button-bearing card for a question its asker had already given up on,
 * whose buttons `Ledger.append` would refuse anyway.
 *
 * One set rather than a condition spelled out twice, because the notifier
 * makes the same call about the same three kinds and the two must not drift.
 */
const CLOSING_KINDS = new Set(['answer', 'done', 'failed']);

/**
 * Asks nobody has closed and time has not retired.
 *
 * Both conditions matter. Without the TTL an ask whose asker died stays open
 * forever and the inbox never empties; without the {@link CLOSING_KINDS} check
 * a thread closes on a timer while someone is still owed a reply.
 */
export function openAsks(entries: readonly LedgerEntry[], now: number): OpenAsk[] {
  const closed = new Set<string>();
  for (const entry of entries) {
    if (entry.thread === undefined) continue;
    if (CLOSING_KINDS.has(entry.kind)) closed.add(entry.thread);
  }

  const open: OpenAsk[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'ask') continue;
    if (closed.has(entry.id)) continue;
    const ageMs = now - entry.ts;
    if (ageMs >= LEDGER_ASK_TTL_MS) continue;
    open.push({ ...entry, kind: 'ask', open: true, ageMs });
  }
  return open;
}

/**
 * Who holds what, by the last word on each task.
 *
 * A report, not an arbiter. Nothing here decides who *should* have won a
 * contested task — `ledger_claim` in the tool layer reports the current holder
 * rather than refusing, so a second `claim` is a fact the log records and this
 * function reads back. The one rule that is enforced, and enforced in
 * `Ledger.append` rather than here, is that a `release` must come from the
 * holder: this function deletes on any release naming the task, so a release
 * from a third party would change derived state exactly as if it had
 * misbehaved as the holder.
 */
export function claims(entries: readonly LedgerEntry[]): Record<string, string> {
  const held: Record<string, string> = {};
  for (const entry of entries) {
    const task = taskOf(entry);
    if (task === undefined) continue;
    if (entry.kind === 'claim') held[task] = entry.from;
    else if (entry.kind === 'release') delete held[task];
  }
  return held;
}

/** The ask itself plus everything that named it, in write order. */
export function thread(entries: readonly LedgerEntry[], id: string): LedgerEntry[] {
  return entries.filter((entry) => entry.id === id || entry.thread === id);
}

/**
 * The newest `limit` entries, or all of them when no limit was given.
 *
 * A named function rather than an inline `slice`, because the inline version
 * was wrong in a way that reads as correct: `slice(-Math.max(0, limit))` is
 * `slice(-0)` for `limit: 0`, and `slice(-0)` is `slice(0)` — a whole copy.
 * The narrowest request a caller can make returned the widest possible answer,
 * and `parseLedgerReadQuery` admits `0` as valid, so it was reachable from
 * both boundaries.
 */
export function keepNewest(entries: LedgerEntry[], limit: number | undefined): LedgerEntry[] {
  if (limit === undefined) return entries;
  if (limit <= 0) return [];
  return entries.slice(-limit);
}

/**
 * Does one entry satisfy a query?
 *
 * `to` is the asymmetric one: a query for `to: 'sess-b'` also matches
 * broadcasts, because a broadcast *is* addressed to sess-b — along with
 * everyone else.
 *
 * `thread` is the other one, and for the same reason `thread()` above is:
 * "the conversation" includes the question. Matching only `entry.thread`
 * would give one contract two definitions of a thread — a read for
 * `thread: <askId>` would come back with every reply and not the ask they are
 * replying to.
 */
export function matches(entry: LedgerEntry, query: LedgerReadQuery): boolean {
  if (query.from !== undefined && entry.from !== query.from) return false;
  if (query.kind !== undefined && entry.kind !== query.kind) return false;
  if (query.thread !== undefined && entry.thread !== query.thread && entry.id !== query.thread) {
    return false;
  }
  if (query.to !== undefined && entry.to !== undefined && entry.to !== query.to) return false;
  if (query.since !== undefined && entry.id <= query.since) return false;
  return true;
}

/**
 * A short ref, or a canonical id, to a canonical id.
 *
 * Accepting both is what lets one call site serve a human typing `a12` in the
 * console and a model echoing back the id it read.
 */
export function resolveRef(
  entries: readonly LedgerEntry[],
  refOrId: string,
): string | undefined {
  for (const entry of entries) {
    if (entry.id === refOrId) return entry.id;
  }
  for (const entry of entries) {
    if (entry.ref === refOrId) return entry.id;
  }
  return undefined;
}

/**
 * The next short handle.
 *
 * Seeded off the highest ref currently loaded, which is why refs stay two or
 * three characters: asks expire at {@link LEDGER_ASK_TTL_MS} and the store
 * holds today and yesterday, so the window always covers every ask a ref could
 * still need to name. After a quiet day the counter restarts, and that is
 * fine — a ref only ever has to be unambiguous among *open* asks.
 */
export function nextRef(entries: readonly LedgerEntry[]): string {
  let highest = 0;
  for (const entry of entries) {
    if (entry.ref === undefined) continue;
    if (!entry.ref.startsWith(LEDGER_REF_PREFIX)) continue;
    const n = Number.parseInt(entry.ref.slice(LEDGER_REF_PREFIX.length), 10);
    if (Number.isInteger(n) && n > highest) highest = n;
  }
  return `${LEDGER_REF_PREFIX}${highest + 1}`;
}
