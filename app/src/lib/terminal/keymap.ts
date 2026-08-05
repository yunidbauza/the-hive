/**
 * Who owns a keystroke when the terminal is live (story 095).
 *
 * Three collisions between app shortcuts and terminal semantics, and every one
 * of them produces a broken product if left to defaults. They are decided here,
 * as a pure function over a key event, for two reasons: the platform matrix is
 * the part most likely to be got wrong, and a pure function is the only version
 * of it that can be exhaustively tested without a browser per platform.
 *
 * The governing rule: **a focused interactive terminal wins every bare key.**
 * Arrow keys, Tab, Ctrl-C, Escape — all of them belong to the child process,
 * because the alternative is an app that intercepts the keys a TUI is built on.
 * Anything the app needs from inside a terminal is an explicit chord.
 */

/** What should happen to a key event arriving at a live terminal. */
export type TerminalKeyAction =
  /** Let xterm encode it and send it to the pty. The default, deliberately. */
  | 'to-pty'
  /** Copy the selection; the pty must not see it. */
  | 'copy'
  /** Paste the clipboard into the pty as if typed. */
  | 'paste'
  /** An app navigation chord: not xterm's, not the pty's. Let it bubble. */
  | 'app-chord';

/** The fields of a `KeyboardEvent` this decision reads. */
export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /**
   * Present on a real `KeyboardEvent`; optional so tests can build the common
   * case without it. See the AltGr note in {@link decideTerminalKey}.
   */
  altKey?: boolean;
}

/**
 * The chord that leaves a focused terminal and returns to the orchestrator.
 *
 * `←` alone is what the message row uses (story 043), and inside a live
 * terminal it is a cursor key that belongs to the child process — readline,
 * vim and every TUI depend on it. So the app's version takes a modifier.
 *
 * The modifier differs by platform for a concrete reason rather than taste. On
 * macOS `Cmd` is never sent to a pty, so `Cmd+←` is free. On Linux and Windows
 * there is no such spare modifier: `Ctrl+←` is "move back one word" in readline
 * and hijacking it would break ordinary line editing, so the chord joins the
 * `Ctrl+Shift+…` family those platforms already use for terminal-level actions.
 */
export function isBackChord(event: KeyEventLike, isMac: boolean): boolean {
  if (event.key !== 'ArrowLeft') return false;
  /**
   * `Shift` is excluded on macOS deliberately. `Cmd+Shift+←` is "select to
   * start of line" in every native text field, and a chord that ate it would
   * break ordinary editing in the message row and the picker — the same class
   * of mistake as taking `Ctrl+←` on Linux.
   */
  return isMac
    ? event.metaKey && !event.ctrlKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey;
}

/**
 * What the terminal can say about the two rows the `←` decision needs.
 *
 * Deliberately two strings and nothing else. The surface reads them out of
 * xterm's buffer and hands them over; this module never sees a `Terminal`, so
 * the decision stays a pure function of text and the seam holds.
 */
export interface CursorContext {
  /** The whole row the caret is on, right-trimmed. */
  line: string;
  /** The whole row directly below it, right-trimmed. */
  below: string;
}

/**
 * Prompt markers that may precede an empty input.
 *
 * `❯` is what Claude Code draws today (verified against a real pty capture at
 * 100 columns). The others cost nothing and cover the box-drawn variants — a
 * left border, or the plain `>` older revisions used.
 */
const PROMPT_PREFIX = /^[\s│┃]*[❯>›»]?\s*/u;

/** Horizontal rule characters, light and heavy. */
const RULE = /[─━]/gu;

/**
 * How much rule has to be there before it counts as Claude's input frame.
 *
 * Claude draws the rule the full width of the terminal, so at any usable size
 * this is ~80–200 characters. Twenty is far below that and far above anything
 * that turns up by accident in a diff, a table, or a box-drawn TUI *row* — the
 * point is to be unmistakable, not to be tight.
 */
const MIN_RULE_WIDTH = 20;

/**
 * Is the caret sitting in Claude Code's input with nothing typed?
 *
 * **This is the whole of the bare-`←` decision, and it is deliberately narrow.**
 *
 * Two conditions, and both are needed:
 *
 * 1. **The whole input row is empty** once a prompt marker is stripped. This is
 *    what keeps `←` working while a message is being edited, and it is not a
 *    guess about Claude's internals — Claude itself only offers the binding
 *    when the input is empty. Its own footer proves it: at an empty prompt it
 *    reads `⏸ manual mode on · ← 2 agents`, and the `← 2 agents` affordance
 *    disappears the moment a character is typed. Intercepting on exactly that
 *    condition means we take the key precisely when Claude would have
 *    navigated, and never when it would have moved the caret.
 *
 *    The **whole row**, deliberately, rather than the part before the caret.
 *    Those differ in one case that matters: a half-typed message whose caret
 *    has been sent back to the start with `Ctrl-A` or `Home`. There is nothing
 *    to the caret's left, but the message is still there and Claude would not
 *    navigate — so reading only the left-hand side would throw the user out of
 *    a session they were mid-sentence in.
 *
 * 2. **The row below is a horizontal rule** — the bottom edge of Claude's input
 *    frame. This is what makes the rule *Claude-specific* rather than
 *    prompt-shaped. A login shell survives `claude` exiting (story 096), and
 *    plenty of shell prompts are a bare `❯` or `>`; without this condition a
 *    user who quit Claude and went back to their shell would find `←` silently
 *    stolen. There is no rule under a shell prompt.
 *
 * Failure is **open**: anything unrecognised returns `false` and the key goes
 * to the pty, which is exactly the behaviour before this existed. The opposite
 * default — swallow when unsure — would break line editing in every TUI the app
 * has never seen, and would do it silently.
 */
