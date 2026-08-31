import {
  WAKE_DAYS,
  WAKE_EVERY_FLOOR_MS,
  type WakeDay,
  type WakeSpec,
} from '@shared/agent-contract';

/**
 * When a wake is due, and when it must not be (HIVE-121).
 *
 * Pure, and separate from `scheduler.ts` for the reason `scheduler-rules.ts`
 * is separate from it: the scheduler's job is to read state, decide, and write
 * back, while every question below is answerable from a clock and a definition
 * alone. Split out, midnight wrap and a schedule that crosses into a new month
 * are table rows rather than fixtures wrapped around a fake timer.
 *
 * Everything here is **local** time. There is no server to hold another
 * opinion, and the person who wrote `23:00-07:00` meant their own night.
 *
 * `dayKey` is deliberately *not* here — it lives in `agent-contract.ts`,
 * because the renderer needs the same boundary and `src/**` may not import
 * `electron/main/**`.
 */

/** `'23:30'` → `1410`. The grammar has already proved the shape. */
export const minutesOf = (time: string): number => {
  const [hour, minute] = time.split(':');

  return Number(hour) * 60 + Number(minute);
};

/**
 * Is this minute of the day inside the window?
 *
 * Half-open — `from` is inside, `to` is outside — so the moment the window
 * ends is a moment a wake may happen, rather than one more minute of silence
 * for the next tick to notice. It is also what lets `at: [07:00]` coexist with
 * a window ending at 07:00, which the parser would otherwise refuse.
 *
 * The wrap case is the whole reason this exists. `parseRange` validates two
 * `HH:MM` strings and compares nothing, so `23:00-07:00` arrives here as an
 * interval whose end is *smaller* than its start: read as a plain range it is
 * empty, and read as a wrap it is the eight hours a person actually meant.
 */
export function inQuiet(
  minutes: number,
  quiet: { from: string; to: string },
): boolean {
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);

  return from <= to
    ? minutes >= from && minutes < to
    : minutes >= from || minutes < to;
}

/**
 * The moment this window ends — what `nextRunAt` becomes inside quiet hours,
 * rather than `now + every`.
 *
 * Deferring to the window's end rather than to the next interval is what stops
 * a five-minute agent spending the whole night re-deciding to stay asleep, and
 * it is what makes the `Next` tile read as the promise it is: the time you can
 * expect it back.
 */
export function quietEndAfter(
  at: number,
  quiet: { from: string; to: string },
): number {
  const end = new Date(at);
  const [hour, minute] = quiet.to.split(':');

  end.setHours(Number(hour), Number(minute), 0, 0);

  /*
    Already past today's end: the window wrapped, so its end is tomorrow's.

    Advanced by a calendar **day** rather than by 86,400,000 ms, because those
    are not the same thing twice a year. Across a spring-forward, adding a
    fixed day to 07:00 EST lands on 08:00 EDT — an agent left asleep a whole
    hour past the window its author wrote, with nothing to correct it, since
    every later tick simply sees a `nextRunAt` it has not reached. `setDate`
    keeps the wall clock the person meant.
  */
  if (end.getTime() <= at) end.setDate(end.getDate() + 1);

  return end.getTime();
}

/** Monday-first, matching `WAKE_DAYS` — `getDay()` is Sunday-first. */
const dayOf = (date: Date): WakeDay => WAKE_DAYS[(date.getDay() + 6) % 7] as WakeDay;

/**
 * The next moment this spec is due, or `undefined` when it schedules nothing.
 *
 * Interval mode measures from the moment handed in — the last wake, or `now`
 * for an agent that has never run. Calendar mode ignores it beyond "later than
 * this", because a fixed time is a fact about the clock rather than about the
 * last run.
 */
export function nextRunFrom(spec: WakeSpec, from: number): number | undefined {
  if (spec.everyMs !== undefined) {
    return from + Math.max(spec.everyMs, WAKE_EVERY_FLOOR_MS);
  }

  if (spec.at === undefined || spec.at.length === 0) return undefined;

  const times = [...spec.at].sort();
  const days =
    spec.days === undefined || spec.days.length === 0 ? undefined : spec.days;

  /*
    Seven days forward and no further — but seven *inclusive*, which is the
    off-by-one worth stating. `days: ['mon']` asked on a Monday afternoon has
    to reach the following Monday, and that is the seventh day ahead; stopping
    at six would answer `undefined` for an ordinary weekly schedule.

    Bounded at all because an empty `days` the parser somehow let through would
    otherwise loop forever, and answering `undefined` is the better failure.
  */
  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const day = new Date(from);

    day.setDate(day.getDate() + ahead);

    if (days !== undefined && !days.includes(dayOf(day))) continue;

    for (const time of times) {
      const candidate = new Date(day);
      const [hour, minute] = time.split(':');

      candidate.setHours(Number(hour), Number(minute), 0, 0);

      if (candidate.getTime() > from) return candidate.getTime();
    }
  }

  return undefined;
}
