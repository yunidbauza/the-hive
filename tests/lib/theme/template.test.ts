import { describe, expect, it } from 'vitest';

import { BUILT_IN_THEME } from '@lib/theme/built-in';
import { TEMPLATE_FILE_NAME, themeTemplateJson } from '@lib/theme/template';
import { importTheme } from '@lib/theme/validate';

describe('the downloaded template', () => {
  it('is named for what it is', () => {
    expect(TEMPLATE_FILE_NAME).toBe('hive-theme-template.json');
  });

  /**
   * The test that keeps the template from going stale. A template that cannot
   * itself be imported cleanly is a trap, and it would fail here first.
   */
  it('imports with zero inherited keys and zero notes', () => {
    const result = importTheme(themeTemplateJson(), TEMPLATE_FILE_NAME);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inherited).toBe(0);
    expect(result.notes).toEqual([]);
    expect(result.theme.modes).toEqual(BUILT_IN_THEME.modes);
  });

  it('is fully populated, not a skeleton', () => {
    const parsed = JSON.parse(themeTemplateJson());
    expect(Object.keys(parsed.modes.dark.ui)).toHaveLength(28);
    /*
      Thirteen since HIVE-82: the eleven required terminal colours plus the two
      surfaces. The template offers them even though the format does not require
      them, which is the point of a template — a theme author who starts here
      chooses their own panel fills rather than getting the ones `surfacesOf`
      blends out of `bg`.
    */
    expect(Object.keys(parsed.modes.light.terminal)).toHaveLength(13);
  });
});
