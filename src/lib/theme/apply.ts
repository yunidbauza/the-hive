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
 * The same shape `tokens.css` uses, so `data-theme` keeps doing exactly the job
 * it does today and nothing about how components read colour changes.
 */
export function themeCss(theme: HiveTheme): string {
  return [
    `:root {\n${declarations(theme, 'dark')}\n}`,
    `body[data-theme='light'] {\n${declarations(theme, 'light')}\n}`,
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
