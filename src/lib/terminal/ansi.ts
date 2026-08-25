import type { TermColor } from '@/types/terminal';

import { BUILT_IN_THEME } from '@lib/theme/built-in';

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
 *
 * Since HIVE-80 that one definition lives in `lib/theme/built-in.ts` — the two
 * palettes below are its `terminal` groups under a name, not a second copy —
 * because a user-supplied theme has to fill exactly the same eleven slots. What
 * this module still owns is the *mapping*: eleven roles onto xterm's sixteen
 * ANSI slots, which is {@link xtermThemeFor} and applies to any palette,
 * built-in or imported.
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
  /**
   * The two **surface** roles (HIVE-82).
   *
   * Optional, because every theme exported under HIVE-80 has exactly the eleven
   * keys above and must keep working unchanged. Absent, they are derived from
   * `bg` — see {@link surfacesOf} — so an old file gets sane fills rather than
   * the text colours the ANSI slots used to hand out.
   *
   * `surface` is the terminal's own ground raised by one step; `surfaceAlt` is
   * raised again. They exist because a program painting a *panel* asks the
   * palette for `black` or `brightBlack`, and those were bound to text colours
   * here — which is how a submitted-prompt row became a near-black bar across a
   * white terminal. See {@link xtermThemeFor}.
   */
  surface?: string;
  surfaceAlt?: string;
}

/**
 * The dark palette — the app's original terminal colours, unchanged.
 *
 * The values are the built-in theme's dark `terminal` group, byte for byte what
 * this file spelled out before HIVE-80. Held as a reference rather than a copy
 * for two reasons: one source of truth, and **referential stability** — the
 * surface re-themes on a change of palette *identity*, so a palette rebuilt per
 * render would re-theme every live terminal on every render.
 *
 * The roles, in the order the group declares them: `bg` ground, `ink` default
 * foreground, `dim` secondary/meta, `black` ANSI slot 30, `green` success and
 * prompts, `blue` tool calls (Read/Edit/Bash lines), `amber` the working
 * spinner and questions, `red` errors, `cyan` orchestrator-injected lines and
 * PR refs, `magenta`, `selection`.
 *
 * Two of those look like oversights and are not:
 *
 * - **`magenta` equals `cyan`.** The concept never specified a magenta, so the
 *   ANSI magenta slot has always rendered as cyan here. The slot is named
 *   rather than left as `magenta: TERM.cyan` in the theme builder so the light
 *   palette can give it a real hue without changing a single dark-mode pixel.
 * - **`black` equals `bg`.** ANSI slot 30, which on a dark ground is the
 *   background — as it is in every dark terminal theme, and as it has always
 *   been here. Named rather than left as `black: bg` in the builder because the
 *   light palette cannot do the same thing: see {@link TERM_LIGHT}.
 */
