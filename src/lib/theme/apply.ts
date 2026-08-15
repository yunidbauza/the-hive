import {
  SYNTAX_KEYS,
  UI_KEYS,
  syntaxTokenName,
  uiTokenName,
  type HiveTheme,
  type ThemeModeName,
} from '@lib/theme/contract';

export const THEME_STYLE_ID = 'hive-theme';

function declarations(theme: HiveTheme, mode: ThemeModeName): string {
  const colors = theme.modes[mode];
  const lines = [
    ...UI_KEYS.map((k) => `  ${uiTokenName(k)}: ${colors.ui[k]};`),
    ...SYNTAX_KEYS.map((k) => `  ${syntaxTokenName(k)}: ${colors.syntax[k]};`),
  ];
  return lines.join('\n');
}

/**
 * The selectors the generated sheet declares on — deliberately **not** the ones
 * `tokens.css` uses, though they match the same elements.
 *
 * `:root` and `body[data-theme='light']` would tie with the stylesheet's own
 * blocks, and a tie is settled by document order — which the theme cannot
 * control. Rehydrating the appearance store appends this `<style>` during
 * module evaluation, before Vite's dev server has injected `tokens.css` at all,
 * so the equal-specificity dark block lost every reload and an imported theme
 * silently reverted to the built-in in dark mode (light survived only because
 * `body[data-theme='light']` happens to outrank `:root`).
 *
 * Repeating `:root` raises specificity without changing what is matched, so the
 * theme wins wherever the element lands. The light block keeps its lead over the
 * dark one — that relationship is what makes `data-theme` switch modes at all —
 * by qualifying the same `body` selector with the raised root.
 */
const DARK_SELECTOR = ':root:root';
const LIGHT_SELECTOR = ":root:root body[data-theme='light']";

/**
 * `data-theme` keeps doing exactly the job it does today, and nothing about how
 * components read colour changes.
 */
export function themeCss(theme: HiveTheme): string {
  return [
    `${DARK_SELECTOR} {\n${declarations(theme, 'dark')}\n}`,
    `${LIGHT_SELECTOR} {\n${declarations(theme, 'light')}\n}`,
  ].join('\n\n');
}

/**
 * Point the document at a theme, or back at `tokens.css`.
 *
 * `null` means the built-in, and writes **no** element at all — the stylesheet
 * is already the Hive theme, so the default path gains zero runtime work.
 */
export function applyThemeColors(theme: HiveTheme | null): void {
  if (typeof document === 'undefined') return;

  const existing = document.getElementById(THEME_STYLE_ID);
  if (!theme) {
    existing?.remove();
    return;
  }

  const style = existing ?? document.createElement('style');
  style.id = THEME_STYLE_ID;
  style.textContent = themeCss(theme);
  if (!existing) document.head.append(style);
}
