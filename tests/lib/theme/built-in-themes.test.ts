import { describe, expect, it } from 'vitest';

import { BUILT_IN_THEME } from '@lib/theme/built-in';
import { BUILT_IN_THEMES, isBuiltInThemeId } from '@lib/theme/built-in-themes';
import {
  BUILT_IN_THEME_ID,
  SYNTAX_KEYS,
  TERMINAL_KEYS,
  TERMINAL_SURFACE_KEYS,
  THEME_MODES,
  UI_KEYS,
} from '@lib/theme/contract';
import { contrastRatio, importTheme, isHiveTheme } from '@lib/theme/validate';
import { TOKENS_CSS } from '@tests/support/css-tokens';

/** The six that ship beside the Hive, in gallery order. */
const SHIPPED = [
  'honeycomb',
  'graphite',
  'tidewater',
  'terracotta',
  'porcelain',
  'cinder',
] as const;

describe('the shipped set', () => {
  it('is the Hive plus six, in that order', () => {
    expect(Object.keys(BUILT_IN_THEMES)).toEqual([
      BUILT_IN_THEME_ID,
      ...SHIPPED,
    ]);
  });

  it('keeps the Hive entry identical to the built-in itself', () => {
    expect(BUILT_IN_THEMES[BUILT_IN_THEME_ID]).toBe(BUILT_IN_THEME);
  });

  it('recognises every shipped id and nothing else', () => {
    for (const id of Object.keys(BUILT_IN_THEMES)) {
      expect(isBuiltInThemeId(id), id).toBe(true);
    }
    expect(isBuiltInThemeId('nord')).toBe(false);
    expect(isBuiltInThemeId('')).toBe(false);
  });

  /**
   * `'toString' in {}` is `true`, and the matching lookup returns a *function*
   * rather than `undefined` — so a `?? fallback` guarding it never fires.
   */
  it('does not mistake an Object.prototype key for a shipped theme', () => {
    for (const key of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
      expect(isBuiltInThemeId(key), key).toBe(false);
    }
  });

  /**
   * The `tokens.css` pact is exactly one theme wide.
   *
   * `built-in.test.ts` asserts the Hive and the stylesheet agree in both
   * directions. That check only means something while the stylesheet holds one
   * palette — so if a second theme's colours ever leak into `tokens.css`, this
   * fails here rather than quietly making the drift test ambiguous.
   */
  it('keeps the six out of tokens.css', () => {
    for (const id of SHIPPED) {
      const { bg, brand } = BUILT_IN_THEMES[id].modes.dark.ui;
      expect(TOKENS_CSS, `${id} bg`).not.toContain(bg);
      expect(TOKENS_CSS, `${id} brand`).not.toContain(brand);
    }
  });
});

describe.each(SHIPPED)('%s', (id) => {
  const theme = BUILT_IN_THEMES[id];

  it('is a theme the app would accept off disk', () => {
    expect(isHiveTheme(theme)).toBe(true);
  });

  /**
   * Round-tripped through the *importer*, not just the shape guard.
   *
   * `inherited: 0` is the load-bearing assertion: a shipped theme missing a
   * key would silently borrow it from the Hive and land as a near-miss of the
   * palette it was chosen from, with nothing on screen to say so.
   */
  it('imports clean, inheriting nothing and warning about nothing', () => {
    const result = importTheme(JSON.stringify(theme), `${id}.json`);
    expect(result.ok, result.ok ? '' : result.detail).toBe(true);
    if (!result.ok) return;
    expect(result.inherited).toBe(0);
    expect(result.notes).toEqual([]);
  });

  describe.each(THEME_MODES)('%s mode', (mode) => {
    const colors = theme.modes[mode];

    it('carries every key the format names', () => {
      expect(Object.keys(colors.ui).sort()).toEqual([...UI_KEYS].sort());
      expect(Object.keys(colors.syntax).sort()).toEqual([...SYNTAX_KEYS].sort());
      expect(Object.keys(colors.terminal).sort()).toEqual(
        [...TERMINAL_KEYS, ...TERMINAL_SURFACE_KEYS].sort(),
      );
    });

    /** Rule 8: xterm paints one end of this ground and the DOM paints the other. */
    it('honours the terminal ground pact', () => {
      expect(colors.terminal.bg).toBe(colors.ui.termBg);
    });

    it('clears the contrast floor the importer measures', () => {
      const { ui } = colors;
      expect(contrastRatio(ui.ink, ui.panel)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ui.ink, ui.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ui.muted, ui.panel)).toBeGreaterThanOrEqual(3);
    });

    /** A primary button whose label fails on its own fill is not a button. */
    it('keeps its brand label readable on its brand fill', () => {
      const { ui } = colors;
      expect(contrastRatio(ui.onBrand, ui.brandFill)).toBeGreaterThanOrEqual(4.5);
    });

    /**
     * Not a rule the importer enforces, but the one that decides whether the
     * shell reads as layers: if `panel` does not separate from `bg`, the rails
     * dissolve into the background whatever the hue.
     */
    it('keeps its surfaces distinguishable', () => {
      const { ui } = colors;
      expect(ui.panel).not.toBe(ui.bg);
      expect(ui.hover).not.toBe(ui.panel);
      expect(ui.active).not.toBe(ui.hover);
      expect(ui.chipHover).not.toBe(ui.chip);
    });
  });
});

describe('the set as a whole', () => {
  it('gives every theme its own identity', () => {
    for (const key of ['bg', 'brand'] as const) {
      const seen = Object.values(BUILT_IN_THEMES).map(
        (t) => t.modes.dark.ui[key],
      );
      expect(new Set(seen).size, key).toBe(seen.length);
    }
  });

  it('names every theme distinctly', () => {
    const names = Object.values(BUILT_IN_THEMES).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
