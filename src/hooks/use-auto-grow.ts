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
 * So the cap stays denominated in *rows*, which is what the constant claims to
 * be. The rows are `text-[12.5px]` today, but a pixel cap written here would be
 * a second place to change the day that stops being true — and it would fail
 * silently, as a row that grows to six lines or fourteen rather than ten.
 *
 * ## Why width is watched and not only the text
 *
 * Height depends on content **and** width, and only one of those is the
 * `value`. A row that has been sized once and then narrowed — the window
 * resized, the split handle dragged, the right rail opened, a file opened into
 * split view — needs more height for the same text and will not be asked for
 * it. Because the hook also pins `overflow-y`, the result is not an ugly
 * scrollbar but *silent clipping*: the element stays at its old height with the
 * overflow hidden, and most of a draft becomes unreachable with nothing on
 * screen to say so. The `ResizeObserver` is what closes that hole.
 */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      // See the note above: without this the row can only ever get taller.
      el.style.height = 'auto';

      const styles = window.getComputedStyle(el);
      const lineHeight = Number.parseFloat(styles.lineHeight);
      const padding =
        Number.parseFloat(styles.paddingTop) +
        Number.parseFloat(styles.paddingBottom);

      /**
       * happy-dom performs no layout, so every measurement here is `0` or `NaN`
       * under unit test. Falling back to the natural height keeps the hook
       * inert there rather than writing `NaN px` — the plumbing is what those
       * tests assert; the pixels belong to Playwright.
       */
      const max = Number.isFinite(lineHeight)
        ? lineHeight * MAX_GROW_ROWS + (Number.isFinite(padding) ? padding : 0)
        : Number.POSITIVE_INFINITY;

      const next = Math.min(el.scrollHeight, max);
      if (Number.isFinite(next) && next > 0) el.style.height = `${next}px`;

      // Only past the cap does the row become scrollable. Below it the content
      // always fits, and a scrollbar that can never engage still steals width.
      el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
    };

    measure();

    /**
     * Guarded because happy-dom does not implement it. Without the guard every
     * unit test rendering either prompt row would throw on mount, which is a
     * loud failure for a hook whose whole job is to be invisible.
     */
    if (typeof ResizeObserver === 'undefined') return;

    /**
     * **Width only, and the guard is load-bearing.** `measure` writes
     * `el.style.height`, which resizes the very element being observed — so an
     * unguarded observer re-entered itself on its own writes and browsers
     * report that as `ResizeObserver loop completed with undelivered
     * notifications`. Height changes are ours and carry no new information;
     * width changes are the environment's and are the only thing that
     * invalidates a measurement the `value` dependency would not already catch.
     */
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      measure();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, value]);
}
