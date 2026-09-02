/**
 * How wide the two rails are allowed to be (HIVE-105).
 *
 * The rails used to be four numbers in `tokens.css` and nothing else. This
 * module is what makes them draggable without letting a drag eat the terminal:
 * one pure function owns every bound, so "can the stage be starved?" is
 * answered by reading {@link clampRailWidths} rather than by auditing three
 * components.
 *
 * Pure, and deliberately in `lib/` rather than in `appearance-store.ts`. The
 * store holds *what the user chose*; this holds *what is allowed*, which
 * depends on the window and on which rails are mounted — neither of which is
 * store state. Keeping them apart is also what lets the whole rule set be
 * tested without a store, a DOM, or a render.
 */

/**
 * The narrowest each rail may be, per density — and, deliberately, also each
 * rail's **default**.
 *
 * The two being the same number is the decision HIVE-105 records: a rail grows
 * from where it is today and never shrinks below it. That equality is load
 * bearing elsewhere — {@link isRailDefault} uses it to decide when the inline
 * override can be removed entirely and the stylesheet allowed to take over
 * again — so it is stated here once rather than rediscovered.
 *
 * The left rail was 268px until its tab bar gained an icon per tab: three
 * labelled icons need more line than three words did, and at 268 the third
 * tab ran to the rail's edge. 320 gives the bar its room and the panels under
 * it a wider column; compact keeps the same 36px step down it always had.
 *
 * ## These duplicate `tokens.css`, and the duplication is asserted
 *
 * `--cc-rail-w-left` / `--cc-rail-w-right` remain the values the rails actually
 * paint with; these are the same numbers in a form the clamp can do arithmetic
 * on. Reading them back out of the stylesheet at runtime was the alternative
 * and is worse: `getComputedStyle` returns an empty string in a unit test,
 * where no stylesheet is loaded, so every consumer would need a fallback
 * constant anyway — which is this constant, minus the guarantee.
 *
 * `tests/lib/rail-width.test.ts` parses `tokens.css` and asserts the four
 * numbers match. Change one without the other and that test fails, which is the
 * only reason it is safe to write them twice.
 */
export const RAIL_MIN = {
  comfortable: { left: 320, right: 316 },
  compact: { left: 284, right: 276 },
} as const;

/**
 * A collapsed rail: wide enough for a 20px icon in a 34px hit target.
 *
 * Density-invariant, unlike {@link RAIL_MIN}. That pair varies with density
 * because a *panel's* content needs room; a strip's content is one icon, which
 * is the same size in both densities. A second pair here would be two constants
 * expressing one fact.
 */
export const RAIL_STRIP = 44;

/**
 * What a rail is doing right now.
 *
 * `hidden` is the pre-existing `showActivityRail: false` case, kept so
 * `clampRailWidths` keeps reporting `0` for an unmounted rail. Nothing produces
 * it today except `ui-store`'s `showActivityRail`, which no UI sets to false —
 * see the spec's "The showActivityRail question".
 */
export type RailDisplay = 'expanded' | 'collapsed' | 'hidden';

/** One density's pair of minimums — what {@link clampRailWidths} is handed. */
export interface RailMinimums {
  left: number;
  right: number;
}

/**
 * The widest one rail may be: the smaller of a share of the window and a hard
 * ceiling.
 *
 * Two bounds rather than one because either alone is wrong at some size. A pure
 * percentage makes 30% of a 2560px display a 768px rail — wider than any panel
 * in this app has content for. A pure pixel cap makes 520px most of a 1100px
 * window, which is the narrowest the app opens at.
 */
export const RAIL_MAX_FRACTION = 0.3;
export const RAIL_MAX_PX = 520;

/**
 * The centre stage's guaranteed share of the window.
 *
 * **This is the invariant the whole module exists to protect.** The terminal is
 * the point of the app; the rails are how you decide which terminal. No
 * arrangement of stored widths may leave the stage less than this.
 */
export const STAGE_MIN_FRACTION = 0.2;

