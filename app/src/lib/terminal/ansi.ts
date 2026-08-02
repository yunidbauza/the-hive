import type { TermColor } from '@/types/terminal';

/**
 * Terminal text palette and the ANSI colorizer.
 *
 * The palette is deliberately NOT in `@theme`: these values never reach CSS.
 * They are consumed as JS by xterm's `theme` option and by the colorizer below,
 * because xterm paints to a canvas that CSS custom properties cannot reach.
 *
 * One definition, three consumers: the transport, the xterm theme, and
 * `.claude/DESIGN-SYSTEM.md` (story 015, whose values are asserted against
 * these).
 */
export const TERM = {
  ink: '#dbe4ff', // default foreground
  dim: '#7c88b8', // secondary / meta
  green: '#7ee2b8', // success, prompts
  blue: '#8fb5ff', // tool calls (Read/Edit/Bash lines)
  amber: '#ffc06e', // working spinner, questions
  red: '#ff8d85', // errors
  cyan: '#7edce2', // orchestrator-injected lines, PR refs
  bg: '#0b1023',
  selection: '#222c55',
} as const;

export type { TermColor };

const ESC = '\u001b';

/** Reset all SGR attributes. */
export const SGR_RESET = `${ESC}[0m`;

/** Convert `#rrggbb` to the SGR truecolor escape that sets it as foreground. */
export function toSgrForeground(hex: string): string {
  const normalized = hex.replace('#', '');
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `${ESC}[38;2;${red};${green};${blue}m`;
}

/** Wrap `text` in the truecolor escape for `color`, then reset. */
export function colorize(text: string, color: TermColor): string {
  return `${toSgrForeground(TERM[color])}${text}${SGR_RESET}`;
}

/**
 * The xterm `theme` object.
 *
 * Not theme-dependent: the terminal keeps its dark background in light mode,
 * like the concept and most real tools.
 */
export const XTERM_THEME = {
  background: TERM.bg,
  foreground: TERM.ink,
  selectionBackground: TERM.selection,
  cursor: TERM.ink,
  black: TERM.bg,
  red: TERM.red,
  green: TERM.green,
  yellow: TERM.amber,
  blue: TERM.blue,
  magenta: TERM.cyan,
  cyan: TERM.cyan,
  white: TERM.ink,
  brightBlack: TERM.dim,
  brightRed: TERM.red,
  brightGreen: TERM.green,
  brightYellow: TERM.amber,
  brightBlue: TERM.blue,
  brightMagenta: TERM.cyan,
  brightCyan: TERM.cyan,
  brightWhite: TERM.ink,
} as const;
