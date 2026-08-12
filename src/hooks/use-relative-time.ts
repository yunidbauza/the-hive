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

/** How often to recompute, given how old the thing already is. */
function cadence(elapsed: number): number {
  if (elapsed < MINUTE) return 15_000;
  if (elapsed < HOUR) return 30_000;
  return 5 * MINUTE;
}

export function useRelativeTime(createdAt: number): string {
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
      timer = setTimeout(schedule, cadence(Math.max(0, current - createdAt)));
    };

    timer = setTimeout(schedule, cadence(Math.max(0, Date.now() - createdAt)));
    return () => clearTimeout(timer);
  }, [createdAt]);

  return formatRelativeTime(createdAt, now);
}
