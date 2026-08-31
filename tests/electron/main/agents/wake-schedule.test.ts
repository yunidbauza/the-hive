// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  inQuiet,
  minutesOf,
  nextRunFrom,
  quietEndAfter,
} from '../../../../electron/main/agents/wake-schedule';
import type { WakeSpec } from '../../../../electron/shared/agent-contract';

/**
 * A local-time constructor, so every case below reads as the clock a person
 * sees rather than as an offset from UTC.
 *
 * Every function under test is deliberately local-time: there is no server to
 * hold another opinion, and somebody who writes `23:00-07:00` means their own
 * night. Building the fixtures the same way is what keeps the tests honest
 * wherever they run.
 */
const at = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): number => new Date(year, month - 1, day, hour, minute, 0, 0).getTime();

describe('minutesOf', () => {
  it('reads a wall clock as minutes past midnight', () => {
    expect(minutesOf('00:00')).toBe(0);
    expect(minutesOf('09:30')).toBe(570);
    expect(minutesOf('23:59')).toBe(1439);
  });
});

describe('inQuiet', () => {
  const night = { from: '23:00', to: '07:00' };
  const day = { from: '09:00', to: '17:00' };

  it('holds inside a window that wraps midnight, on both sides of it', () => {
    expect(inQuiet(minutesOf('23:30'), night)).toBe(true);
    expect(inQuiet(minutesOf('02:00'), night)).toBe(true);
  });

  it('excludes the daylight the window wraps around', () => {
    expect(inQuiet(minutesOf('12:00'), night)).toBe(false);
  });

  it('holds inside an ordinary same-day window', () => {
    expect(inQuiet(minutesOf('12:00'), day)).toBe(true);
    expect(inQuiet(minutesOf('08:00'), day)).toBe(false);
  });

  /*
    Half-open, and pinned deliberately: `from` is inside the window and `to` is
    outside it. That is what makes `quietEndAfter` answer a moment the agent
    may actually run, rather than one more minute of silence for the next tick
    to notice — and it is what lets `at: [07:00]` coexist with a window ending
    at 07:00, which is the commonest morning schedule there is.
  */
  it('includes its start and excludes its end', () => {
    expect(inQuiet(minutesOf('23:00'), night)).toBe(true);
    expect(inQuiet(minutesOf('07:00'), night)).toBe(false);
  });
});

describe('quietEndAfter', () => {
  const night = { from: '23:00', to: '07:00' };

  it('answers this morning when the window is still running', () => {
    expect(quietEndAfter(at(2026, 8, 31, 2, 15), night)).toBe(at(2026, 8, 31, 7));
  });

  it('answers tomorrow morning when the window started tonight', () => {
    expect(quietEndAfter(at(2026, 8, 31, 23, 30), night)).toBe(at(2026, 9, 1, 7));
  });

  it('answers the same day for a window that does not wrap', () => {
    expect(quietEndAfter(at(2026, 8, 31, 12), { from: '09:00', to: '17:00' })).toBe(
      at(2026, 8, 31, 17),
    );
  });

  /*
    A calendar day, not 86,400,000 ms — they differ twice a year.

    Adding a fixed day across a spring-forward lands an hour late: an agent
    kept asleep past the window its author wrote, with nothing to correct it,
    because every later tick just sees a `nextRunAt` it has not reached.

    Written as a wall-clock assertion so it holds in any zone: whatever
    07:00 the next morning is locally, that is the answer. In a zone with no
    DST it still passes — it is simply not exercising the difference.
  */
  it('lands on the next local 07:00 even across a spring-forward', () => {
    const answer = new Date(
      quietEndAfter(at(2026, 3, 7, 23, 30), { from: '23:00', to: '07:00' }),
    );

    expect(answer.getHours()).toBe(7);
    expect(answer.getMinutes()).toBe(0);
    expect(answer.getDate()).toBe(8);
  });

  it('lands on the next local 07:00 across an autumn fall-back too', () => {
    const answer = new Date(
      quietEndAfter(at(2026, 10, 31, 23, 30), { from: '23:00', to: '07:00' }),
    );

    expect(answer.getHours()).toBe(7);
    expect(answer.getDate()).toBe(1);
  });
});

describe('nextRunFrom — interval mode', () => {
  it('adds the interval to the moment given', () => {
    const spec: WakeSpec = { everyMs: 300_000, on: [] };

    expect(nextRunFrom(spec, at(2026, 8, 31, 18, 15))).toBe(at(2026, 8, 31, 18, 20));
  });

  /*
    The floor, applied here as well as in the parser.

    `parseAgent` refuses a sub-minute interval, so this is only reachable from
    a hand-edited `agents.json` or a spec built in code — but a tick that armed
    at 30s would double the wake rate of the one thing the grammar most wants
    bounded, and the clamp costs one `Math.max`.
  */
  it('clamps below the one-minute floor', () => {
    const spec: WakeSpec = { everyMs: 30_000, on: [] };

    expect(nextRunFrom(spec, at(2026, 8, 31, 18, 15))).toBe(at(2026, 8, 31, 18, 16));
  });
});

describe('nextRunFrom — calendar mode', () => {
  it('answers the next time today when one is still ahead', () => {
    const spec: WakeSpec = { at: ['09:00', '17:00'], on: [] };

    expect(nextRunFrom(spec, at(2026, 8, 31, 10))).toBe(at(2026, 8, 31, 17));
  });

  it('rolls to tomorrow when every time today has passed', () => {
    const spec: WakeSpec = { at: ['09:00', '17:00'], on: [] };

    expect(nextRunFrom(spec, at(2026, 8, 31, 18))).toBe(at(2026, 9, 1, 9));
  });

  /* 2026-08-31 is a Monday; the next Wednesday is 2026-09-02. */
  it('skips days the spec does not name, and crosses a month to do it', () => {
    const spec: WakeSpec = { at: ['09:00'], days: ['wed'], on: [] };

    expect(nextRunFrom(spec, at(2026, 8, 31, 10))).toBe(at(2026, 9, 2, 9));
  });

  it('treats no days as every day', () => {
    const spec: WakeSpec = { at: ['09:00'], on: [] };

    expect(nextRunFrom(spec, at(2026, 8, 31, 10))).toBe(at(2026, 9, 1, 9));
  });

  it('finds today when today is a named day and the time is still ahead', () => {
    const spec: WakeSpec = { at: ['17:00'], days: ['mon'], on: [] };

    expect(nextRunFrom(spec, at(2026, 8, 31, 10))).toBe(at(2026, 8, 31, 17));
  });

  /*
    A week out and no further. `days: ['mon']` asked on a Monday afternoon has
    to reach the *following* Monday, which is the seventh day ahead — one short
    and this would answer `undefined` for a perfectly ordinary schedule.
  */
  it('reaches the same weekday a full week later', () => {
    const spec: WakeSpec = { at: ['09:00'], days: ['mon'], on: [] };

    expect(nextRunFrom(spec, at(2026, 8, 31, 10))).toBe(at(2026, 9, 7, 9));
  });
});

describe('nextRunFrom — no schedule', () => {
  it('answers undefined for a spec that names neither mode', () => {
    expect(nextRunFrom({ on: ['ledger'] }, at(2026, 8, 31, 10))).toBeUndefined();
  });

  it('answers undefined for an empty time list', () => {
    expect(nextRunFrom({ at: [], on: [] }, at(2026, 8, 31, 10))).toBeUndefined();
  });
});
