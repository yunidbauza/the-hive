import { useLayoutEffect, type RefObject } from 'react';

/**
 * How tall a prompt row may grow before it starts scrolling instead.
 *
 * Ten rows, and the cap is the point rather than the number. These rows sit
 * *under* the terminal and take their height out of it, so an uncapped textarea
 * makes a pasted stack trace push the thing the user is actually watching off
 * the top of the stage. Ten is enough for a real multi-line message — a commit
 * body, a short list of instructions — and still leaves the terminal the
 * majority of the pane at any usable window size.
 */
export const MAX_GROW_ROWS = 10;

/**
 * Size a `<textarea>` to its content, up to {@link MAX_GROW_ROWS}.
 *
 * ## Why the height is reset before it is read
 *
 * `scrollHeight` reports the content height *or the element's own height,
 * whichever is larger* — so an element that has already grown to 240px reports
 * at least 240px forever, and the row would ratchet upward and never shrink
 * back when the text is deleted. Clearing `height` first lets the element
 * collapse to its natural single-row size, which is the only state in which
 * `scrollHeight` answers the question actually being asked.
 *
 * ## Why `useLayoutEffect`
 *
 * The measurement and the write both happen before paint, so the row never
 * renders at the wrong height. With `useEffect` a long message would show for
 * one frame as a one-line row and then jump — most visible in exactly the case
 * this exists for, a multi-line paste.
 *
 * ## Why the line height is read rather than assumed
 *
 * The terminal font size is a user setting (`appearance-store`), and these rows
 * are styled to match it. A hard-coded pixel cap would mean ten rows at one
 * setting and six at another. Reading the computed line height keeps the cap
 * denominated in *rows*, which is what the constant claims to be.
 */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // See the note above: without this the row can only ever get taller.
    el.style.height = 'auto';

    const styles = window.getComputedStyle(el);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const padding =
      Number.parseFloat(styles.paddingTop) +
      Number.parseFloat(styles.paddingBottom);

    /**
     * happy-dom performs no layout, so every measurement here is `0` or `NaN`
     * under unit test. Falling back to the natural height keeps the hook inert
     * there rather than writing `NaN px` — the plumbing is what those tests
     * assert; the pixels belong to Playwright.
     */
    const max = Number.isFinite(lineHeight)
      ? lineHeight * MAX_GROW_ROWS + (Number.isFinite(padding) ? padding : 0)
      : Number.POSITIVE_INFINITY;

    const next = Math.min(el.scrollHeight, max);
    if (Number.isFinite(next) && next > 0) el.style.height = `${next}px`;

    // Only past the cap does the row become scrollable. Below it the content
    // always fits, and a scrollbar that can never engage still steals width.
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [ref, value]);
}