/**
 * The narrowest window at which both rails can sit at their minimum and the
 * stage still keep its share — `(left + right) / (1 - 0.2)`.
 *
 * At comfortable density that is 795px, against a `MIN_WINDOW_SIZE.width` of
 * 1100px, so the desktop app cannot reach the reducing branch of
 * {@link clampRailWidths} at all. That headroom is not a coincidence to be
 * relied on quietly: `tests/lib/rail-width.test.ts` asserts
 * `MIN_WINDOW_SIZE.width >= railFloorWindowWidth(RAIL_MIN.comfortable)`, so
 * narrowing the window minimum or widening a rail minimum fails the build
 * rather than silently breaching the stage floor.
 */
export function railFloorWindowWidth(
  min: RailMinimums,
  left: RailDisplay = 'expanded',
  right: RailDisplay = 'expanded',
): number {
  const claim = (display: RailDisplay, expanded: number): number => {
    if (display === 'hidden') return 0;
    return display === 'collapsed' ? RAIL_STRIP : expanded;
  };

  return (claim(left, min.left) + claim(right, min.right)) / (1 - STAGE_MIN_FRACTION);
}

export interface RailWidthInput {
  /**
   * What the user dragged to, or `null` for "follow density".
   *
   * These are *intent*, not what gets painted. A width that does not fit the
   * current window is clamped on the way to the screen and left alone in the
   * store, so shrinking a window and growing it back returns the rail to the
   * width that was actually chosen rather than to whatever the narrow moment
   * allowed.
   */
  storedLeft: number | null;
  storedRight: number | null;
  /** The active density's minimums — `RAIL_MIN[density]`. */
  min: RailMinimums;
  /** The width the two rails and the stage are dividing up. */
  windowWidth: number;
  /**
   * What each rail is doing. `collapsed` claims {@link RAIL_STRIP} and
   * `hidden` claims nothing; only `expanded` consults the stored width.
   *
   * Note what this does *not* do: {@link railMaxWidth} is a per-rail ceiling
   * and never consults these, so collapsing one rail does not let the other
   * grow wider. What it frees is budget, which only matters in the reducing
   * branch below.
   */
  left: RailDisplay;
  right: RailDisplay;
}

