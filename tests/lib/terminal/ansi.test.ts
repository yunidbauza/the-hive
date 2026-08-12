import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SGR_RESET,
  buildXtermTheme,
  TERM,
  TERM_LIGHT,
  XTERM_THEME,
  XTERM_THEME_LIGHT,
  colorize,
  toSgrIndexed,
} from '@lib/terminal/ansi';

const ESC = '\u001b';

// Resolved from the Vitest root rather than `import.meta.url`: under happy-dom,
// `import.meta.url` is an http URL, not a file one.
const tokens = readFileSync(
  resolve(process.cwd(), 'src/styles/tokens.css'),
  'utf8',
);

/** Pull `--cc-name: #value;` pairs out of the light-theme block. */
function lightTokens(): Record<string, string> {
  const start = tokens.search(/body\[data-theme='light'\]\s*\{/);
  expect(start, 'light block missing from tokens.css').toBeGreaterThan(-1);
  const block = tokens.slice(start, tokens.indexOf('\n}', start));

  const parsed: Record<string, string> = {};
  for (const m of block.matchAll(/(--cc-[a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,8})/gi)) {
    parsed[m[1]] = m[2].toLowerCase();
  }
  return parsed;
}

describe('TERM palette (dark)', () => {
  /**
   * These hexes are quoted in the story, in `.claude/DESIGN-SYSTEM.md`, and on
   * screen. Pinning them here means a drift shows up as a failing test rather
   * than as a terminal that quietly looks wrong.
   */
  it('matches the documented values', () => {
    expect(TERM).toEqual({
      ink: '#dbe4ff',
      dim: '#7c88b8',
      green: '#7ee2b8',
      blue: '#8fb5ff',
      amber: '#ffc06e',
      red: '#ff8d85',
      cyan: '#7edce2',
      magenta: '#7edce2',
      black: '#0b1023',
      bg: '#0b1023',
      selection: '#222c55',
    });
  });

  it('keeps its text colours out of CSS', () => {
    /**
     * The *dark* terminal text palette is deliberately distinct from the UI
     * palette — TERM.green is not --cc-green, TERM.amber is not --cc-amber —
     * because text on a dark canvas needs more lift than the same semantic
     * colour does in chrome. A dark text colour appearing in tokens.css means
     * someone has started a second, drifting source of truth.
     *
     * The light palette is the opposite by design and is checked below: it
     * *must* mirror tokens.css, because it shares its ground with the editor.
     *
     * Three surface colours legitimately coincide with CSS tokens and are
     * excluded: `bg` is --cc-term-bg, `selection` is --cc-active, and `red`
     * is shared with --cc-red. All three come straight from the concept.
     */
    const textColors = ['ink', 'dim', 'green', 'blue', 'amber', 'cyan'] as const;

    for (const color of textColors) {
      expect(tokens, `TERM.${color} leaked into tokens.css`).not.toContain(
        TERM[color],
      );
    }
  });
});

describe('TERM_LIGHT palette', () => {
  /**
   * The mirror that makes the duplication safe.
   *
   * Every light terminal colour is also a `--cc-*` token, because the light
   * terminal shares the editor's ground and inventing a second light identity
   * would be the actual bug. xterm cannot read a custom property, so the value
   * has to exist twice — and this test is what stops the two copies drifting.
   */
  it('mirrors the light tokens in tokens.css', () => {
    const light = lightTokens();

    const mirror: Record<keyof typeof TERM_LIGHT, string> = {
      ink: '--cc-ink',
      dim: '--cc-term-head',
      green: '--cc-code-string',
      blue: '--cc-code-name',
      amber: '--cc-code-number',
      red: '--cc-code-constant',
      cyan: '--cc-code-type',
      magenta: '--cc-code-keyword',
      black: '--cc-ink',
      bg: '--cc-term-bg',
      selection: '--cc-code-selection',
    };

    for (const [key, token] of Object.entries(mirror)) {
      expect(
        light[token],
        `tokens.css is missing ${token}, which TERM_LIGHT.${key} mirrors`,
      ).toBeDefined();
      expect(
        TERM_LIGHT[key as keyof typeof TERM_LIGHT],
        `TERM_LIGHT.${key} has drifted from ${token}`,
      ).toBe(light[token]);
    }
  });

  /**
   * xterm paints its own background; the DOM paints the padding around it.
   * If these two disagree, a rectangle appears at the terminal's edge.
   */
  it('grounds the terminal on the same colour the DOM does', () => {
    expect(TERM_LIGHT.bg).toBe(lightTokens()['--cc-term-bg']);
  });

  it('clears WCAG AA against its own background for every text colour', () => {
    const luminance = (hex: string) => {
      const channels = [0, 2, 4]
        .map((i) => Number.parseInt(hex.slice(1 + i, 3 + i), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return (
        0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
      );
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    const textColors = [
      'ink', 'dim', 'green', 'blue', 'amber', 'red', 'cyan', 'magenta',
    ] as const;

    for (const color of textColors) {
      const ratio = contrast(TERM_LIGHT[color], TERM_LIGHT.bg);
      expect(
        ratio,
        `TERM_LIGHT.${color} is ${ratio.toFixed(2)}:1 on the light ground`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('toSgrIndexed', () => {
  /**
   * Indices, not truecolor. A baked `38;2;r;g;b` cannot be re-themed after the
   * fact — xterm stores the RGB in the cell — so an indexed escape is what lets
   * a theme switch repaint scrollback written minutes ago.
   */
  it('selects the ANSI slot for each transcript colour', () => {
    expect(toSgrIndexed('red')).toBe(`${ESC}[31m`);
    expect(toSgrIndexed('green')).toBe(`${ESC}[32m`);
    expect(toSgrIndexed('amber')).toBe(`${ESC}[33m`);
    expect(toSgrIndexed('blue')).toBe(`${ESC}[34m`);
    expect(toSgrIndexed('cyan')).toBe(`${ESC}[36m`);
    expect(toSgrIndexed('dim')).toBe(`${ESC}[90m`);
  });

  it('maps ink to the default foreground rather than to white', () => {
    // An unstyled transcript line should be whatever the theme calls
    // foreground, in either theme.
    expect(toSgrIndexed('ink')).toBe(`${ESC}[39m`);
  });

  it('never emits a truecolor escape', () => {
    for (const color of [
      'ink', 'dim', 'green', 'blue', 'amber', 'red', 'cyan',
    ] as const) {
      expect(toSgrIndexed(color)).not.toContain('38;2;');
    }
  });
});

describe('colorize', () => {
  it('wraps text in the colour escape and resets afterwards', () => {
    expect(colorize('boom', 'red')).toBe(`${ESC}[31mboom${SGR_RESET}`);
  });

  it('resets so a colour cannot bleed into the next line', () => {
    expect(colorize('ok', 'green').endsWith(SGR_RESET)).toBe(true);
  });

  it('emits a theme-resolvable slot for every supported colour', () => {
    for (const color of [
      'ink', 'dim', 'green', 'blue', 'amber', 'red', 'cyan',
    ] as const) {
      expect(colorize('x', color)).toContain(toSgrIndexed(color));
      // The point of the whole exercise: nothing baked in.
      expect(colorize('x', color)).not.toContain('38;2;');
    }
  });
});

describe('XTERM_THEME', () => {
  it('is built from the palette rather than repeating hexes', () => {
    expect(XTERM_THEME.background).toBe(TERM.bg);
    expect(XTERM_THEME.foreground).toBe(TERM.ink);
    expect(XTERM_THEME.selectionBackground).toBe(TERM.selection);
  });

  /**
   * The guard on this whole change: light mode was added by *extending* the
   * theme builder, not by editing the dark values. Every dark slot is spelled
   * out so a future palette refactor cannot quietly restyle dark mode.
   */
  it('is unchanged by the arrival of a light theme', () => {
    expect(XTERM_THEME).toEqual({
      background: '#0b1023',
      foreground: '#dbe4ff',
      selectionBackground: '#222c55',
      cursor: '#dbe4ff',
      cursorAccent: '#0b1023',
      black: '#0b1023',
      red: '#ff8d85',
      green: '#7ee2b8',
      yellow: '#ffc06e',
      blue: '#8fb5ff',
      magenta: '#7edce2',
      cyan: '#7edce2',
      white: '#dbe4ff',
      brightBlack: '#7c88b8',
      brightRed: '#ff8d85',
      brightGreen: '#7ee2b8',
      brightYellow: '#ffc06e',
      brightBlue: '#8fb5ff',
      brightMagenta: '#7edce2',
      brightCyan: '#7edce2',
      brightWhite: '#dbe4ff',
    });
  });
});

describe('XTERM_THEME_LIGHT', () => {
  it('is built from the light palette', () => {
    expect(XTERM_THEME_LIGHT.background).toBe(TERM_LIGHT.bg);
    expect(XTERM_THEME_LIGHT.foreground).toBe(TERM_LIGHT.ink);
    expect(XTERM_THEME_LIGHT.selectionBackground).toBe(TERM_LIGHT.selection);
  });

  it('has the same shape as the dark theme', () => {
    // One builder, two palettes — so the themes can differ in colour but never
    // in which slots they define.
    expect(Object.keys(XTERM_THEME_LIGHT).sort()).toEqual(
      Object.keys(XTERM_THEME).sort(),
    );
  });

  it('maps white to readable ink, not to the background', () => {
    // A program emitting ANSI 37 means "ordinary text" and must get ordinary
    // text — invisible white-on-white is the classic light-terminal failure.
    expect(XTERM_THEME_LIGHT.white).toBe(TERM_LIGHT.ink);
    expect(XTERM_THEME_LIGHT.brightWhite).toBe(TERM_LIGHT.ink);
  });

  /**
   * The mirror-image failure, and the one that actually bites.
   *
   * xterm answers an OSC 11 background query with `theme.background`, so a CLI
   * that detects a light terminal will *choose* ANSI 30 for body text. Mapped
   * to the background — which is what mirroring dark's `black: bg` would do —
   * that renders at 1:1, and `minimumContrastRatio` defaults to 1, so nothing
   * corrects it.
   */
  it('never maps black to the background it is painted on', () => {
    expect(XTERM_THEME_LIGHT.black).not.toBe(XTERM_THEME_LIGHT.background);
    expect(XTERM_THEME_LIGHT.black).toBe(TERM_LIGHT.ink);
  });
});

describe('the block cursor', () => {
  /**
   * `cursorAccent` is the glyph *under* a block cursor, and xterm defaults it
   * to `#000000`. Dark mode was safe only by accident — its cursor is light, so
   * a black glyph read fine. A light theme whose cursor is `#2c2f34` put
   * near-black on near-black (1.56:1): the character under the caret vanished
   * while you typed.
   */
  it.each(['dark', 'light'] as const)(
    'punches the glyph out of the cursor in the surface colour (%s)',
    (theme) => {
      const built = buildXtermTheme(theme);
      expect(built.cursorAccent).toBe(built.background);
      expect(built.cursorAccent).not.toBe(built.cursor);
    },
  );
});

describe('buildXtermTheme', () => {
  it('returns the dark palette for the dark app theme', () => {
    expect(buildXtermTheme('dark')).toEqual({ ...XTERM_THEME });
  });

  /**
   * The inversion of the old rule.
   *
   * Stories 011 and 042 pinned the terminal dark in both themes, and a test
   * here restated that so a future change would "have to argue with something".
   * This is that argument, settled: the terminal shares the centre stage with
   * an editor that follows the theme, and a dark slab in a light app reads as a
   * panel that failed to load.
   */
  it('follows the app theme into light mode', () => {
    expect(buildXtermTheme('light').background).toBe(TERM_LIGHT.bg);
    expect(buildXtermTheme('light').foreground).toBe(TERM_LIGHT.ink);
  });

  it('gives light mode a light ground and dark mode a dark one', () => {
    expect(buildXtermTheme('light').background).not.toBe(
      buildXtermTheme('dark').background,
    );
  });

  it('hands out a fresh object each call', () => {
    // xterm copies the theme into its own colour manager; a shared singleton
    // that someone mutated would corrupt every live terminal at once.
    expect(buildXtermTheme('dark')).not.toBe(buildXtermTheme('dark'));
    expect(buildXtermTheme('light')).not.toBe(buildXtermTheme('light'));
  });
});
