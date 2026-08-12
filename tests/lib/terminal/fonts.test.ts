import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TERMINAL_FONT,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_TERMINAL_SCROLLBACK,
  TERMINAL_FONTS,
  TERMINAL_FONT_SIZES,
  TERMINAL_SCROLLBACKS,
  formatScrollback,
  terminalFontStack,
  type TerminalFontId,
} from '@lib/terminal/fonts';

describe('terminal fonts (story 105)', () => {
  it('every stack ends in a generic monospace fallback', () => {
    // The point of the whole table: a face the machine lacks must fall back to
    // *a monospace face*, never to the proportional default.
    for (const font of TERMINAL_FONTS) {
      expect(font.stack.endsWith('monospace')).toBe(true);
    }
  });

  it('the default is the stack the terminal has always used', () => {
    // A rename, not a change: an existing user must see exactly what they saw.
    expect(DEFAULT_TERMINAL_FONT).toBe('system');
    expect(terminalFontStack('system')).toBe(
      "ui-monospace, Menlo, 'SF Mono', monospace",
    );
  });

  it('resolves each id to its own stack', () => {
    expect(terminalFontStack('menlo')).toContain('Menlo');
    expect(terminalFontStack('consolas')).toContain('Consolas');
  });

  it('falls back to the default for an id that is not in the table', () => {
    // The id comes out of localStorage, which an older build — or a user with
    // devtools — may have written something else into. A default font beats a
    // terminal that fails to construct.
    expect(terminalFontStack('nonsense' as TerminalFontId)).toBe(
      terminalFontStack('system'),
    );
  });

  it('offers the current terminal values as choices', () => {
    expect(TERMINAL_FONT_SIZES).toContain(DEFAULT_TERMINAL_FONT_SIZE);
    expect(TERMINAL_SCROLLBACKS).toContain(DEFAULT_TERMINAL_SCROLLBACK);
  });

  it('formats scrollback as a count of lines, thousands separated', () => {
    expect(formatScrollback(50_000)).toBe('50,000 lines');
    expect(formatScrollback(1_000)).toBe('1,000 lines');
  });
});
