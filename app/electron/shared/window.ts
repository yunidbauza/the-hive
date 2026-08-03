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
 * Where the traffic lights sit once `titleBarStyle: 'hiddenInset'` floats them
 * over our own 56px header (story 021).
 */
export const TRAFFIC_LIGHT_POSITION = { x: 16, y: 20 } as const;
