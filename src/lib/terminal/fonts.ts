/**
 * Terminal appearance choices (story 105).
 *
 * Font stacks live here rather than in the appearance store for the same reason
 * `ansi.ts` holds the colour palette: they are terminal facts consumed as JS by
 * xterm's options, and the store should hold the user's *choice*, not the
 * rendering detail behind it.
 *
 * Every face listed ships with an operating system. There is no webfont in this
 * app — the design system declines one even for a heading (`tokens.css`) — and
 * offering "JetBrains Mono" to a machine that lacks it would silently render the
 * fallback, which reads as a broken setting rather than an absent font. Each
 * stack therefore ends in the generic `monospace` so the fallback is a real
 * monospace face and never a proportional one.
 */

/** The stored choice. Stable strings — they are persisted to localStorage. */
export type TerminalFontId =
  | 'system'
  | 'sf-mono'
  | 'menlo'
  | 'monaco'
  | 'consolas'
  | 'courier';

export interface TerminalFontOption {
  id: TerminalFontId;
  label: string;
  stack: string;
}

/**
 * `system` reproduces the stack the terminal has always used, so the default is
 * a rename rather than a change: an existing user sees exactly what they saw.
 */
export const TERMINAL_FONTS: readonly TerminalFontOption[] = [
  {
    id: 'system',
    label: 'System default',
    stack: "ui-monospace, Menlo, 'SF Mono', monospace",
  },
  { id: 'sf-mono', label: 'SF Mono', stack: "'SF Mono', ui-monospace, monospace" },
  { id: 'menlo', label: 'Menlo', stack: 'Menlo, ui-monospace, monospace' },
  { id: 'monaco', label: 'Monaco', stack: 'Monaco, ui-monospace, monospace' },
  { id: 'consolas', label: 'Consolas', stack: 'Consolas, ui-monospace, monospace' },
  {
    id: 'courier',
    label: 'Courier New',
    stack: "'Courier New', Courier, monospace",
  },
] as const;

export const DEFAULT_TERMINAL_FONT: TerminalFontId = 'system';

/**
 * Resolve a stored id to a stack.
 *
 * Falls back to the system stack rather than throwing: the id comes out of
 * localStorage, which a previous version of the app — or a user with devtools —
 * may have written something else into. A terminal with the default font is a
 * better outcome than a terminal that fails to construct.
 */
export function terminalFontStack(id: TerminalFontId): string {
  const match = TERMINAL_FONTS.find((font) => font.id === id);
  return (match ?? TERMINAL_FONTS[0]).stack;
}

/**
 * Offered sizes, in points.
 *
 * 12.5 is the value the terminal has always used and stays the default. The
 * range stops at 18 because xterm measures a cell per render and the rails are
 * fixed-width — past that the center stage holds too few columns for a build log
 * to be readable, which is the thing the setting exists to help with.
 */
export const TERMINAL_FONT_SIZES: readonly number[] = [
  10, 11, 12, 12.5, 13, 14, 15, 16, 18,
] as const;

export const DEFAULT_TERMINAL_FONT_SIZE = 12.5;

/**
 * Offered scrollback depths, in lines.
 *
 * 5000 is the existing constant and stays the default. The ceiling is a memory
 * decision, not a taste one: this app keeps one live xterm per visited entity,
 * so the number multiplies by thirteen or more.
 */
export const TERMINAL_SCROLLBACKS: readonly number[] = [
  1_000, 5_000, 10_000, 50_000,
] as const;

export const DEFAULT_TERMINAL_SCROLLBACK = 5_000;

/** Thousands-separated, so 50000 reads as a number of lines and not a price. */
export const formatScrollback = (lines: number): string =>
  `${lines.toLocaleString('en-US')} lines`;
