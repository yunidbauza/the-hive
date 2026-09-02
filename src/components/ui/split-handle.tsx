import { useCallback, type RefObject } from 'react';

import { cn } from '@/lib/utils';

/**
 * How a pointer position inside the container becomes a value.
 *
 * The three exist because the same gesture means three different numbers
 * depending on what is being resized:
 *
 * - `ratio` — the seam's position as a fraction of the container, which is what
 *   a two-pane split is. The editor's divider.
 * - `px-from-start` — distance from the container's left/top edge, which is the
 *   width of a pane pinned to that edge. The left rail.
 * - `px-from-end` — distance from the right/bottom edge, for a pane pinned to
 *   the far side. The activity rail, whose width grows as the pointer moves
 *   *left*.
 */
export type SplitScale = 'ratio' | 'px-from-start' | 'px-from-end';

interface SplitHandleProps {
  /**
   * `vertical` means a vertical *divider* — panes side by side, dragged on X.
   * `horizontal` means a horizontal divider — panes stacked, dragged on Y.
   *
   * Named after the line rather than after the stacking direction, which is the
   * convention `aria-orientation` uses and the opposite of what CSS `flex-row`
   * would suggest. Worth stating, because getting it backwards produces a
   * divider that drags perpendicular to itself.
   */
  axis: 'horizontal' | 'vertical';
  /** The element the value is measured against — the flex container. */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * What this handle resizes, for screen readers. Required rather than
   * defaulted: an app with three of these needs three different answers, and a
   * default would silently be wrong on two of them.
   */
  label: string;
  /** The current value, in whatever unit {@link scale} implies. */
  value: number;
  onValue: (value: number) => void;
  /** Defaults to `ratio` — the editor's original behaviour, unchanged. */
  scale?: SplitScale;
  /** Bounds for the keyboard, the ARIA range, and the drag itself. */
  min?: number;
  max?: number;
  /** How far one arrow-key press moves the value. */
  step?: number;
  /**
   * Double-click, when there is something to go back to. Omitted by consumers
   * with no notion of a default.
   */
  onReset?: () => void;
  /**
   * A raw value below this collapses instead of resizing.
   *
   * Tested **before** {@link clamp}, deliberately: clamp floors at `min` and
   * would erase the very reading this needs. Omitted by consumers with no
   * notion of a collapsed state — the editor divider passes neither.
   */
  collapseBelow?: number;
  onCollapse?: () => void;
  /** Extra classes for positioning — the rails absolutely-position their handle. */
  className?: string;
}

/** Ratio defaults, preserved from before this component was generalised. */
const RATIO_STEP = 0.02;

/**
 * The draggable seam between two panes, and the drag handle on a rail's edge.
 *
 * ## Why pointer events on `window`
 *
 * A drag that listens on the handle itself stops tracking the moment the
 * pointer outruns it — which, on a fast drag, is immediately. Listening on
 * `window` for the duration of the gesture is what makes the divider follow the
 * cursor rather than being escaped by it. `setPointerCapture` is the other
 * answer and needs the element to survive the gesture; a re-render that
 * replaces the node mid-drag silently drops the capture, and this node
 * re-renders on every value change by construction.
 *
 * ## Why it is a `slider` with a `tabIndex`
 *
 * A split a mouse can move and a keyboard cannot is a setting only some users
 * have. `role="slider"` with `aria-valuenow` is the ARIA pattern for exactly
 * this, and the arrow keys make it real.
 *
 * The hit area is deliberately larger than the visible line: a 1px target is
 * unhittable, so the element is 5px of transparent padding around a hairline
 * that only shows on hover.
 *
 * ## Why it takes a scale rather than being copied
 *
 * HIVE-105 needed the same gesture on the two rails, in pixels rather than as a
 * ratio. Everything above — the window listeners, the `pointercancel`
 * teardown, the ARIA range, the hit area — is identical for a rail; only the
 * arithmetic turning a pointer position into a number differs, and that is
 * three lines. {@link SplitScale} is those three lines.
 */
