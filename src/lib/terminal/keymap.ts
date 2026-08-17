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
  /** Send `Home` to the pty. See {@link LINE_MOTION_SEQUENCE}. */
  | 'line-start'
  /** Send `End` to the pty. See {@link LINE_MOTION_SEQUENCE}. */
  | 'line-end'
  /** Insert a line break without submitting. See {@link NEWLINE_SEQUENCE}. */
  | 'newline'
  /** An app navigation chord: not xterm's, not the pty's. Let it bubble. */
  | 'app-chord';

/**
 * The bytes `Home` and `End` put on a pty's stdin.
 *
 * These are xterm's normal-mode encodings — exactly what the surface would send
 * had the user pressed the physical keys — so the translation is honest: the
 * chord is renamed, not reinterpreted. Verified against the key table inside the
 * `claude` binary, which maps `\x1b[H` to `home` and `\x1b[F` to `end` (it also
 * accepts the `\x1bO…` application-mode and `\x1b[1~`/`\x1b[4~` keypad forms, so
 * a child in either mode understands these).
 *
 * Sent through the transport rather than `terminal.input()` because stdin is the
 * transport's job — the same path `terminal.onData` already uses.
 */
export const LINE_MOTION_SEQUENCE: Record<'line-start' | 'line-end', string> = {
  'line-start': '\x1b[H',
  'line-end': '\x1b[F',
};

/**
 * The bytes that mean "line break, do not submit" on a pty's stdin.
 *
 * `ESC` + `CR`, and it is not an invention of this codebase. It is what xterm
 * *already* encodes for `Alt+Enter` — the `case 13` branch of its keyboard table
 * reads `ev.altKey ? C0.ESC + C0.CR : C0.CR` — and it is the exact pair Claude
 * Code's own `/terminal-setup` installs when it rebinds `Shift+Enter` in iTerm2
 * and VS Code. So the chord is renamed, not reinterpreted: the pty receives a
 * sequence it already understood, from a key the user expected to produce it.
 *
 * Why a translation is needed at all is the whole defect. xterm's `case 13`
 * never consults `shiftKey`, so `Shift+Enter` and a bare `Enter` arrive at the
 * child process as the *same single byte* — `\r`. Claude Code cannot distinguish
 * what it cannot see, so it submits, and a half-written second line is sent
 * instead of started.
 *
 * Sent through the transport rather than `terminal.input()` for the same reason
 * as {@link LINE_MOTION_SEQUENCE}: stdin is the transport's job.
 */
export const NEWLINE_SEQUENCE = '\x1b\r';

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
 * The chord differs by platform for a concrete reason rather than taste.
 *
 * On macOS it is **`Cmd+[`**, the system-wide Back binding — Safari, Finder,
 * Xcode and System Settings all use it. It was `Cmd+←` until story 110, on the
 * premise that "`Cmd` is never sent to a pty, so `Cmd+←` is free". The premise
 * held; the conclusion did not. `Cmd+←` is *beginning of line* in every macOS
 * text field, and Claude Code's prompt is a text field — so the chord fired
 * while a user was editing a half-typed message and threw them out of the
 * session, losing it. A chord may only claim a key the child process has no use
 * for, and this one had a use. `Cmd+←`/`Cmd+→` now reach the pty as `Home`/`End`
 * (see {@link LINE_MOTION_SEQUENCE}).
 *
 * On Linux and Windows there is no spare modifier of that kind: `Ctrl+←` is
 * "move back one word" in readline and hijacking it would break ordinary line
 * editing, so the chord joins the `Ctrl+Shift+…` family those platforms already
 * use for terminal-level actions. `Cmd+[` has no equivalent there — `Alt+←` is
 * the platform Back, but Alt belongs to the pty (see the AltGr note in
 * {@link decideTerminalKey}) — so that platform keeps `Ctrl+Shift+←`.
 */
export function isBackChord(event: KeyEventLike, isMac: boolean): boolean {
  /**
   * Every other modifier is excluded on both platforms. `Cmd+Shift+[` is
   * "previous tab" in most macOS apps and `Cmd+Alt+[` is a bracket motion in
   * several editors; neither is this chord, and a looser test would eat both.
   */
  if (isMac) {
    return (
      event.key === '[' &&
      event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    );
  }
  return event.key === 'ArrowLeft' && event.ctrlKey && event.shiftKey;
}

/**
 * `Cmd+←`/`Cmd+→` on macOS: beginning and end of line.
 *
 * The reason this needs a rule at all is that xterm encodes nothing for
 * `Cmd`+arrow — it is not a sequence any terminal defines — so without this the
 * key is simply swallowed and the user sees *nothing happen*, which is exactly
 * what was reported for `Cmd+→`. Translating to `Home`/`End` is what a macOS
 * terminal emulator does with these chords, and what every native text field
 * does with them.
 *
 * macOS only. Elsewhere the physical `Home`/`End` keys already exist and xterm
 * encodes them itself; there is nothing to translate.
 */
