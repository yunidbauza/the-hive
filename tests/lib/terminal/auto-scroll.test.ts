import { describe, expect, it } from 'vitest';

import { shouldAutoScroll } from '@lib/terminal/auto-scroll';

/**
 * The bottom-stick rule is the one piece of scroll behaviour provable without a
 * rendered terminal, which is exactly why story 042 asks for it as a pure
 * predicate. Everything else about scrolling lives in Playwright.
 */
describe('shouldAutoScroll', () => {
  it('sticks when the viewport is parked at the bottom', () => {
    expect(shouldAutoScroll(120, 120)).toBe(true);
  });

  it('sticks on a buffer too short to scroll at all', () => {
    // Nothing has spilled out of the viewport yet, so both are still zero.
    expect(shouldAutoScroll(0, 0)).toBe(true);
  });

  it('does not steal the viewport while the user reads scrollback', () => {
    // One line up is enough: yanking the view down here is the whole failure
    // mode this predicate exists to prevent.
    expect(shouldAutoScroll(119, 120)).toBe(false);
    expect(shouldAutoScroll(0, 400)).toBe(false);
  });

  it('recovers when trimmed scrollback leaves the viewport past the base', () => {
    // `>=` rather than `===`: a write that trims scrollback can momentarily
    // leave viewportY ahead, and treating that as "scrolled up" would strand
    // the terminal permanently.
    expect(shouldAutoScroll(121, 120)).toBe(true);
  });
});
