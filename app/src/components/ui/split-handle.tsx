import { useCallback, type RefObject } from 'react';

import { cn } from '@/lib/utils';

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
  /** The element the ratio is measured against — the flex container. */
  containerRef: RefObject<HTMLElement | null>;
  /** The current ratio, 0–1, for the keyboard step and the ARIA value. */
  ratio: number;
  onRatio: (ratio: number) => void;
}

/** How far one arrow-key press moves the divider. */
const KEY_STEP = 0.02;

/**
 * The draggable seam between two panes.
 *
 * ## Why pointer events on `window`
 *
 * A drag that listens on the handle itself stops tracking the moment the
 * pointer outruns it — which, on a fast drag, is immediately. Listening on
 * `window` for the duration of the gesture is what makes the divider follow the
 * cursor rather than being escaped by it. `setPointerCapture` is the other
 * answer and needs the element to survive the gesture; a re-render that
 * replaces the node mid-drag silently drops the capture, and this node
 * re-renders on every ratio change by construction.
 *
 * ## Why it is a `separator` with a `tabIndex`
 *
 * A split a mouse can move and a keyboard cannot is a setting only some users
 * have. `role="separator"` with `aria-valuenow` is the ARIA pattern for exactly
 * this, and the arrow keys make it real.
 *
 * The hit area is deliberately larger than the visible line: a 1px target is
 * unhittable, so the element is 5px of transparent padding around a hairline
 * that only shows on hover.
 */
export function SplitHandle({
  axis,
  containerRef,
  ratio,
  onRatio,
}: SplitHandleProps) {
  const vertical = axis === 'vertical';

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;

      // Stops the gesture from selecting text in either pane while dragging.
      event.preventDefault();

      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const onMove = (move: PointerEvent) => {
        onRatio(
          vertical
            ? (move.clientX - rect.left) / rect.width
            : (move.clientY - rect.top) / rect.height,
        );
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
    [containerRef, onRatio, vertical],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const back = vertical ? 'ArrowLeft' : 'ArrowUp';
      const forward = vertical ? 'ArrowRight' : 'ArrowDown';

      if (event.key === back) {
        event.preventDefault();
        onRatio(ratio - KEY_STEP);
      } else if (event.key === forward) {
        event.preventDefault();
        onRatio(ratio + KEY_STEP);
      }
    },
    [onRatio, ratio, vertical],
  );

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
      aria-label="Resize the editor"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={cn(
        'group relative shrink-0 bg-border-soft focus-visible:bg-brand focus-visible:outline-none',
        vertical ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
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
