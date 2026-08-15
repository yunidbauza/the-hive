import { beforeEach, describe, expect, it } from 'vitest';

import { BUILT_IN_THEME } from '@lib/theme/built-in';
import { THEME_STYLE_ID, applyThemeColors, themeCss } from '@lib/theme/apply';

const el = () => document.getElementById(THEME_STYLE_ID);

beforeEach(() => {
  el()?.remove();
});

describe('applyThemeColors', () => {
  it('writes no element for the built-in theme', () => {
    // tokens.css alone IS the Hive theme: the default path does no runtime work
    // and cannot drift from the stylesheet.
    applyThemeColors(null);
    expect(el()).toBeNull();
  });

  it('writes one style element for a custom theme', () => {
    applyThemeColors(BUILT_IN_THEME);
    expect(el()).not.toBeNull();
    expect(document.querySelectorAll(`#${THEME_STYLE_ID}`)).toHaveLength(1);
  });

  it('reuses the same element rather than stacking them', () => {
    applyThemeColors(BUILT_IN_THEME);
    applyThemeColors(BUILT_IN_THEME);
    expect(document.querySelectorAll(`#${THEME_STYLE_ID}`)).toHaveLength(1);
  });

  it('removes the element when returning to the built-in', () => {
    applyThemeColors(BUILT_IN_THEME);
    applyThemeColors(null);
    expect(el()).toBeNull();
  });
});

describe('themeCss', () => {
  const css = themeCss(BUILT_IN_THEME);

  it('mirrors the selectors tokens.css already uses', () => {
    expect(css).toContain(':root');
    expect(css).toContain("body[data-theme='light']");
  });

  it('emits both ui and syntax tokens', () => {
    expect(css).toContain(`--cc-panel-2: ${BUILT_IN_THEME.modes.dark.ui.panel2}`);
    expect(css).toContain(
      `--cc-code-active-line: ${BUILT_IN_THEME.modes.dark.syntax.activeLine}`,
    );
  });

  it('emits no spacing tokens — a theme is colour', () => {
    expect(css).not.toContain('--cc-rail-');
    expect(css).not.toContain('--cc-row-py');
  });
});
