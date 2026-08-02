import type { TermColor } from '@/types/terminal';

/**
 * Terminal text palette and the ANSI colorizer.
 *
 * The palette is deliberately NOT in `@theme`: these values never reach CSS.
 * xterm resolves colours from its own JS `theme` option and paints them into
 * markup it owns, so a CSS custom property declared on `:root` has no path to
 * a terminal cell. (Earlier revisions of this file said "paints to a canvas".
 * That reason was wrong even though the conclusion holds: xterm 6 core ships
 * the DOM renderer and this app installs no canvas or WebGL addon. The palette
 * has to be JS either way.)
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
 * The xterm `theme` object — the dark, default form.
 *
 * The terminal keeps its dark background in light mode, like the concept and
 * most real tools, so this is what both app themes are built from. Only the
 * chrome that has to survive a bright surround varies; see `buildXtermTheme`.
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

/** App theme. Mirrors `Theme` in `stores/ui-store.ts`, without importing it. */
export type TerminalTheme = 'dark' | 'light';

/**
 * Selection and cursor, brightened for light mode.
 *
 * Story 011 fixed the terminal as permanently dark, and story 042 narrowed the
 * theme-toggle requirement to match: "only selection/cursor tint may vary".
 * This is that variation, and it is not decoration. Against a bright page the
 * eye arrives at the terminal already adapted to a light surround, and the dark
 * selection wash (`#222c55`) reads as almost no highlight at all — the one
 * piece of terminal chrome the user manipulates directly becomes the hardest to
 * see. Lifting selection and cursor keeps them legible without touching the
 * background or a single text colour.
 */
const LIGHT_CHROME = {
  selectionBackground: '#33407a',
  cursor: TERM.green,
} as const;

/**
 * The xterm theme for an app theme.
 *
 * Returned fresh each call rather than memoised: xterm copies the object into
 * its own colour manager on assignment, so sharing an instance buys nothing and
 * an accidentally mutated singleton would corrupt every live terminal at once.
 */
export function buildXtermTheme(theme: TerminalTheme) {
  return theme === 'light'
    ? { ...XTERM_THEME, ...LIGHT_CHROME }
    : { ...XTERM_THEME };
}
