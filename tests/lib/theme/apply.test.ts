import { beforeEach, describe, expect, it } from 'vitest';

import { BUILT_IN_THEME } from '@lib/theme/built-in';
import { THEME_STYLE_ID, applyThemeColors, themeCss } from '@lib/theme/apply';
import type { HiveTheme } from '@lib/theme/contract';
import {
  DARK_SELECTOR,
  LIGHT_SELECTOR,
  TOKENS_CSS,
  parseTokenBlock,
} from '@tests/support/css-tokens';

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

  /**
   * `toContain(':root')` was trivially true of `:root:root` — and of every
   * other selector containing those five characters — so it asserted nothing
   * about which elements the sheet actually declares on. The doubled root is
   * the whole mechanism (see the block comment below), so the selectors are
   * asserted whole.
   */
  it('declares on the doubled root that out-ranks tokens.css', () => {
    expect(css).toContain(':root:root {');
    expect(css).toContain(":root:root body[data-theme='light'] {");
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

/**
 * The Critical fix from the whole-branch review.
 *
 * The appearance store rehydrates during module evaluation, which appends the
 * theme `<style>` **before** `tokens.css` exists in the dev-server document.
 * With both sheets declaring on `:root`, the tie went to document order and the
 * stylesheet won: an imported theme's dark colours were silently ignored after
 * every reload, while light kept working because `body[data-theme='light']`
 * outranks `:root` all on its own. These cascade the real stylesheet against
 * the generated one in the losing order, so an equal-specificity regression
 * fails here rather than in a browser.
 */
describe('themeCss out-ranks tokens.css whatever the insertion order', () => {
  /** tokens.css's own two colour blocks, rebuilt with their real selectors. */
  function tokensStylesheet(): string {
    const block = (selector: string, vars: Record<string, string>) =>
      [
        `${selector} {`,
        ...Object.entries(vars).map(([name, value]) => `  ${name}: ${value};`),
        '}',
      ].join('\n');

    return [
      block(':root', parseTokenBlock(TOKENS_CSS, DARK_SELECTOR)),
      block("body[data-theme='light']", parseTokenBlock(TOKENS_CSS, LIGHT_SELECTOR)),
    ].join('\n\n');
  }

  const nord: HiveTheme = structuredClone(BUILT_IN_THEME);
  nord.name = 'Nord';
  nord.modes.dark.ui.panel = '#3b4252';
  nord.modes.light.ui.panel = '#eceff4';

  const panelOn = (node: Element) =>
    getComputedStyle(node).getPropertyValue('--cc-panel').trim();

  function mount(order: 'theme first' | 'tokens first'): void {
    const theme = document.createElement('style');
    theme.id = THEME_STYLE_ID;
    theme.textContent = themeCss(nord);

    const tokens = document.createElement('style');
    tokens.id = 'tokens-css';
    tokens.textContent = tokensStylesheet();

    const nodes = order === 'theme first' ? [theme, tokens] : [tokens, theme];
    document.head.append(...nodes);
  }

  beforeEach(() => {
    document.getElementById('tokens-css')?.remove();
    document.body.removeAttribute('data-theme');
  });

  it.each(['theme first', 'tokens first'] as const)(
    'paints the imported dark colour with the theme sheet %s',
    (order) => {
      mount(order);
      expect(panelOn(document.documentElement)).toBe('#3b4252');
    },
  );

  it.each(['theme first', 'tokens first'] as const)(
    'paints the imported light colour with the theme sheet %s',
    (order) => {
      mount(order);
      document.body.setAttribute('data-theme', 'light');
      expect(panelOn(document.body)).toBe('#eceff4');
    },
  );

  it('keeps light ahead of dark, which is what makes the mode switch work', () => {
    // Guards the half of the fix that is easy to get backwards: raising the
    // dark block above `body[data-theme='light']` without raising the light
    // block too would freeze the app in dark.
    mount('theme first');
    expect(panelOn(document.documentElement)).toBe('#3b4252');
    document.body.setAttribute('data-theme', 'light');
    expect(panelOn(document.body)).toBe('#eceff4');
  });
});
