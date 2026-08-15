/**
 * The theme format (HIVE-80).
 *
 * These three key lists are the format's single source of truth, and
 * `tests/lib/theme/built-in.test.ts` holds them to it in **both** directions:
 * every key here must name a colour `tokens.css` declares, and every colour
 * `tokens.css` declares must be named by a key here. One direction alone is not
 * a drift guarantee — it was the missing half that let a `--cc-*` colour be
 * added to the stylesheet and stay silently un-themeable, painting from the
 * sheet in the built-in and reverting the moment any theme was imported.
 * (Spacing and density tokens are deliberately not part of a theme and carry no
 * colour value, which is exactly how the test tells them apart.)
 */

/**
 * The byte cap lives in `electron/shared/` — the one module both processes
 * import — because main enforces it too and `electron/main/**` may not import
 * `src/**`. Re-exported here so every renderer-side consumer keeps importing
 * it from `@lib/theme/contract`, with a single definition underneath.
 */
export { MAX_THEME_BYTES } from '@shared/theme-contract';

export const UI_KEYS = [
  'bg', 'panel', 'panel2', 'hover', 'active', 'border', 'borderSoft',
  'ink', 'muted', 'subtle', 'brand', 'green', 'amber', 'red',
  'chip', 'chipHover', 'termBg', 'termInput', 'termRowHover', 'termRowActive',
  'termHead', 'termTrack', 'brandFill', 'brandFillHover', 'brandFillStrong',
  'onBrand', 'dangerSolid',
] as const;

export const SYNTAX_KEYS = [
  'keyword', 'string', 'number', 'comment', 'name', 'type',
  'operator', 'constant', 'invalid', 'activeLine', 'selection',
] as const;

/** `TermPalette`'s field names verbatim — xterm is handed this group as an object. */
export const TERMINAL_KEYS = [
  'bg', 'ink', 'dim', 'black', 'green', 'blue', 'amber', 'red',
  'cyan', 'magenta', 'selection',
] as const;

export type UiKey = (typeof UI_KEYS)[number];
export type SyntaxKey = (typeof SYNTAX_KEYS)[number];
export type TerminalKey = (typeof TERMINAL_KEYS)[number];

export type UiColors = Record<UiKey, string>;
export type SyntaxColors = Record<SyntaxKey, string>;
export type TerminalColors = Record<TerminalKey, string>;

export type ThemeModeName = 'dark' | 'light';

/**
 * Both modes, in the order the importer reads them. Every theme carries both —
 * which is why a theme *file* holds `THEME_MODES.length × 49` colour values,
 * the unit the import banner counts in.
 */
export const THEME_MODES = [
  'dark',
  'light',
] as const satisfies readonly ThemeModeName[];

export interface ThemeModeColors {
  ui: UiColors;
  syntax: SyntaxColors;
  terminal: TerminalColors;
}

export interface HiveTheme {
  hiveThemeVersion: 1;
  name: string;
  author: string;
  version: string;
  modes: Record<ThemeModeName, ThemeModeColors>;
}

export const HIVE_THEME_VERSION = 1;
export const BUILT_IN_THEME_ID = 'hive';

/** `borderSoft` → `--cc-border-soft`; `panel2` → `--cc-panel-2`. */
function kebab(key: string): string {
  return key.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase();
}

export function uiTokenName(key: UiKey): string {
  return `--cc-${kebab(key)}`;
}

export function syntaxTokenName(key: SyntaxKey): string {
  return `--cc-code-${kebab(key)}`;
}