export const TERM = BUILT_IN_THEME.modes.dark.terminal satisfies TermPalette;

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
 *
 * The mapping, slot by slot: `ink` and `black` are `--cc-ink`, `green` is
 * `--cc-code-string`, `blue` `--cc-code-name`, `amber` `--cc-code-number`,
 * `red` `--cc-code-constant`, `cyan` `--cc-code-type`, `magenta`
 * `--cc-code-keyword`, `bg` `--cc-panel-2` (and `--cc-term-bg` in light), and
 * `selection` `--cc-code-selection`. Two of them need a reason:
 *
 * - **`dim` is `--cc-term-head`, not `--cc-muted`**, and the four-step
 *   difference is a contrast fix rather than a preference. `--cc-muted`
 *   (#73767c) is calibrated against `--cc-panel` (#ffffff), where it clears AA
 *   at 4.55:1. The terminal's ground is `--cc-panel-2` (#f7fafb), and on it the
 *   same grey falls to 4.34:1 — under the line. `dim` carries the
 *   session-lifecycle notices ("── session exited ──"), which is text a user
 *   has to read, so it gets a grey chosen for the surface it actually sits on:
 *   4.87:1 here, 5.11:1 on the input bar.
 * - **`black` is dark ink, *not* the background.** This is the one slot where
 *   mirroring dark's mapping would be actively wrong. On a dark ground
 *   `black: bg` is invisible and harmless, because no program picks black for
 *   body text against black. On a light ground black is the conventional choice
 *   for exactly that — and xterm answers an OSC 11 background query with the
 *   theme background, so a CLI that detects a light terminal will *choose* slot
 *   30 and, mapped to `bg`, render 1:1 invisible text. `minimumContrastRatio`
 *   is at its default of 1 and would not rescue it.
 *
 * Sourced from the built-in theme, and held as a reference rather than a copy,
 * for the reasons given on {@link TERM}.
 */
export const TERM_LIGHT = BUILT_IN_THEME.modes.light
  .terminal satisfies TermPalette;

export type { TermColor };


const ESC = '\u001b';

/**
 * Where the transcript's `dim` lives now: 256-colour index 244 (HIVE-82).
 *
 * It used to be slot 90, `brightBlack`. That slot is a **surface** since
 * HIVE-82 — a program painting a panel asks for it — so leaving the app's own
 * secondary text there would have put a fill colour on a fill colour.
 *
 * 244 rather than a number picked at random: it is a mid-grey in the standard
 * 256-colour ramp, so a third-party program that happens to emit it gets
 * something close to what it asked for. And unlike the sixteen base slots, the
 * extended range carries no competing convention to break.
 *
 * Still an *index*, which is the whole point — see {@link SGR_INDEX}. It
 * resolves from `extendedAnsi` at paint time, so a theme toggle repaints
 * transcript text written minutes ago.
 */
const DIM_INDEX = 244;

/**
 * The two surface colours a palette actually paints with.
 *
 * Derived from `bg` when a theme does not carry them, which is every theme
 * exported before HIVE-82. Blending toward `ink` rather than toward white or
 * black is what makes one rule serve both modes: a dark theme's ground moves
 * up, a light theme's moves down, and neither has to know which it is.
 */
export function surfacesOf(palette: TermPalette): {
  surface: string;
  surfaceAlt: string;
} {
  return {
    surface: palette.surface ?? mix(palette.bg, palette.ink, 0.05),
    surfaceAlt: palette.surfaceAlt ?? mix(palette.bg, palette.ink, 0.11),
  };
}

/** `#rrggbb` → the three channels. Anything else answers black, not a throw. */
function channels(hex: string): [number, number, number] {
  const raw = hex.replace('#', '');
  if (raw.length !== 6) return [0, 0, 0];
  return [
    Number.parseInt(raw.slice(0, 2), 16),
    Number.parseInt(raw.slice(2, 4), 16),
    Number.parseInt(raw.slice(4, 6), 16),
  ];
}

/** `amount` of `toward`, blended into `base`. */
function mix(base: string, toward: string, amount: number): string {
  const from = channels(base);
  const to = channels(toward);
  const channel = (index: number): string =>
    Math.round(from[index]! + (to[index]! - from[index]!) * amount)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

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
  dim: DIM_INDEX,
  green: 32,
  blue: 34,
  amber: 33, // yellow
  red: 31,
  cyan: 36,
};

/** The SGR escape that selects `color`'s slot as the foreground. */
export function toSgrIndexed(color: TermColor): string {
  const slot = SGR_INDEX[color];
  /*
    256-colour form for `dim`, plain SGR for the rest. `38;5;n` is the only
    spelling that reaches an `extendedAnsi` entry, and 39/32/34/33/31/36 are
    single parameters that would be wrong in that form.
  */
  return slot === DIM_INDEX ? `${ESC}[38;5;${slot}m` : `${ESC}[${slot}m`;
}

/** Wrap `text` in the escape for `color`'s slot, then reset. */
export function colorize(text: string, color: TermColor): string {
  return `${toSgrIndexed(color)}${text}${SGR_RESET}`;
}

/**
 * A palette → the xterm `theme` object.
 *
 * One mapping for every palette rather than a hand-written object per theme, so
 * two palettes cannot drift in structure — only in colour. Since HIVE-80 that
 * matters beyond the two built-in modes: an imported theme supplies eleven
 * colours and gets xterm's twenty slots filled by this function, so a user
 * theme can never be missing a slot or define one nobody reads.
 *
 * **This is the terminal seam's whole vocabulary.** The surface is handed a
 * palette exactly as it is handed a font stack; it does not learn that themes
 * exist, or that a user picked one.
 *
 * Returned fresh each call rather than memoised: xterm copies the object into
 * its own colour manager on assignment, so sharing an instance buys nothing and
 * an accidentally mutated singleton would corrupt every live terminal at once.
 *
 * ## The terminal follows the app theme
 *
 * It did not always: stories 011 and 042 fixed it dark in both, on the
 * reasoning that a terminal is dark because that is what a terminal is, and
 * only selection and cursor were allowed to vary. That held while the terminal
 * was the whole centre of the screen. It stopped holding once the editor landed
 * on the same stage and adopted the theme properly — a light app with one dark
 * slab in the middle reads as a panel that failed to load, not as a deliberate
 * choice, and the seam is most obvious exactly where the two surfaces meet.
 * Which palette arrives is now the composition root's business, not this
 * module's.
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
export function xtermThemeFor(palette: TermPalette) {
  const { surface, surfaceAlt } = surfacesOf(palette);

  return {
    background: palette.bg,
    foreground: palette.ink,
    selectionBackground: palette.selection,
    cursor: palette.ink,
    cursorAccent: palette.bg,
    /**
     * The transcript's `dim`, and nothing else in the extended range (HIVE-82).
     *
     * `extendedAnsi` starts at index 16, so the array is padded to reach 244.
     * Padding with `bg` rather than leaving holes: xterm falls back to its own
     * 256-colour ramp for an `undefined` entry, and a sparse array here would
     * make *which* indices the app defines depend on array length.
     */
    extendedAnsi: Array.from({ length: DIM_INDEX - 16 + 1 }, (_, index) =>
      index === DIM_INDEX - 16 ? palette.dim : palette.bg,
    ),
    /**
     * `black` and `brightBlack` are **surfaces**, not text (HIVE-82).
     *
     * This is the inversion the whole ticket turns on, so it is worth saying
     * exactly what changed and why the old mapping was defensible.
     *
     * Claude Code paints its own chrome from these two slots — the
     * submitted-prompt row, the composer sidebar, the bash block — and until
     * HIVE-82 they held `palette.black` and `palette.dim`, both *text* colours.
     * In the light palette `black` is `#2c2f34`, so the row the user had just
     * typed came out as a near-black bar across a white terminal. That was the
     * bug, and it is the same bug in dark: `dim` is `#7c88b8`, a light
     * periwinkle slab on navy.
     *
     * The old mapping had a real reason — a CLI that detects a light terminal
     * picks slot 30 for body text, and against a light `black` that text is
     * invisible. That reason has not gone away; it has moved. `minimumContrast
     * Ratio` in `terminal-surface.tsx` now rescues exactly that case, which is
     * what the note on `TERM_LIGHT.black` said was unavailable at its default
     * of 1. A rescued foreground is a legible compromise; an unreadable panel
     * is not rescuable at all, because xterm adjusts foregrounds only.
     *
     * The app's own secondary text no longer relies on that rescue: it moved
     * off slot 90 to {@link DIM_INDEX}.
     */
    black: surface,
    red: palette.red,
    green: palette.green,
    yellow: palette.amber,
    blue: palette.blue,
    magenta: palette.magenta,
    cyan: palette.cyan,
    white: palette.ink,
    /** The second surface — see {@link xtermThemeFor}'s note on `black`. */
    brightBlack: surfaceAlt,
    brightRed: palette.red,
    brightGreen: palette.green,
    brightYellow: palette.amber,
    brightBlue: palette.blue,
    brightMagenta: palette.magenta,
    brightCyan: palette.cyan,
    brightWhite: palette.ink,
  };
}

/**
 * The xterm `theme` object for the built-in dark palette.
 *
 * Kept as a named constant purely so the specs that pin every dark slot have
 * one thing to compare against; nothing in the app reads it. Live surfaces call
 * {@link xtermThemeFor} with whatever palette they were handed.
 */
export const XTERM_THEME = xtermThemeFor(TERM);

/** The same, for the built-in light palette. See {@link XTERM_THEME}. */
export const XTERM_THEME_LIGHT = xtermThemeFor(TERM_LIGHT);
