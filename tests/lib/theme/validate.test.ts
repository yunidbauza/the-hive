import { describe, expect, it } from 'vitest';

import { BUILT_IN_THEME } from '@lib/theme/built-in';
import { MAX_THEME_BYTES } from '@lib/theme/contract';
import { importTheme } from '@lib/theme/validate';

/** A complete, valid theme built by recolouring the built-in. */
function fullTheme(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    hiveThemeVersion: 1,
    name: 'Nord',
    author: 'Arctic Ice Studio',
    version: '1.0.0',
    modes: structuredClone(BUILT_IN_THEME.modes),
    ...overrides,
  });
}

describe('the pair rule', () => {
  it('rejects a file carrying only dark, in a sentence', () => {
    const only = structuredClone(BUILT_IN_THEME.modes) as Record<string, unknown>;
    delete only.light;
    const result = importTheme(fullTheme({ modes: only }), 'midnight.json');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.title).toBe("Couldn't import midnight.json");
    expect(result.detail).toContain(
      'A Hive theme needs both a light and a dark mode',
    );
    expect(result.detail).toContain('modes.light');
    // Not a schema dump.
    expect(result.detail).not.toContain('"type"');
  });
});

describe('the version gate', () => {
  it('fails first and alone on a future format', () => {
    const result = importTheme(
      fullTheme({ hiveThemeVersion: 2, modes: {} }),
      'future.json',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The missing modes are never reported — the version is the only complaint.
    expect(result.detail).not.toContain('light');
    expect(result.detail).toContain('hiveThemeVersion');
  });
});

describe('the size ceiling', () => {
  it('rejects an over-size file before parsing it', () => {
    // Deliberately not valid JSON: proving the size check runs first.
    const huge = 'x'.repeat(MAX_THEME_BYTES + 1);
    const result = importTheme(huge, 'huge.json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('256 KB');
  });
});

describe('inheritance', () => {
  it('fills missing keys from the built-in of the same mode and counts them', () => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    delete modes.dark.ui.panel;
    delete modes.dark.ui.hover;
    delete modes.light.syntax.comment;

    const result = importTheme(fullTheme({ modes }), 'partial.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inherited).toBe(3);
    expect(result.theme.modes.dark.ui.panel).toBe(
      BUILT_IN_THEME.modes.dark.ui.panel,
    );
  });

  /**
   * The bug this closes: a theme that inherits most of its colours from the
   * built-in used to come back with zero notes, which put it in the green
   * "clean import" state instead of amber — and separately let the banner's
   * "N of 49" sentence go negative, since `inherited` sums across *both*
   * modes (up to 98) while the sentence only ever had 49 to subtract from.
   * A note is the fix at the source: it is what makes `notes.length > 0`
   * true, which is what the banner's tone actually keys off.
   */
  it('notes the inherited count — the state that used to slip through as "clean"', () => {
    // Every colour in both modes is missing: the file supplies nothing but
    // the two empty mode blocks the pair rule requires.
    const result = importTheme(
      fullTheme({ modes: { light: {}, dark: {} } }),
      'minimal.json',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inherited).toBe(98);
    expect(result.notes[0]).toBe('98 colours inherited from the built-in theme');
  });

  it('is the first note, ahead of unknown-key and contrast notes', () => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    delete modes.dark.ui.panel; // inherited
    modes.light.ui.accentHover = '#123456'; // unknown key
    modes.light.ui.ink = '#f4f4f4'; // low contrast on panel

    const result = importTheme(fullTheme({ modes }), 'mixed.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes[0]).toBe('1 colour inherited from the built-in theme');
    expect(result.notes.some((note) => note.includes('accentHover'))).toBe(true);
    expect(
      result.notes.findIndex((note) => note.includes('accentHover')),
    ).toBeLessThan(result.notes.findIndex((note) => note.includes(':1')));
  });

  it('adds no inheritance note when nothing was inherited', () => {
    const result = importTheme(fullTheme(), 'complete.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inherited).toBe(0);
    expect(result.notes).toEqual([]);
  });
});

describe('the terminal ground', () => {
  it('derives terminal.bg from ui.termBg when the file omits it', () => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    modes.dark.ui.termBg = '#2b303b';
    delete modes.dark.terminal.bg;

    const result = importTheme(fullTheme({ modes }), 'nord.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.modes.dark.terminal.bg).toBe('#2b303b');
  });

  it('is fatal when both are present and disagree, naming both values', () => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    modes.dark.ui.termBg = '#2b303b';
    modes.dark.terminal.bg = '#0b1023';

    const result = importTheme(fullTheme({ modes }), 'nord.json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('#2b303b');
    expect(result.detail).toContain('#0b1023');
  });

  it('counts terminal.bg as inherited exactly once when the file omits it but supplies ui.termBg', () => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    modes.dark.ui.termBg = '#2b303b';
    delete modes.dark.terminal.bg;

    const result = importTheme(fullTheme({ modes }), 'nord.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inherited).toBe(1);
  });

  it('counts two inherited keys when the file omits both terminal.bg and ui.termBg', () => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    delete modes.dark.ui.termBg;
    delete modes.dark.terminal.bg;

    const result = importTheme(fullTheme({ modes }), 'nord.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inherited).toBe(2);
  });

  it('counts zero inherited when the file supplies both and they agree', () => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    modes.dark.ui.termBg = '#2b303b';
    modes.dark.terminal.bg = '#2b303b';

    const result = importTheme(fullTheme({ modes }), 'nord.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inherited).toBe(0);
  });
});

describe('unknown keys', () => {
  it('ignores them and lists them by name', () => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    modes.light.ui.accentHover = '#123456';

    const result = importTheme(fullTheme({ modes }), 'solarized.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes.join(' ')).toContain('accentHover');
    expect(result.theme.modes.light.ui).not.toHaveProperty('accentHover');
  });
});

describe('colour parsing', () => {
  it('names the exact path of an unparseable colour', () => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    modes.light.ui.panel = 'not-a-colour';

    const result = importTheme(fullTheme({ modes }), 'bad.json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('modes.light.ui.panel');
  });

  it.each([
    '#abc',
    '#aabbcc',
    '#aabbccdd',
    'rgb(1 2 3)',
    'rgb(1, 2, 3)',
    'rgb(1 2 3 / 0.5)',
    'rgb(1, 2, 3, 0.5)',
    'rgb(100% 0% 0%)',
    'oklch(0.5 0.1 200)',
    'oklch(0.5 0.1 200 / 0.4)',
    'oklch(50% 0.1 200)',
  ])('accepts %s', (colour) => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    modes.light.ui.panel = colour;
    expect(importTheme(fullTheme({ modes }), 'ok.json').ok).toBe(true);
  });

  /**
   * The Important fix from the whole-branch review: the functional forms used
   * to be checked for *shape* only, so anything between the parentheses passed.
   * These imported cleanly and then landed as a declaration the browser drops
   * silently — and, in the `terminal` group, as an xterm fallback colour.
   */
  it.each([
    'rgb()',
    'rgb(1,2)',
    'rgb(1 2)',
    'rgb(1 2 3 4 5)',
    'oklch(nonsense)',
    'oklch(0.5 0.1)',
    'rgb(1 2 3 / )',
    'rgb(1 2 3 / a)',
    'rgb(1 2 3 / 0.5 / 0.5)',
    '#ff',
    'not-a-colour',
  ])('rejects %s, naming its path', (colour) => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    modes.dark.terminal.cyan = colour;

    const result = importTheme(fullTheme({ modes }), 'bad.json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toBe(
      'modes.dark.terminal.cyan is not a colour the Hive can read.',
    );
  });
});

describe('contrast', () => {
  it('notes a low ratio with the measured value and still imports', () => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    // Near-white ink on a white panel.
    modes.light.ui.ink = '#f4f4f4';

    const result = importTheme(fullTheme({ modes }), 'faint.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes.join(' ')).toMatch(/\d\.\d:1/);
  });
});
