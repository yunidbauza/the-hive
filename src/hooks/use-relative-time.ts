import { useEffect, useState } from 'react';

/**
 * How long ago, as the inbox spells it, kept current (HIVE-75).
 *
 * ## Why a hook and not a formatter
 *
 * The shape this replaced stored the string. A fixture row said `"4m"` and went
 * on saying `"4m"` for as long as the app was open, because nothing recomputed
 * it — the number was written once, by hand, and was a lie by the second minute.
 *
 * A pure formatter would fix the lie and not the staleness: React has no reason
 * to re-render a card just because a minute passed. So the ticking has to be
 * the hook's job.
 *
 * ## Why the interval widens
 *
 * A row six hours old does not need a repaint every thirty seconds, and an
 * inbox of fifty of them would wake the renderer fifty times a minute to change
 * nothing. The cadence follows the resolution actually on screen: sub-minute
 * rows tick every fifteen seconds, minute rows every thirty, and anything past
 * an hour every five minutes — at which point the label only moves once an hour
 * anyway.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/**
 * Thirty days, which is nobody's month and is the closest a pure elapsed-time
 * formatter gets to one. Four weeks would read `14 mo ago` for a row from
 * fourteen real months ago plus a fortnight; thirty days reads `13 mo ago`,
 * which is wrong by less than the word `month` is wrong by anyway.
 */
const MONTH = 30 * DAY;

/** The label, given a timestamp and the moment to measure it from. */
export function formatRelativeTime(createdAt: number, now: number): string {
  /**
   * A future timestamp reads as `now` rather than as a negative age.
   *
   * Clock skew is real — main stamps the event and the renderer reads its own
   * clock — and "in -3s" is a bug report, whereas "now" is merely imprecise.
   */
  const elapsed = Math.max(0, now - createdAt);

  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  return `${Math.floor(elapsed / DAY)}d`;
}

/**
 * The same age in words, for the fleet table's `LAST USED` column.
 *
 * A second vocabulary rather than a parameter on {@link formatRelativeTime},
 * because the two columns disagree about more than verbosity. The inbox stacks
 * fifty cards whose ages are scanned as a group, so `5m` is read as a shape and
 * the abbreviation is the point. A fleet row is read one at a time, next to a
 * status word and a branch, and `5m` there is one more token in a line of
 * tokens — the words are what make it parse as a time at all.
 *
 * ## Why it stops at months
 *
 * Every value here has to fit `COL.lastUsed`, which is 80px — ten characters in
 * this face at 12.5px, measured against `59 min ago` and `6 days ago`. Plain
 * day-counting has no ceiling: a session-history row from last spring reads
 * `412 days ago`, overflows the column, and takes the table's alignment with
 * it. Weeks and then months cap the longest string instead of letting the
 * oldest row decide it.
 *
 * `yesterday` is elapsed rather than calendar — 24 to 48 hours, not "the
 * previous date". That keeps this a pure function of two numbers, with no
 * timezone and no `Date`, and it costs one arguable reading: something from
 * 11pm last night says `10 hr ago` at 9am, which is the more precise of the
 * two answers.
 */
export function formatLastUsed(usedAt: number, now: number): string {
  // Clock skew, for `formatRelativeTime`'s reason: "in -3s" is a bug report.
  const elapsed = Math.max(0, now - usedAt);

  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} hr ago`;
  if (elapsed < 2 * DAY) return 'yesterday';
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)} days ago`;
  if (elapsed < MONTH) return `${Math.floor(elapsed / WEEK)} wk ago`;
  return `${Math.floor(elapsed / MONTH)} mo ago`;
}

/** How often to recompute, given how old the thing already is. */
function cadence(elapsed: number): number {
  if (elapsed < MINUTE) return 15_000;
  if (elapsed < HOUR) return 30_000;
  return 5 * MINUTE;
}

/**
 * The clock both labels are measured against, repainting on the cadence above.
 *
 * Shared rather than duplicated per vocabulary: the ticking is the load-bearing
 * half of this module — a pure formatter would fix the *lie* and not the
 * *staleness* — and two copies of it is how one surface comes to stop updating
 * while the other keeps going.
 */
function useTickingNow(since: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    /**
     * `setTimeout` rescheduled per tick, not `setInterval`.
     *
     * The cadence depends on the age, which changes — an interval fixed at
     * mount would keep a day-old row on the fifteen-second schedule it was
     * created with if it happened to be new when the card mounted.
     */
    let timer: ReturnType<typeof setTimeout>;

    const schedule = (): void => {
      const current = Date.now();
      setNow(current);
      timer = setTimeout(schedule, cadence(Math.max(0, current - since)));
    };

    timer = setTimeout(schedule, cadence(Math.max(0, Date.now() - since)));
    return () => clearTimeout(timer);
  }, [since]);

  return now;
}

export function useRelativeTime(createdAt: number): string {
  return formatRelativeTime(createdAt, useTickingNow(createdAt));
}

/** {@link formatLastUsed}, kept current — the fleet table's `LAST USED` cell. */
export function useLastUsed(usedAt: number): string {
  return formatLastUsed(usedAt, useTickingNow(usedAt));
}
