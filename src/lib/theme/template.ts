import { BUILT_IN_THEME } from '@lib/theme/built-in';
import type { HiveTheme } from '@lib/theme/contract';

export const TEMPLATE_FILE_NAME = 'hive-theme-template.json';

/** Two-space JSON — the file is meant to be opened and edited by a person. */
export function themeToJson(theme: HiveTheme): string {
  return `${JSON.stringify(theme, null, 2)}\n`;
}

/**
 * A fully populated copy of the built-in theme.
 *
 * Not an empty skeleton: editing 49 real colours is a task anyone can start,
 * inventing them against a blank file is not. Generated from the same data the
 * app runs on, so it cannot go stale.
 */
export function themeTemplateJson(): string {
  return themeToJson({
    ...BUILT_IN_THEME,
    name: 'My theme',
    author: 'You',
    version: '1.0.0',
  });
}
