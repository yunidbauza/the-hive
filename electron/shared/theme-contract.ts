/**
 * The theme import/export bridge (HIVE-80).
 *
 * Types and constants only, like everything in `electron/shared/` — both
 * processes import this, and `src/lib/theme/contract.ts` re-exports
 * {@link MAX_THEME_BYTES} so the byte cap has exactly one definition rather
 * than a renderer-side copy that could drift from the one main enforces.
 *
 * `electron/main/**` may not import `src/**` (an ESLint zone fails the build
 * on it), so the cap could not live in `src/lib/theme/contract.ts` and be read
 * from main directly — it has to live on this side of the fence, with the
 * renderer's copy of the number reduced to an import.
 */

/** Bytes. localStorage has no quota error worth showing a person. */
export const MAX_THEME_BYTES = 256 * 1024;

/** What `theme:pick` resolves — the file the user chose, already read. */
export interface PickedTheme {
  /** The absolute path, for display only — never sent back to write anything. */
  path: string;
  /** The file's raw text. Parsing and validating it is the renderer's job. */
  contents: string;
}

/** What the renderer sends `theme:save` — never a destination path. */
export interface SaveThemeRequest {
  /**
   * The filename offered to the save dialog. Main re-validates it against
   * `/^[\w.-]{1,64}\.json$/` — the dialog lets the user rename it anyway, so
   * this is a suggestion, not a value that reaches the filesystem unchecked.
   */
  suggestedName: string;
  /** The theme file's text, bounded by {@link MAX_THEME_BYTES}. */
  contents: string;
}
