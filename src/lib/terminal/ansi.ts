import type { TermColor } from '@/types/terminal';

/**
 * Terminal text palettes and the ANSI colorizer.
 *
 * The palettes are deliberately NOT in `@theme`: these values never reach CSS.
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

/**
 * The shape a palette has to fill for `xtermThemeFor` to build a theme from it.
 *
 * Nine text/surface roles, which is what the sixteen ANSI slots collapse to
 * once bright and normal share a hue — see `xtermThemeFor`.
 */
export interface TermPalette {
  ink: string;
  dim: string;
  green: string;
  blue: string;
  amber: string;
  red: string;
  cyan: string;
  magenta: string;
  black: string;
  bg: string;
  selection: string;
}

/** The dark palette — the app's original terminal colours, unchanged. */
export const TERM = {
  ink: '#dbe4ff', // default foreground
  dim: '#7c88b8', // secondary / meta
  green: '#7ee2b8', // success, prompts
  blue: '#8fb5ff', // tool calls (Read/Edit/Bash lines)
  amber: '#ffc06e', // working spinner, questions
  red: '#ff8d85', // errors
  cyan: '#7edce2', // orchestrator-injected lines, PR refs
  /**
   * Equal to `cyan`, and that is not an oversight.
   *
   * The concept never specified a magenta, so the ANSI magenta slot has always
   * rendered as cyan here. Naming it rather than leaving `magenta: TERM.cyan`
   * buried in the theme builder lets the light palette give the slot a real
   * hue without changing a single dark-mode pixel.
   */
  magenta: '#7edce2',
  /**
   * ANSI slot 30, which on a dark ground is the background — as it is in every
   * dark terminal theme, and as it has always been here.
   *
   * Named rather than left as `black: bg` in the builder because the light
   * palette cannot do the same thing: see `TERM_LIGHT.black`.
   */
  black: '#0b1023',
  bg: '#0b1023',
  selection: '#222c55',
} as const satisfies TermPalette;

/**
 * The light palette.
 *
 * **Every value here is also a `--cc-*` token in `tokens.css`**, which is the
 * exact opposite of the arrangement the dark palette has — and it is
 * deliberate. The dark terminal needs more lift than the chrome around it
 * (`TERM.green` is not `--cc-green`, and `ansi.test.ts` enforces that), because
 * dark text colours are tuned against a near-black canvas that no panel shares.
 *
 * A light terminal has no such problem: it sits on the same near-white ground
 * as the editor, so the colours the editor already proved on that ground are
 * the right ones, and inventing a second set would mean two light identities in
 * one app. The duplication is a *mirror*, not a fork — `ansi.test.ts` reads
 * `tokens.css` and fails if the two ever drift.
 */
export const TERM_LIGHT = {
  ink: '#2c2f34', // --cc-ink
  /**
   * `--cc-term-head`, not `--cc-muted`, and the four-step difference is a
   * contrast fix rather than a preference.
   *
   * `--cc-muted` (#73767c) is calibrated against `--cc-panel` (#ffffff), where
   * it clears AA at 4.55:1. The terminal's ground is `--cc-panel-2` (#f7fafb),
   * and on it the same grey falls to 4.34:1 — under the line. `dim` carries the
   * session-lifecycle notices ("── session exited ──"), which is text a user
   * has to read, so it gets a grey chosen for the surface it actually sits on:
   * 4.87:1 here, 5.11:1 on the input bar.
   */
  dim: '#6b6e74', // --cc-term-head
  green: '#2e6b52', // --cc-code-string
  blue: '#334fa9', // --cc-code-name
  amber: '#a1541a', // --cc-code-number
  red: '#b3271f', // --cc-code-constant
  cyan: '#0b6b7d', // --cc-code-type
  magenta: '#6f42c1', // --cc-code-keyword
  /**
   * ANSI slot 30 — dark ink here, **not** the background.
   *
   * This is the one slot where mirroring dark's mapping would be actively
   * wrong. On a dark ground `black: bg` is invisible and harmless, because no
   * program picks black for body text against black. On a light ground black is
   * the conventional choice for exactly that — and xterm answers an OSC 11
   * background query with the theme background, so a CLI that detects a light
   * terminal will now *choose* slot 30 and, mapped to `bg`, render 1:1
   * invisible text. `minimumContrastRatio` is at its default of 1 and would not
   * rescue it.
   */
  black: '#2c2f34', // --cc-ink
  bg: '#f7fafb', // --cc-panel-2, and --cc-term-bg in light
  selection: '#cfe3f7', // --cc-code-selection
} as const satisfies TermPalette;

export type { TermColor };

/** App theme. Mirrors `Theme` in `stores/ui-store.ts`, without importing it. */
export type TerminalTheme = 'dark' | 'light';


const ESC = '\u001b';

