/**
 * The bottom-stick rule.
 *
 * New output should follow the cursor only when the user is already watching
 * the bottom. Yanking the viewport down while someone reads scrollback is the
 * single most irritating thing a log pane can do, so this is a rule rather than
 * an unconditional `scrollToBottom()`.
 *
 * Extracted as a pure predicate (story 042) because it is the one piece of
 * scroll behaviour that can be proven without a rendered terminal — everything
 * else about scrolling belongs in Playwright.
 *
 * ## On the signature
 *
 * Story 042 sketches this as `shouldAutoScroll(viewportY, baseY, rows)`. The
 * row count is not needed and is deliberately omitted: in xterm's buffer model
 * `baseY` is *already* the viewport-height-adjusted maximum scroll offset — the
 * top line index when scrolled fully down — so the viewport height is baked
 * into the comparison. Accepting `rows` would mean either ignoring it or
 * inventing a tolerance band the story never specified.
 */
export function shouldAutoScroll(viewportY: number, baseY: number): boolean {
  /**
   * `>=` rather than `===` on purpose. The two values are equal in normal
   * operation, but a write that trims scrollback can momentarily leave
   * `viewportY` ahead of `baseY`; treating that as "not at the bottom" would
   * strand the viewport permanently.
   */
  return viewportY >= baseY;
}