export interface RailWidths {
  left: number;
  /** `0` exactly when the activity rail is `hidden`; {@link RAIL_STRIP} when it is `collapsed`. */
  right: number;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/**
 * The widest a single rail may be right now, before the other rail is
 * considered. Exported because the drag handles need it for `aria-valuemax` and
 * to stop the gesture at the same place the clamp would.
 */
export function railMaxWidth(windowWidth: number): number {
  if (!Number.isFinite(windowWidth) || windowWidth <= 0) return RAIL_MAX_PX;
  return Math.min(windowWidth * RAIL_MAX_FRACTION, RAIL_MAX_PX);
}

/**
 * Turn stored intent into the widths that actually get painted.
 *
 * Three rules, applied in a fixed order, and **the order is the specification**:
 *
 * 1. Each rail is held to `[min, railMaxWidth]`.
 * 2. The two together may not exceed `windowWidth * (1 - STAGE_MIN_FRACTION)`.
 * 3. Rule 2 outranks rule 1.
 *
 * Rule 3 is the subtle one. The obvious implementation —
 * `Math.max(min, Math.min(max, w))` per rail — silently prefers the rails,
 * because a per-rail clamp cannot see the other rail. So the budget is applied
 * afterwards, and when even the two minimums do not fit, the minimums are what
 * give.
 *
 * What is *not* here is a second, gentler reduction that takes width back from
 * a rail the user widened before touching one still at its default. That was
 * written, and then removed on discovering it could never run: rule 1 already
 * caps each rail at 30% of the window, so two rails at their widest come to
 * 60% and the 80% budget is never in danger. Only a window too narrow for the
 * two *defaults* can breach the floor. Keeping the branch would have meant
 * shipping — and pretending to test — code with no reachable input.
 *
 * That leaves one reduction, and it is the honest one: below
 * {@link railFloorWindowWidth} the minimums themselves are scaled down. The
 * desktop app cannot get there, since its window will not open below 1100px
 * against the 795px this needs; the browser target (`pnpm dev`) has no window
 * minimum and can, and the stage keeps its fifth there too.
 */
export function clampRailWidths({
  storedLeft,
  storedRight,
  min,
  windowWidth,
  left: leftDisplay,
  right: rightDisplay,
}: RailWidthInput): RailWidths {
  /*
    Rule 0, and it outranks everything below.

    A collapsed rail is not expressing a width preference that could be
    overruled — it is expressing the absence of one. Running it through the
    `Math.max(min.left, …)` below would floor a 44px strip back up to 320px,
    which is precisely the bug this ordering prevents. The stored width is left
    untouched throughout, exactly as a window resize leaves it untouched:
    expanding must return the rail to the width the user actually chose.
  */
  const fixed = (display: RailDisplay): number | null => {
    if (display === 'collapsed') return RAIL_STRIP;
    return display === 'hidden' ? 0 : null;
  };

  const fixedLeft = fixed(leftDisplay);
  const fixedRight = fixed(rightDisplay);
  const minLeft = fixedLeft ?? min.left;
  const minRight = fixedRight ?? min.right;

  /*
    No usable window to measure against — SSR, a unit test, the first frame
    before layout. The defaults are the only honest answer, and they are what
    the stylesheet is already painting.
  */
  if (!Number.isFinite(windowWidth) || windowWidth <= 0) {
    return { left: minLeft, right: minRight };
  }

  const max = railMaxWidth(windowWidth);

  /*
    `Math.max(min, …)` last, so a window narrow enough to put `max` below `min`
    still yields the minimum here. Rule 2 below is what resolves that case; it
    must not be pre-empted by a per-rail clamp quietly returning `max`.
  */
  const left =
    fixedLeft ?? Math.max(min.left, clamp(storedLeft ?? min.left, min.left, max));
  const right =
    fixedRight ?? Math.max(min.right, clamp(storedRight ?? min.right, min.right, max));

  const budget = windowWidth * (1 - STAGE_MIN_FRACTION);
  const total = left + right;

  if (total <= budget) {
    return { left: Math.floor(left), right: Math.floor(right) };
  }

  /*
    Rule 3 — the reducing branch, reached only when the two *minimums* do not
    fit. A fixed rail is exempt: a strip is not a minimum and scaling it would
    paint a 30px sliver with a clipped icon in it. Only what is negotiable
    gives, which is what was already true before collapse existed.

    That is worth proving rather than asserting, because it is why this is one
    branch and not two. A rail is already capped at `RAIL_MAX_FRACTION` of the
    window, so two rails at their widest come to `2 x 0.3 = 0.6` of it, safely
    under the `0.8` the stage floor leaves them. Wherever a minimum exceeds that
    cap the totals are smaller still. So no combination of *stored* widths can
    reach here; only a window too narrow for the defaults can, and then what
    gives is the minimums.

    `railWidthConstantsHold` states the inequality the argument rests on, and
    the test suite asserts it — raise `RAIL_MAX_FRACTION` past that point and
    the proof fails loudly instead of this quietly becoming the wrong shape.
  */
  const negotiable = (fixedLeft === null ? left : 0) + (fixedRight === null ? right : 0);
  const room = budget - (fixedLeft ?? 0) - (fixedRight ?? 0);
  const scale = negotiable > 0 ? Math.max(0, room) / negotiable : 1;

  return {
    left: fixedLeft ?? Math.floor(left * scale),
    right: fixedRight ?? Math.floor(right * scale),
  };
}

/**
 * The inequality {@link clampRailWidths} relies on: two rails at their widest
 * still leave the stage its floor.
 *
 * Exported so it can be asserted rather than believed. It is not called at
 * runtime — nothing should branch on it — but a change to either constant that
 * breaks the reasoning in `clampRailWidths` fails a test the same day it lands.
 */
export const railWidthConstantsHold = (): boolean =>
  2 * RAIL_MAX_FRACTION <= 1 - STAGE_MIN_FRACTION;

/**
 * Whether a painted width is exactly the stylesheet's own value.
 *
 * True means the inline custom property can be removed rather than written, so
 * `tokens.css` — and with it a later density change — takes over again with no
 * JavaScript involved. See {@link RAIL_MIN} on why "the minimum" and "the
 * default" are the same number.
 */
export function isRailDefault(width: number, min: number): boolean {
  return width === min;
}