export function SplitHandle({
  axis,
  containerRef,
  label,
  value,
  onValue,
  scale = 'ratio',
  min = 0,
  max = scale === 'ratio' ? 1 : Number.POSITIVE_INFINITY,
  step = scale === 'ratio' ? RATIO_STEP : 8,
  onReset,
  collapseBelow,
  onCollapse,
  className,
}: SplitHandleProps) {
  const vertical = axis === 'vertical';

  /*
    `Math.max(min, …)` outermost, so that a window narrow enough to put `max`
    below `min` yields the minimum rather than something under it. The intuitive
    ordering returns `max` there — a number smaller than the smallest legal one,
    which the consumer then has to correct back up. Same precedence as
    `clampRailWidths`, and for the same reason.
  */
  const clamp = useCallback(
    (next: number) => Math.max(min, Math.min(max, next)),
    [max, min],
  );

  /**
   * Returns true when the gesture has gone past the collapse threshold and has
   * been handled. The caller must then *not* call `onValue` — writing a width
   * for a rail that is collapsing is what would leave the two disagreeing.
   */
  const tookCollapse = useCallback(
    (raw: number) => {
      if (collapseBelow === undefined || onCollapse === undefined) return false;
      if (raw >= collapseBelow) return false;
      onCollapse();
      return true;
    },
    [collapseBelow, onCollapse],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;

      // Stops the gesture from selecting text in either pane while dragging.
      event.preventDefault();

      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const onMove = (move: PointerEvent) => {
        const size = vertical ? rect.width : rect.height;
        const fromStart = vertical ? move.clientX - rect.left : move.clientY - rect.top;

        const raw =
          scale === 'ratio'
            ? fromStart / size
            : scale === 'px-from-start'
              ? fromStart
              : size - fromStart;

        if (tookCollapse(raw)) return;
        onValue(clamp(raw));
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      /**
       * `pointercancel` too: the OS takes the pointer away on a three-finger
       * swipe or a window drag, and without this the move listener would
       * survive the gesture and keep resizing on the next unrelated mouse
       * movement.
       */
      window.addEventListener('pointercancel', onUp);
    },
    [clamp, containerRef, onValue, scale, tookCollapse, vertical],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const back = vertical ? 'ArrowLeft' : 'ArrowUp';
      const forward = vertical ? 'ArrowRight' : 'ArrowDown';

      /*
        `px-from-end` grows as the pointer moves back along the axis, so its
        arrow keys are inverted too — otherwise the activity rail would shrink
        on ArrowRight while visibly following the cursor the other way.
      */
      const sign = scale === 'px-from-end' ? -1 : 1;

      const move = (to: number) => {
        event.preventDefault();

        if (tookCollapse(to)) return;

        /*
          The keyboard's own route to collapse, mirroring the stop the drag
          already has: a rail already at its floor has nowhere further to
          shrink *to*, so `clamp` below would just return `value` again and the
          key would silently do nothing forever. `tookCollapse` alone cannot
          catch this — its raw threshold sits *below* `min`, a reading the
          keyboard can never produce because `clamp` never lets `value` fall
          there in the first place.

          `to < value` is the direction-agnostic way to ask "is this press
          trying to shrink further?": `sign` has already been folded into `to`
          by the caller, so it reads the same way for `px-from-start`'s
          ArrowLeft and `px-from-end`'s inverted ArrowRight.

          `min < max` excludes the one state where `value <= min` is true for a
          reason that has nothing to do with a floor: a window too narrow for
          the rail's own minimum, where `use-rail-widths.ts`'s `bounds` reduces
          `min` (and `max` right along with it) to the single width that still
          fits. There `min === max === value` — the whole range has collapsed
          to a point, not stopped at an edge — and the key is correctly inert,
          the same "no room to move" outcome the effective-minimum fix already
          established. A genuine floor leaves `max` above `min` — though not
          always by much: at the desktop's 1100px minimum the left rail's range
          is 320–330, a single arrow step, because `railMaxWidth` is 30% of the
          window. `rail-width.test.ts` pins that the range is still open there.
        */
        if (
          collapseBelow !== undefined &&
          onCollapse !== undefined &&
          min < max &&
          value <= min &&
          to < value
        ) {
          onCollapse();
          return;
        }

        const next = clamp(to);
        /*
          A key that cannot move the value must not report one. Where the bounds
          have collapsed — a rail already at the stop, or squeezed to a single
          legal width by a narrow window — the clamp returns exactly `value`,
          and passing that on would still be a *write*: enough to turn a rail
          that was following the stylesheet into one carrying an explicit width
          nobody chose.

          Only the keyboard is guarded. `value` is fresh from render here, while
          the drag's `pointermove` closure captures it at `pointerdown` and would
          be comparing against a stale number by its second event. A drag is also
          an unambiguous intent to set a width, where an arrow key that visibly
          does nothing is not.
        */
        if (next !== value) onValue(next);
      };

      if (event.key === back) {
        move(value - step * sign);
      } else if (event.key === forward) {
        move(value + step * sign);
      }
    },
    [
      clamp,
      collapseBelow,
      max,
      min,
      onCollapse,
      onValue,
      scale,
      step,
      tookCollapse,
      value,
      vertical,
    ],
  );

  /*
    A ratio announces as a percentage, which is what it was before this
    component was generalised and what the pattern reads best as. A pixel width
    announces as pixels; rounding keeps a sub-pixel drag from reading out
    fourteen decimal places.
  */
  const toAria = (n: number) =>
    Number.isFinite(n) ? Math.round(scale === 'ratio' ? n * 100 : n) : undefined;

  return (
    /*
      A `<button>` carrying `role="slider"`.

      Two rejected alternatives, because the choice looks arbitrary otherwise:

      - **A `<div role="separator" tabIndex={0}>`.** ARIA's *focusable*
        separator is arguably the most precise role for a split, but a div with
        handlers is a non-interactive element pretending to be one — it needs
        its own focus styling and key handling to behave, and `jsx-a11y`
        rejects it for exactly that reason.
      - **A `<button role="separator">`.** ARIA treats a focusable separator as
        interactive; the linter's role table does not, so this trades one error
        for another and buys nothing.

      `slider` is what this control actually is: a focusable thing whose arrow
      keys move a bounded value, which is precisely what `aria-valuenow`,
      `aria-valuemin` and `aria-valuemax` below describe. It announces
      usefully, it is interactive by every definition, and it needs no
      suppression to say so.
    */
    <button
      type="button"
      role="slider"
      /*
        Inverted relative to the prop name, deliberately. `axis` names the
        *divider* — a vertical divider separates side-by-side panes — but
        `aria-orientation` on a slider names the direction the **value moves**,
        which for a vertical divider is horizontal. Getting this the intuitive
        way round announces the opposite of the arrow keys that actually work.
      */
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuenow={toAria(value)}
      aria-valuemin={toAria(min)}
      aria-valuemax={toAria(max)}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className={cn(
        /*
          `z-10` is what makes the hit area below real rather than nominal.

          The span overflows this 1px button by 2px on each side, into the panes
          either side — and those panes have their own backgrounds and come
          later in the DOM, so without a stacking order they paint over the
          overflow and swallow its pointer events. The control then has exactly
          the 1px target the enlarged area exists to avoid, which a browser test
          reports as the neighbouring pane "intercepting pointer events".
        */
        'group relative z-10 shrink-0 bg-border-soft focus-visible:bg-brand focus-visible:outline-none',
        vertical ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
        className,
      )}
    >
      {/* The hit area. Transparent, centred on the hairline, five times wider. */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute group-hover:bg-brand',
          vertical ? '-inset-x-[2px] inset-y-0' : 'inset-x-0 -inset-y-[2px]',
        )}
      />
    </button>
  );
}