export function lineMotion(
  event: KeyEventLike,
  isMac: boolean,
): 'line-start' | 'line-end' | null {
  if (!isMac || !event.metaKey || event.ctrlKey || event.shiftKey) return null;
  if (event.key === 'ArrowLeft') return 'line-start';
  if (event.key === 'ArrowRight') return 'line-end';
  return null;
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
 * `Shift+←` extends a selection, `Alt+←` is "back one word", `⌘←` is beginning
 * of line and `Ctrl+Shift+←` is the explicit chord above — none of them is the
 * key Claude binds, and a looser test would swallow all four.
 */
export const isBareBack = (event: KeyEventLike): boolean =>
  event.key === 'ArrowLeft' &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey &&
  !event.altKey;

/**
 * `Shift+Enter`, and nothing else wearing a modifier.
 *
 * Every other modifier is excluded rather than ignored, and each exclusion has a
 * job. `Alt+Enter` already produces {@link NEWLINE_SEQUENCE} through xterm's own
 * encoder, so matching it here would translate a key that needs no translating.
 * `Ctrl+Enter` and `⌘Enter` are bindings several TUIs define for themselves, and
 * a terminal that swallowed them would be breaking the governing rule at the top
 * of this file for no gain — the user asked for `Shift`.
 *
 * Platform-independent, unlike every other rule in this module. `Shift+Enter`
 * means "new line, don't send" in Slack, Discord, iMessage and every chat box on
 * the web; there is no platform where it means something else worth preserving.
 */
export const isNewlineChord = (event: KeyEventLike): boolean =>
  event.key === 'Enter' &&
  event.shiftKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.altKey;

/**
 * The DOM event a terminal fires when it declines an app chord.
 *
 * The alternative — a `keydown` listener on `window` — was implemented first and
 * is wrong, for a reason worth recording: `Ctrl+Shift+←` is "extend selection by
 * a word" in every native text field, and `Cmd+←` — the macOS chord until story
 * 110 — is "move caret to start of line". A listener that matches on the key
 * combination alone fires for keystrokes originating anywhere, so typing in the
 * new-session picker and pressing `Cmd+←` closed the picker and discarded the
 * query instead of moving the caret.
 *
 * That history is worth keeping even though the macOS chord has moved to
 * `Cmd+[`: it is the same mistake story 110 fixes one layer down. A chord that
 * matches on the key combination alone eats the key wherever it is pressed —
 * from a text field, in the first case; from inside a live child process, in
 * the second.
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
  isMac ? '⌘[' : 'Ctrl+Shift+←';

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
  /**
   * The process behind this terminal has ended (story 108).
   *
   * Defaults to `false`, so a caller that does not know keeps the old
   * behaviour. See {@link decideTerminalKey} for why this is the one condition
   * that widens the app's claim on a key rather than narrowing it.
   */
  ended?: boolean;
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
  { isMac, hasSelection, cursor, ended = false }: KeyContext,
): TerminalKeyAction {
  if (isBackChord(event, isMac)) return 'app-chord';

  /**
   * A terminal whose process has ended gives `←` back to the app (story 108).
   *
   * The governing rule — *a focused interactive terminal wins every bare key* —
   * is a rule about **live** terminals, and it earns its strictness from the
   * child process needing those keys. There is no child process here. Every
   * keystroke lands in a pty that will never answer, so the rule protects
   * nothing and costs the user the only key they are likely to press: `←` is how
   * you leave a session everywhere else in the app, and after `/exit` it was the
   * one place it silently did nothing.
   *
   * Checked **before** {@link isEmptyClaudePrompt} rather than folded into it,
   * because the two ask unrelated questions. That one asks whether Claude would
   * have navigated; this one applies when Claude is gone — the last thing on
   * screen is a shell's `logout` and an exit notice, which is prompt-shaped for
   * neither test.
   */
  if (ended && isBareBack(event)) return 'app-chord';

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

  /**
   * `Shift+Enter` is a line break, not a submit.
   *
   * Checked **after** the AltGr guard so that `Alt+Enter` — which xterm already
   * encodes as {@link NEWLINE_SEQUENCE} unaided — keeps taking the untranslated
   * path, and **before** the platform blocks because the rule is the same on
   * every platform and neither block has an `Enter` case to collide with.
   *
   * Unlike the `←` exception above, this one inspects nothing — and that is a
   * deliberate trade rather than a free lunch, so it is worth being exact about
   * what it costs.
   *
   * `Shift+Enter` is currently indistinguishable from `Enter` at the child
   * process, so for **Claude Code** — the reason a session exists — there is no
   * behaviour to preserve. For a plain shell surviving `/exit` (story 096) the
   * chord did submit and now does not: zsh's ZLE accepts `\x1b\r` as the line,
   * so the macOS default is unaffected, but bash's readline leaves `M-\r`
   * unbound and answers with a bell.
   *
   * That is accepted rather than guarded. The `←` rule is fenced behind
   * {@link isEmptyClaudePrompt} because `←` is load-bearing in every line
   * editor and TUI; `Shift+Enter` is load-bearing in none, and a screen-shape
   * test would cost this chord its reliability inside the many multi-line
   * prompts that are not Claude's.
   */
  if (isNewlineChord(event)) return 'newline';

  // `event.key` is already case-shifted by Shift ('C', not 'c'), so compare
  // case-insensitively rather than listing both forms at every site.
  const key = event.key.toLowerCase();

  if (isMac) {
    /**
     * Checked before the copy rules only for readability — `Cmd`+arrow and
     * `Cmd+C`/`Cmd+V` cannot collide. See {@link lineMotion} for why the
     * translation is needed at all.
     */
    const motion = lineMotion(event, isMac);
    if (motion) return motion;

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
