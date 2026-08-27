import { describe, expect, it } from 'vitest';

import { BUILT_IN_THEME } from '@lib/theme/built-in';
import { MAX_THEME_BYTES } from '@lib/theme/contract';
import { importTheme, isHiveTheme, utf8ByteLength } from '@lib/theme/validate';

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
   * "N of 50" sentence go negative, since `inherited` sums across *both*
   * modes (up to 100) while the sentence only ever had 50 to subtract from.
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
    expect(result.inherited).toBe(100);
    expect(result.notes[0]).toBe('100 colours inherited from the built-in theme');
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

  /**
   * The fourth permutation, and the one the pact used to miss entirely.
   *
   * Rule 7 inherited `ui.termBg` from the built-in while `terminal.bg` kept
   * the file's value, so the pair landed *mismatched* — `#2b303b` inside
   * xterm, `#0b1023` in the padding around it — behind nothing louder than a
   * "1 colour inherited" note. That is exactly the visible rectangle at the
   * terminal's edge this rule exists to prevent.
   */
  it('derives ui.termBg from terminal.bg when the file supplies only that end', () => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    modes.dark.terminal.bg = '#2b303b';
    delete modes.dark.ui.termBg;

    const result = importTheme(fullTheme({ modes }), 'nord.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.modes.dark.ui.termBg).toBe('#2b303b');
    expect(result.theme.modes.dark.terminal.bg).toBe('#2b303b');
    expect(result.inherited).toBe(1);
  });

  /** The invariant itself, stated once over all four permutations. */
  it.each([
    ['neither end', { termBg: false, bg: false }],
    ['ui.termBg only', { termBg: true, bg: false }],
    ['terminal.bg only', { termBg: false, bg: true }],
    ['both, agreeing', { termBg: true, bg: true }],
  ] as const)('keeps the two ends equal when the file supplies %s', (_label, supplies) => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    if (supplies.termBg) modes.dark.ui.termBg = '#2b303b';
    else delete modes.dark.ui.termBg;
    if (supplies.bg) modes.dark.terminal.bg = '#2b303b';
    else delete modes.dark.terminal.bg;

    const result = importTheme(fullTheme({ modes }), 'nord.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.modes.dark.terminal.bg).toBe(
      result.theme.modes.dark.ui.termBg,
    );
  });

  it('tells a mismatched file it may drop either end, not just one', () => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    modes.dark.ui.termBg = '#2b303b';
    modes.dark.terminal.bg = '#0b1023';

    const result = importTheme(fullTheme({ modes }), 'nord.json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The advice used to be true in one direction only.
    expect(result.detail).toContain('drop either one');
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
   *
   * The last four are the second round of the same defect. Counting "three
   * channels, or four when there is no slash" admitted a space-separated
   * fourth channel, and splitting on `[\s,]+` made the legacy comma form and
   * the modern space form interchangeable — so a comma-separated `oklch()`,
   * which CSS has no such grammar for, and a half-comma `rgb(1 2, 3)` both
   * passed a check whose own doc comment said it rejected them.
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
    'rgb(1 2 3 4)',
    'oklch(0.5 0.1 200 0.4)',
    'oklch(0.5, 0.1, 200)',
    'rgb(1 2, 3)',
    'rgb(1, 2, 3 / 0.5)',
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

/**
 * The accepted set is a deliberate spec decision and stays exactly as it is.
 * What changes is the sentence: a theme ported from VS Code routinely carries
 * `rgba()`, and "is not a colour the Hive can read" reads as *cannot parse
 * that*, sending its author hunting for a typo that is not there.
 */
describe('a recognised but unsupported colour family', () => {
  it.each(['rgba(0, 0, 0, 0.3)', 'hsl(210 50% 40%)', 'hsla(210,50%,40%,0.5)', 'lab(50% 40 59)', 'oklab(0.5 0.1 0.1)', 'color(display-p3 1 0 0)'])(
    'names %s as unsupported rather than unreadable',
    (colour) => {
      const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
      modes.light.ui.panel = colour;

      const result = importTheme(fullTheme({ modes }), 'ported.json');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.detail).toContain('modes.light.ui.panel');
      expect(result.detail).toContain('which the Hive does not read');
      // And it says what would work, so there is something to do about it.
      expect(result.detail).toContain('rgb() or oklch()');
    },
  );

  it('still gives a malformed rgb()/oklch() the plain message', () => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    modes.light.ui.panel = 'oklch(nonsense)';

    const result = importTheme(fullTheme({ modes }), 'typo.json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The family *is* supported — this one really is unreadable.
    expect(result.detail).toBe(
      'modes.light.ui.panel is not a colour the Hive can read.',
    );
  });
});

describe('the caps on hostile input', () => {
  /**
   * Every unknown key used to become its own sentence in a string the banner
   * renders as one joined paragraph, so a file carrying thousands produced a
   * banner measured in megabytes.
   */
  it('names at most ten unknown keys and counts the rest', () => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    for (let i = 0; i < 50; i += 1) modes.dark.ui[`bogus${i}`] = '#123456';

    const result = importTheme(fullTheme({ modes }), 'noisy.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const named = result.notes.filter((note) => note.includes('bogus'));
    expect(named).toHaveLength(10);
    expect(result.notes).toContain('40 further unrecognised keys were ignored.');
  });

  it('says "key was" for a single remainder', () => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    for (let i = 0; i < 11; i += 1) modes.dark.ui[`bogus${i}`] = '#123456';

    const result = importTheme(fullTheme({ modes }), 'noisy.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes).toContain('1 further unrecognised key was ignored.');
  });

  /**
   * The cap is named in bytes and `String.length` counts UTF-16 code units.
   * A file of CJK text could be three times the cap and still pass — and on
   * the browser target nothing else is checking, since it is main's `stat()`
   * that gates the desktop import.
   */
  it('measures the size ceiling in bytes, not code units', () => {
    // Just under the cap in code units, comfortably over it in UTF-8 bytes:
    // every one of these characters costs three.
    const overInBytes = '日'.repeat(MAX_THEME_BYTES - 1);
    expect(overInBytes.length).toBeLessThan(MAX_THEME_BYTES);

    const result = importTheme(overInBytes, 'huge.json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('256 KB');
  });

  it('still admits an ASCII file right up to the cap', () => {
    const json = fullTheme();
    expect(utf8ByteLength(json)).toBeLessThanOrEqual(MAX_THEME_BYTES);
    expect(importTheme(json, 'ok.json').ok).toBe(true);
  });
});

/**
 * The gate on the way *back out* of `localStorage`, which `importTheme` alone
 * could never be: valid JSON of the wrong shape parses perfectly, and the
 * store rehydrates from a place another tab, a devtools session or an
 * interrupted write can all reach.
 */
describe('isHiveTheme', () => {
  it('accepts a theme importTheme produced', () => {
    const result = importTheme(fullTheme(), 'nord.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isHiveTheme(result.theme)).toBe(true);
  });

  it.each([
    { label: 'null', value: null as unknown },
    { label: 'an array', value: [] as unknown },
    { label: 'a string', value: 'nord' as unknown },
    { label: 'a bare name', value: { hiveThemeVersion: 1, name: 'Nord' } as unknown },
    { label: 'a future version', value: { ...BUILT_IN_THEME, hiveThemeVersion: 2 } as unknown },
    { label: 'no author', value: { ...BUILT_IN_THEME, author: undefined } as unknown },
    { label: 'no modes', value: { ...BUILT_IN_THEME, modes: undefined } as unknown },
  ])('rejects $label', ({ value }) => {
    expect(isHiveTheme(value)).toBe(false);
  });

  it('rejects a theme missing one mode', () => {
    const half = structuredClone(BUILT_IN_THEME) as Record<string, any>;
    delete half.modes.light;
    expect(isHiveTheme(half)).toBe(false);
  });

  it('rejects a theme missing one group', () => {
    const partial = structuredClone(BUILT_IN_THEME) as Record<string, any>;
    delete partial.modes.dark.terminal;
    expect(isHiveTheme(partial)).toBe(false);
  });

  it('rejects a theme missing a single key', () => {
    const partial = structuredClone(BUILT_IN_THEME) as Record<string, any>;
    delete partial.modes.dark.ui.panel;
    expect(isHiveTheme(partial)).toBe(false);
  });

  it('rejects a theme whose colour is not a colour', () => {
    const broken = structuredClone(BUILT_IN_THEME) as Record<string, any>;
    broken.modes.light.syntax.keyword = 'rgba(0,0,0,0.3)';
    expect(isHiveTheme(broken)).toBe(false);
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

  /**
   * `brand` became body text with the hierarchy pass — it names every project
   * in the rail and every provider in Integrations, on `panel` in both cases —
   * so it is held to the body-text threshold like `ink`.
   *
   * The case this exists for is an imported theme: nothing stops one shipping a
   * brand that vanishes into its own panel, and before this the format had no
   * way to say so. All seven built-ins clear it, 5.15:1 at worst.
   */
  it('notes a brand that disappears into its own panel', () => {
    const modes = structuredClone(BUILT_IN_THEME.modes) as Record<string, any>;
    // A brand one shade off the dark panel it is painted on.
    modes.dark.ui.brand = '#1a2038';

    const result = importTheme(fullTheme({ modes }), 'invisible.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.notes.some((note) => note.includes('brand on panel')),
    ).toBe(true);
  });

  it('says nothing about a brand that clears the floor', () => {
    const result = importTheme(fullTheme(), 'built-in.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.notes.some((note) => note.includes('brand on panel')),
    ).toBe(false);
  });
});
