/**
 * The theme format (HIVE-80).
 *
 * These three key lists are the format's single source of truth. `built-in.ts`
 * is checked against `tokens.css` by a test rather than by a comment, so a
 * token added to the stylesheet without being added here fails the build.
 */

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

/** Bytes. localStorage has no quota error worth showing a person. */
export const MAX_THEME_BYTES = 256 * 1024;

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
