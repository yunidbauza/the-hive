/**
 * The prototype's clock (story 053).
 *
 * Every feed item is stamped from here rather than from `new Date()`, for two
 * reasons. A demo recorded at 03:11 should not say so — the seeded feed opens
 * at 14:37 and the story continues from 14:38. And a wall clock makes the
 * store's own tests unassertable: `expect(feed[0].time)` would have to match a
 * moving target.
 *
 * Lives in `lib/` rather than `features/activity-feed/` because `stores/` is
 * what stamps items on spawn and send, and the lint zone forbids
 * `stores/ → features/`. `lib/` is leaf-level, which is exactly what a clock
 * should be.
 *
 * `reset()` is the reason this is a module with a function rather than an
 * exported `let`: story 053 requires tests to be able to rewind it, and
 * `reset()` is called by the hive-store's own `reset()`.
 */

/** Where the demo's story starts — one minute after the last seeded feed item. */
export const FAKE_CLOCK_START = '14:38';

const MINUTES_PER_DAY = 24 * 60;
const START_MINUTES = 14 * 60 + 38;

let minutes = START_MINUTES;

const format = (value: number): string => {
  const wrapped = ((value % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(wrapped / 60);
  const mins = wrapped % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
};

/** The current time, then advance one minute. */
export function stamp(): string {
  const label = format(minutes);
  minutes += 1;
  return label;
}

/** The current time, without advancing — for assertions and debugging. */
export function peek(): string {
  return format(minutes);
}

/** Rewind to 14:38. Called by the hive-store's `reset()` and by tests. */
export function reset(): void {
  minutes = START_MINUTES;
}
