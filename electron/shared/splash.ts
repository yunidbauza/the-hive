/**
 * Splash window constants, shared by both processes.
 *
 * Types and constants only, like everything in `electron/shared/`.
 *
 * The splash carries no preload and no IPC: it is a static document, and the
 * main process owns the clock. So what actually crosses the boundary here is
 * only the geometry the document lays itself out against — `splash.css` sizes
 * the chamber to {@link SPLASH_SIZE}, and `splash.ts` in the main process opens
 * a window of exactly that size. The two must agree or the chamber is scrolled
 * or letterboxed.
 */

/**
 * The chamber, and the window that holds it.
 *
 * Fixed rather than proportional to the display: the composition is authored at
 * this size — the creature at 660×290, the copy block at the left margin — and
 * a splash that reflows is a splash whose art direction is a suggestion.
 */
export const SPLASH_SIZE = { width: 960, height: 600 } as const;

/**
 * How long the splash is guaranteed to stay up.
 *
 * The animation reaches its resting state at about 2.4s — the creature settled,
 * all five lines landed, the progress ring closed. Dismissing before then shows
 * a sequence caught mid-motion, which reads as a bug rather than as a fast
 * boot. That is the lower bound, and the floor used to sit exactly on it.
 *
 * It sits a second past it instead, because landing on the last frame of the
 * animation and leaving in the same instant reads as being hurried out of the
 * room: the chamber arrives at its composition and is gone before it can be
 * looked at. The extra second is the creature breathing at rest, which is a
 * state the design already has and was never given time to show.
 *
 * Still a floor, not a duration. If the renderer is ready in 400ms the splash
 * finishes its sentence and holds the beat; if it takes five seconds the splash
 * leaves the moment it can.
 */
export const SPLASH_MIN_MS = 3500;

/**
 * The fade out, run by the main process as an opacity ramp on the window.
 *
 * In the main process rather than in the document because the splash has no
 * preload to receive a "you may go now" message through, and giving it one to
 * animate its own exit would be a preload, an IPC channel and a security
 * surface for 240 milliseconds of alpha.
 */
export const SPLASH_FADE_MS = 240;

/** One frame at 60Hz — the step the fade advances on. */
export const SPLASH_FADE_STEP_MS = 16;