export function isEmptyClaudePrompt({ line, below }: CursorContext): boolean {
  const rule = below.match(RULE)?.length ?? 0;
  if (rule < MIN_RULE_WIDTH) return false;
  return line.replace(PROMPT_PREFIX, '') === '';
}

/**
 * `←` with no modifiers at all.
 *
 * Every modifier is excluded rather than merely the ones with a meaning here.
 * `Shift+←` extends a selection, `Alt+←` is "back one word", and `⌘←`/`Ctrl+Shift+←`
 * are the explicit chord below — none of them is the key Claude binds, and a
 * looser test would swallow all four.
 */
export const isBareBack = (event: KeyEventLike): boolean =>
  event.key === 'ArrowLeft' &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey &&
  !event.altKey;

/**
 * The DOM event a terminal fires when it declines an app chord.
 *
 * The alternative — a `keydown` listener on `window` — was implemented first and
 * is wrong, for a reason worth recording: `Cmd+←` is "move caret to start of
 * line" in every native text field, and `Ctrl+Shift+←` is "extend selection by
 * a word". A listener that matches on the key combination alone fires for
 * keystrokes originating anywhere, so typing in the new-session picker and
 * pressing `Cmd+←` closed the picker and discarded the query instead of moving
 * the caret.
 *
 * Announcing it from the terminal inverts that: the chord exists only where it
 * was declined. `components/terminal/` still learns nothing about what the app
 * does with it — it reports a *keyboard* event, not a navigation intent — and
 * every text field in the app keeps its native bindings.
 */
export const TERMINAL_CHORD_EVENT = 'hive:terminal-chord';

/** What a {@link TERMINAL_CHORD_EVENT} carries. */
export interface TerminalChordDetail {
  chord: 'back';
}

/** How that chord is written in the key-hint row. */
export const backChordLabel = (isMac: boolean): string =>
  isMac ? '⌘←' : 'Ctrl+Shift+←';

export interface KeyContext {
  isMac: boolean;
  /** Whether the terminal currently holds a selection. */
  hasSelection: boolean;
  /**
   * The rows around the caret, or `null` when the terminal cannot report them.
   *
   * Optional and null-tolerant on purpose: a caller that does not supply it
   * gets the pre-existing behaviour, chord-only, rather than a crash or a
   * swallowed arrow key.
   */
  cursor?: CursorContext | null;
}

/**
 * Decide the owner of one keydown.
 *
 * Ordered most-specific first: the app chord is checked before the copy rules,
 * because on Linux the two share the `Ctrl+Shift` prefix and a looser copy rule
 * would swallow it.
 */
export function decideTerminalKey(
  event: KeyEventLike,
  { isMac, hasSelection, cursor }: KeyContext,
): TerminalKeyAction {
  if (isBackChord(event, isMac)) return 'app-chord';

  /**
   * Bare `←` at an empty Claude prompt belongs to the app, not to the pty.
   *
   * The governing rule at the top of this file — *a focused interactive
   * terminal wins every bare key* — has exactly one exception, and this is it.
   * It earns the exception by being narrower than the rule it breaks: the key
   * is taken only in the state where the child process would have used it to
   * navigate away rather than to move the caret, so nothing that `←` does for
   * a line editor is lost. See {@link isEmptyClaudePrompt} for why both halves
   * of that test are load-bearing.
   *
   * Without it, `←` opens Claude Code's *own* agent list inside a session — a
   * second, competing fleet view in an app whose entire purpose is being the
   * fleet view.
   */
  if (isBareBack(event) && cursor && isEmptyClaudePrompt(cursor)) {
    return 'app-chord';
  }

  /**
   * AltGr is not a modifier here, it is part of the character.
   *
   * Windows synthesises `ctrlKey: true, altKey: true` for AltGr, for legacy
   * compatibility. On layouts where AltGr produces `c` or `v` — and there are
   * several — every rule below would read the keystroke as a chord and swallow
   * a character the user was trying to type into their shell.
   */
  if (event.altKey) return 'to-pty';

  // `event.key` is already case-shifted by Shift ('C', not 'c'), so compare
  // case-insensitively rather than listing both forms at every site.
  const key = event.key.toLowerCase();

  if (isMac) {
    /**
     * Copy is `Cmd+C` here, which leaves `Ctrl+C` unambiguously the terminal's.
     * It goes to the pty **always** — even with a selection — because
     * interrupting a runaway process is the more urgent of the two meanings and
     * a user who has text selected has not stopped wanting to interrupt it.
     */
    if (event.metaKey && key === 'c') return hasSelection ? 'copy' : 'to-pty';
    if (event.metaKey && key === 'v') return 'paste';
    return 'to-pty';
  }

  /**
   * Linux and Windows: the conventional copy binding *is* `Ctrl+C`, which would
   * swallow the interrupt. `Ctrl+Shift+C`/`Ctrl+Shift+V` are the terminal-level
   * copy and paste, and bare `Ctrl+C` copies only when there is a selection to
   * copy — then clears it, so the next press interrupts.
   *
   * This is what GNOME Terminal and VS Code do. Matching the platform beats
   * inventing a convention, however tidy the invented one would be.
   */
  if (event.ctrlKey && event.shiftKey && key === 'c') return 'copy';
  if (event.ctrlKey && event.shiftKey && key === 'v') return 'paste';
  if (event.ctrlKey && !event.shiftKey && key === 'c') {
    return hasSelection ? 'copy' : 'to-pty';
  }
  return 'to-pty';
}
