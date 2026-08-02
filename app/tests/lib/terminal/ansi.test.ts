import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SGR_RESET,
  TERM,
  XTERM_THEME,
  colorize,
  toSgrForeground,
} from '@lib/terminal/ansi';

const ESC = '\u001b';

describe('TERM palette', () => {
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
      bg: '#0b1023',
      selection: '#222c55',
    });
  });

  it('keeps its text colours out of CSS', () => {
    // Resolved from the Vitest root rather than `import.meta.url`: under
    // happy-dom, `import.meta.url` is an http URL, not a file one.
    const tokens = readFileSync(
      resolve(process.cwd(), 'src/styles/tokens.css'),
      'utf8',
    );

    /**
     * The terminal *text* palette is deliberately distinct from the UI palette
     * — TERM.green is not --cc-green, TERM.amber is not --cc-amber — because
     * text on a dark canvas needs more lift than the same semantic colour does
     * in chrome. A text colour appearing in tokens.css means someone has
     * started a second, drifting source of truth.
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

describe('toSgrForeground', () => {
  it('converts a hex colour to an SGR truecolor escape', () => {
    expect(toSgrForeground('#ff8d85')).toBe(`${ESC}[38;2;255;141;133m`);
  });

  it('accepts a hex without the leading hash', () => {
    expect(toSgrForeground('0b1023')).toBe(`${ESC}[38;2;11;16;35m`);
  });

  it('handles pure black and pure white', () => {
    expect(toSgrForeground('#000000')).toBe(`${ESC}[38;2;0;0;0m`);
    expect(toSgrForeground('#ffffff')).toBe(`${ESC}[38;2;255;255;255m`);
  });
});

describe('colorize', () => {
  it('wraps text in the colour escape and resets afterwards', () => {
    expect(colorize('boom', 'red')).toBe(
      `${toSgrForeground(TERM.red)}boom${SGR_RESET}`,
    );
  });

  it('resets so a colour cannot bleed into the next line', () => {
    expect(colorize('ok', 'green').endsWith(SGR_RESET)).toBe(true);
  });

  it('uses the palette entry for every supported colour', () => {
    for (const color of ['ink', 'dim', 'green', 'blue', 'amber', 'red', 'cyan'] as const) {
      expect(colorize('x', color)).toContain(toSgrForeground(TERM[color]));
    }
  });
});

describe('XTERM_THEME', () => {
  it('is built from the palette rather than repeating hexes', () => {
    expect(XTERM_THEME.background).toBe(TERM.bg);
    expect(XTERM_THEME.foreground).toBe(TERM.ink);
    expect(XTERM_THEME.selectionBackground).toBe(TERM.selection);
  });

  it('keeps the terminal dark — it does not follow the app theme', () => {
    // The concept and most real tools keep the terminal dark in light mode, so
    // this object is intentionally theme-independent.
    expect(XTERM_THEME.background).toBe('#0b1023');
  });
});
