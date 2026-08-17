/**
 * The About panel, and the window that holds it.
 *
 * Fixed rather than proportional, for the reason {@link SPLASH_SIZE} is fixed:
 * the composition is authored at this size — the creature centred at 210×136,
 * the copy stacked beneath it — and `about.css` is written in these
 * coordinates. A panel that reflows is a panel whose art direction is a
 * suggestion.
 *
 * Portrait, unlike the splash's landscape. The splash fills a moment on a
 * desktop; this sits above a running app and should read as a card rather than
 * as a second window competing with the one behind it.
 */
export const ABOUT_SIZE = { width: 420, height: 500 } as const;
