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

/**
 * Where macOS draws the panel's close button.
 *
 * Inset further than the main window's, and deliberately: this one sits over
 * artwork rather than over a title strip, so it needs enough dark around it to
 * read as a control instead of as three dots on the creature's shoulder.
 *
 * The panel exists because the window is frameless, and a frameless window with
 * no traffic lights has no visible way out at all — which is how this first
 * shipped, with Escape as the only exit and nothing on screen saying so.
 */
export const ABOUT_TRAFFIC_LIGHT_POSITION = { x: 14, y: 14 } as const;