/** Reset all SGR attributes. */
export const SGR_RESET = `${ESC}[0m`;

/**
 * Transcript colour → ANSI colour *index*.
 *
 * Indices, not truecolor, and this is the whole reason a theme switch can
 * repaint scrollback that was written minutes ago. An SGR escape carrying a
 * literal `38;2;r;g;b` bakes the colour into the stream at the moment the line
 * is emitted; xterm stores that RGB value in the cell and no later change of
 * `terminal.options.theme` can reach it. An index stores the *slot*, and the
 * slot is resolved against the active theme at paint time — so the same
 * scrollback renders pastel-on-navy in dark mode and ink-on-paper in light,
 * with nothing rewritten.
 *
 * `ink` maps to 39 (default foreground) rather than to white, so a line the
 * transcript considers unstyled is whatever the theme calls foreground.
 */
const SGR_INDEX: Record<TermColor, number> = {
  ink: 39, // default foreground
  dim: 90, // brightBlack
  green: 32,
  blue: 34,
  amber: 33, // yellow
  red: 31,
  cyan: 36,
};

/** The SGR escape that selects `color`'s slot as the foreground. */
export function toSgrIndexed(color: TermColor): string {
  return `${ESC}[${SGR_INDEX[color]}m`;
}

/** Wrap `text` in the escape for `color`'s slot, then reset. */
export function colorize(text: string, color: TermColor): string {
  return `${toSgrIndexed(color)}${text}${SGR_RESET}`;
}

/**
 * A palette → the xterm `theme` object.
 *
 * One mapping for both themes rather than two hand-written objects, so a light
 * theme cannot drift from the dark one in structure — only in colour.
 *
 * Bright and normal share a hue on every slot but black. Sixteen distinguishable
 * colours is a terminal convention inherited from hardware, not a design goal:
 * doubling the palette would mean choosing and contrast-checking seven more
 * colours to serve programs that mostly emit the normal eight.
 *
 * `white: ink` is the mapping worth explaining, because in the light palette it
 * reads as inverted. It is not. A program emitting ANSI 37 ("white") means
 * *ordinary text*, and it gets ordinary text — dark ink on the light ground.
 * Invisible white-on-white is the classic light-terminal failure, and this is
 * how it is avoided. `black` is per-palette for the mirror-image reason; see
 * `TERM_LIGHT.black`.
 *
 * `cursorAccent` is the glyph *under* a block cursor, and it has to be set.
 * xterm defaults it to `#000000` and emits
 * `.xterm-cursor-block { background-color: cursor; color: cursorAccent }`, so
 * leaving it unset put near-black text on the light theme's `#2c2f34` cursor —
 * 1.56:1, i.e. the character under the caret disappears while you type. Dark
 * was safe only by accident, its cursor being light. Binding it to `bg` is
 * correct in both themes: the glyph is punched out of the cursor in the colour
 * of the surface behind it.
 */
function xtermThemeFor(palette: TermPalette) {
  return {
    background: palette.bg,
    foreground: palette.ink,
    selectionBackground: palette.selection,
    cursor: palette.ink,
    cursorAccent: palette.bg,
    black: palette.black,
    red: palette.red,
    green: palette.green,
    yellow: palette.amber,
    blue: palette.blue,
    magenta: palette.magenta,
    cyan: palette.cyan,
    white: palette.ink,
    brightBlack: palette.dim,
    brightRed: palette.red,
    brightGreen: palette.green,
    brightYellow: palette.amber,
    brightBlue: palette.blue,
    brightMagenta: palette.magenta,
    brightCyan: palette.cyan,
    brightWhite: palette.ink,
  };
}

/** The xterm `theme` object for dark mode. */
export const XTERM_THEME = xtermThemeFor(TERM);

/** The xterm `theme` object for light mode. */
export const XTERM_THEME_LIGHT = xtermThemeFor(TERM_LIGHT);

/**
 * The xterm theme for an app theme.
 *
 * **The terminal follows the app theme.** It did not always: stories 011 and
 * 042 fixed it dark in both, on the reasoning that a terminal is dark because
 * that is what a terminal is, and only selection and cursor were allowed to
 * vary. That held while the terminal was the whole centre of the screen. It
 * stopped holding once the editor landed on the same stage and adopted the
 * theme properly — a light app with one dark slab in the middle reads as a
 * panel that failed to load, not as a deliberate choice, and the seam is most
 * obvious exactly where the two surfaces meet.
 *
 * Returned fresh each call rather than memoised: xterm copies the object into
 * its own colour manager on assignment, so sharing an instance buys nothing and
 * an accidentally mutated singleton would corrupt every live terminal at once.
 */
export function buildXtermTheme(theme: TerminalTheme) {
  return theme === 'light' ? { ...XTERM_THEME_LIGHT } : { ...XTERM_THEME };
}
