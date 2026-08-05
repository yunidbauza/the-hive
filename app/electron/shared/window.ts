/**
 * Window constants shared by both processes (story 081).
 *
 * Types and constants only, like everything in `electron/shared/`.
 */

/**
 * The window's paint colour, and the one place in this codebase where a raw hex
 * literal is legitimate.
 *
 * `AGENTS.md` bans raw hex in component code — "if a colour is missing, add a
 * token". The main process has no CSS and no custom properties, and Electron
 * paints the window background *before* any stylesheet loads. The default is
 * white, which on a dark app is a white rectangle on every cold launch. So the
 * value is duplicated here rather than referenced.
 *
 * **Keep in sync with `--cc-bg` in `src/styles/tokens.css`** (the `:root`, dark
 * value). Declared here so the duplication is findable rather than lurking in a
 * window factory.
 *
 * The app is themeable — `body[data-theme='light']` moves `--cc-bg` to
 * `#fdfdfb` — but a `BrowserWindow` needs one colour before the renderer can
 * report which theme it will use. Dark is the default theme, so dark is the
 * right guess; the mismatched flash on a light-theme cold start lasts one paint
 * and is the cheaper of the two errors.
 */
export const WINDOW_BACKGROUND = '#10152a';

/**
 * Below this the two rails and the center column stop being usable at all
 * (story 020 — the shell is desktop-width by design).
 */
export const MIN_WINDOW_SIZE = { width: 1100, height: 700 } as const;

/** Opening size on a machine with no saved state. */
export const DEFAULT_WINDOW_SIZE = { width: 1440, height: 900 } as const;

/**
 * The drag strip the traffic lights live in, above the app's own header.
 *
 * `titleBarStyle: 'hiddenInset'` removes the native bar but still floats the
 * lights over whatever the renderer paints at the top of the content area.
 * Previously that was the 56px header itself, which put three system buttons
 * immediately beside the wordmark — the lights read as part of the brand
 * cluster rather than as window chrome.
 *
 * So the renderer now paints a strip of exactly this height above the header
 * and the lights are centred in it. The header goes back to being the app's
 * bar, with nothing of the OS's in it.
 *
 * **Consumed by both processes**: the main process places the lights against
 * it, the renderer sizes `title-bar.tsx` from it. That is the whole reason it
 * lives here rather than as a Tailwind class on one side and a magic number on
 * the other — the two must agree or the lights sit half in the header.
 */
export const TITLEBAR_HEIGHT = 32;

/**
 * Where the traffic lights sit inside {@link TITLEBAR_HEIGHT}'s strip.
 *
 * `y` centres a 12px button in the strip: `(32 - 12) / 2 = 10`. macOS draws the
 * three buttons at 12px across regardless of the window's size, so this is
 * arithmetic rather than a tuned constant — change `TITLEBAR_HEIGHT` and this
 * follows from it.
 *
 * `x: 16` is unchanged, and matches the header's own `px-4`: the lights and the
 * logo below them share a left margin, which is what makes the strip read as
 * the same window rather than as a bar bolted on top.
 */
export const TRAFFIC_LIGHT_POSITION = {
  x: 16,
  y: (TITLEBAR_HEIGHT - 12) / 2,
} as const;
