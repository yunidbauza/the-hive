import { describe, expect, it } from 'vitest';

import { BUILT_IN_THEME } from '@lib/theme/built-in';
import {
  SYNTAX_KEYS,
  TERMINAL_KEYS,
  UI_KEYS,
  syntaxTokenName,
  uiTokenName,
} from '@lib/theme/contract';
import {
  DARK_SELECTOR,
  LIGHT_SELECTOR,
  TOKENS_CSS,
  parseTokenBlock,
} from '@tests/support/css-tokens';

describe('the format', () => {
  it('counts 50 colours per mode', () => {
    expect(UI_KEYS).toHaveLength(28);
    expect(SYNTAX_KEYS).toHaveLength(11);
    expect(TERMINAL_KEYS).toHaveLength(11);
  });
});

describe('the built-in theme mirrors tokens.css', () => {
  const dark = parseTokenBlock(TOKENS_CSS, DARK_SELECTOR);
  const light = parseTokenBlock(TOKENS_CSS, LIGHT_SELECTOR);

  it('matches the dark ui block', () => {
    for (const key of UI_KEYS) {
      expect(BUILT_IN_THEME.modes.dark.ui[key], key).toBe(dark[uiTokenName(key)]);
    }
  });

  it('matches the dark syntax block', () => {
    for (const key of SYNTAX_KEYS) {
      expect(BUILT_IN_THEME.modes.dark.syntax[key], key).toBe(
        dark[syntaxTokenName(key)],
      );
    }
  });

  /**
   * The light block overrides only 22 of the 27 ui tokens — five are
   * deliberately theme-invariant and inherit `:root`. The built-in theme
   * spells all 27 out for both modes, so the invariant five are compared
   * against the dark block on purpose.
   */
  it('matches the light ui block, invariants falling back to dark', () => {
    for (const key of UI_KEYS) {
      const token = uiTokenName(key);
      expect(BUILT_IN_THEME.modes.light.ui[key], key).toBe(
        light[token] ?? dark[token],
      );
    }
  });

  it('matches the light syntax block', () => {
    for (const key of SYNTAX_KEYS) {
      expect(BUILT_IN_THEME.modes.light.syntax[key], key).toBe(
        light[syntaxTokenName(key)],
      );
    }
  });

  /**
   * The other direction, and the one the guarantee was missing.
   *
   * Every test above walks a *key list* and looks the token up in the CSS, so
   * a `--cc-*` colour added to the stylesheet and to no key list passed green:
   * the built-in painted it from the sheet, and it was simply un-themeable —
   * an imported theme could never set it, and would leave it at whatever the
   * stylesheet said while everything around it changed. Walking the parsed CSS
   * instead closes it.
   *
   * `parseTokenBlock` only captures declarations whose value is a hex colour,
   * which is what keeps the spacing and density tokens (`268px`, `7px`) out of
   * this by construction rather than by an exclusion list somebody has to
   * maintain.
   */
  const THEMEABLE_TOKENS = new Set<string>([
    ...UI_KEYS.map(uiTokenName),
    ...SYNTAX_KEYS.map(syntaxTokenName),
  ]);

  it.each([
    ['dark', dark],
    ['light', light],
  ] as const)('names every colour token the %s block declares', (_mode, block) => {
    for (const token of Object.keys(block)) {
      expect(THEMEABLE_TOKENS.has(token), `${token} is in tokens.css but in no key list`).toBe(
        true,
      );
    }
  });

  it('grounds each mode terminal on the same colour the DOM paints', () => {
    expect(BUILT_IN_THEME.modes.dark.terminal.bg).toBe(
      BUILT_IN_THEME.modes.dark.ui.termBg,
    );
    expect(BUILT_IN_THEME.modes.light.terminal.bg).toBe(
      BUILT_IN_THEME.modes.light.ui.termBg,
    );
  });
});
