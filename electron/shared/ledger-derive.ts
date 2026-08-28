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
 * Asks nobody has answered and time has not retired.
 *
 * Both conditions matter. Without the TTL an ask whose asker died stays open
 * forever and the inbox never empties; without the answer check a thread
 * closes on a timer while someone is still owed a reply.
 */
export function openAsks(entries: readonly LedgerEntry[], now: number): OpenAsk[] {
  const answered = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'answer' && entry.thread !== undefined) answered.add(entry.thread);
  }

  const open: OpenAsk[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'ask') continue;
    if (answered.has(entry.id)) continue;
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
