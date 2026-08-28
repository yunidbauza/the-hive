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
  /** Kill back to the start of the line. See {@link LINE_KILL_SEQUENCE}. */
  | 'line-kill'
  /** Insert a line break without submitting. See {@link NEWLINE_SEQUENCE}. */
  | 'newline'
  /** An app navigation chord: not xterm's, not the pty's. Let it bubble. */
  | 'app-chord'
  /**
   * A bare `←` the app wanted and could not have (HIVE-79).
   *
   * Behaves as {@link TerminalKeyAction} `to-pty` — the pty gets the key,
   * because that is what a declined claim means — and differs from it in one
   * respect: the app is *told*. The whole defect this exists for is that the
   * app used to lose the key and the user in the same silent instant; it never
   * learned the key had happened, so it could not say where the user had gone.
   *
   * Raised only where the app had a claim to lose — the caret inside Claude's
   * input frame — never for `←` in a shell, where nothing was declined and an
   * announcement would be noise. See {@link BareBackClaim}.
   */
  | 'back-declined';

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

/**
 * The byte that means "delete back to the start of the line" on a pty's stdin.
 *
 * `Ctrl+U`. Not an invention either: it is `unix-line-discard` in readline and
 * `kill-whole-line` in zsh's ZLE, and Claude Code's own input answers it —
 * sending it at a typed prompt clears the prompt and offers *"Ctrl+Y to paste
 * deleted text"*, so the child treats it as a kill with an undo rather than a
 * control character it drops. The chord is renamed, not reinterpreted.
 *
 * Why a translation is needed is the defect. xterm's `case 8` reads `ctrlKey`
 * and `altKey` and never `metaKey`, so `Cmd+Delete` reached the child as a bare
 * `DEL` — one character rubbed out where the user asked for the line. That is
 * worse than the `Cmd+→` failure {@link LINE_MOTION_SEQUENCE} exists for: a
 * swallowed key is at least visibly nothing, while this one quietly did
 * something else.
 *
 * Sent through the transport rather than `terminal.input()` for the same reason
 * as the other two: stdin is the transport's job.
 */
export const LINE_KILL_SEQUENCE = '\x15';

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
 * `Cmd+Delete` on macOS: delete to the beginning of the line.
 *
 * The sibling of {@link lineMotion}, and it exists for the same reason with a
 * nastier symptom — see {@link LINE_KILL_SEQUENCE}. Deleting a *word* already
 * worked, because `Alt+Delete` is a sequence xterm does encode, which is what
 * made the missing line delete read as arbitrary rather than as a gap.
 *
 * `Backspace` only. Forward delete (`fn`+`Delete`, `key: 'Delete'`) means
 * delete to the *end* of the line on macOS; claiming it here would send a
 * backward kill for a forward chord, which is the bug this fixes, mirrored.
 *
 * Every other modifier is excluded. `Cmd+Alt+Delete` never reaches this — the
 * AltGr guard in {@link decideTerminalKey} returns first — and the explicit
 * `altKey` test keeps that true if the predicate is ever called directly.
 *
 * macOS only. Elsewhere `Ctrl+U` is already on the keyboard and `Cmd` is not.
 */
export function isLineKillChord(event: KeyEventLike, isMac: boolean): boolean {
  return (
    isMac &&
    event.key === 'Backspace' &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/**
 * What the terminal can say about the rows the `←` decision needs (HIVE-79).
 *
 * A **window** of rows rather than two, and that widening is the fix. The
 * two-row version — the caret's row plus the one below it — was wrong in both
 * directions against frames captured from a real `claude`:
 *
 * - It **stole** `←` from a user mid-message. Type a line, press `Shift+Enter`,
 *   and the caret sits on an empty second input row with the frame's bottom
 *   rule directly beneath it. Both conditions passed, so the app claimed the
 *   key and threw the user out of a session with a half-written message in it —
 *   the regression story 110 and HIVE-65 fixed one surface over.
 * - It **leaked** `←` at an input that really was empty, because the row below
 *   the caret is not always the frame's edge: clear a two-line message and
 *   Claude repaints the first row before the second, leaving stale text where
 *   the rule was expected.
 *
 * Neither is reachable from a cleverer look at two rows: the information needed
 * — *is there anything in the whole input?* — is not in them. So the surface
 * hands over the rows around the caret and this module finds the frame itself.
 *
 * Still deliberately strings and nothing else. This module never sees a
 * `Terminal`, so the decision stays a pure function of text and the seam holds.
 */
export interface CursorContext {
  /**
   * The rows around the caret, top to bottom, each right-trimmed — **raw**.
   *
   * A bounded window — see {@link FRAME_SCAN}. Rows the buffer cannot report
   * are `''`, which is not a frame edge, so an unreadable window fails the same
   * way an unrecognised one does.
   *
   * Raw, deliberately, and that is a correction rather than a default. These
   * rows exist to find the frame's **edges**, and an earlier revision handed
   * them over with faint cells blanked — which would mean that an edge Claude
   * ever chose to draw faint reads as an all-blank row, {@link isRuleRow} finds
   * nothing, and the whole feature switches itself off silently and
   * permanently. That is the same shape as the alternate-buffer trap recorded
   * above, and nothing in this repository's unit suites could catch it.
   * Rendition is consulted for exactly one row, for the one question that needs
   * it: see {@link CursorContext.caretText}.
   */
  rows: readonly string[];
  /** Which entry of {@link CursorContext.rows} the caret is on. */
  caretRow: number;
  /**
   * The caret's own row, with **faint cells blanked out**.
   *
   * The one place rendition is read, and it is the defect (HIVE-79). Claude
   * Code writes a **placeholder** into its empty input — `❯ Try "write a test
   * for …"` — as real cells on the caret row, and its own footer goes on
   * offering `← for agents` while it is showing, so Claude *would* navigate.
   * Read as plain text that row is indistinguishable from a typed message, so
   * the app declined the key and the user landed in Claude's agent list.
   * Measured from a real session, the placeholder arrives as
   * `\x1b[39m❯\xa0\x1b[2mTry "…"` — **SGR 2, faint** — and typed input never
   * is. So this carries what the *user* put on that row, and "is anything
   * typed?" becomes answerable again.
   */
  caretText: string;
}

/**
 * **Claude Code runs on the alternate screen buffer. Measured, not assumed.**
 *
 * Recorded because it is a trap, and one this change fell into: an
 * `alternate === 'alternate' -> foreign` guard was written here on the very
 * reasonable premise that `vim`, `less` and `htop` take the alternate buffer
 * while Claude draws its transcript inline. It looked like the one signal in
 * this module that was not a screen-scrape, and it would have been — except
 * that the premise is false. Against a real `claude` 2.1.245 inside the app,
 * `terminal.buffer.active.type` is **`'alternate'`**, so the guard disabled the
 * bare-`←` claim outright: every frame came back `foreign` and no chord was
 * ever raised.
 *
 * Nothing short of the desktop end-to-end spec could have caught it. Every unit
 * test passed, because every unit test staged the buffer the author believed
 * Claude used.
 *
 * So there is no cheap "is this a full-screen TUI?" test available here, and a
 * future one must not be built on the buffer type. What separates Claude from
 * `vim` is what always did: the input frame — a rule above the caret and a rule
 * below it, with nothing typed between them.
 */


/**
 * How far from the caret the frame is looked for, in rows.
 *
 * Only the **announcement** search uses the whole window; the claim itself
 * looks at the two rows either side of the caret and nothing else. So the
 * window's size decides one thing: how tall a message can be before a blank
 * caret row inside it stops being recognised as ambiguous. Past eight rows the
 * app falls silent — `foreign`, not `declined` — which is the honest answer
 * rather than a compromise: with no edge in reach there is no evidence this is
 * Claude's input at all, and announcing on a guess is what the whole ticket is
 * about. Bounded rather than open-ended because the alternative is scanning
 * scrollback on a keystroke.
 */
export const FRAME_SCAN = 8;

/**
 * Prompt markers that may precede an empty input.
 *
 * `❯` is what Claude Code draws today (verified against a real pty capture at
 * 100 columns). `!` is **bash mode**, where Claude replaces the `❯` outright
 * rather than adding to it — an empty bash-mode prompt renders as a lone `!`,
 * and the old pattern read that as typed content and let the key go. The rest
 * cost nothing and cover the box-drawn variants: a left border, or the plain
 * `>` older revisions used.
 *
 * `#` is deliberately **absent**. Memory mode renders as `❯ #`, but there the
 * `#` is a character the user typed and can delete; treating it as chrome would
 * claim a key from someone who had begun writing.
 */
const PROMPT_PREFIX = /^[\s│┃]*[❯>›»!]?\s*/u;

/** Horizontal rule characters, light and heavy. */
const RULE = /[─━]/gu;

/**
 * The shortest run of rule that can be a frame edge.
 *
 * Claude draws the rule the full width of the terminal, so this is normally
 * 80–200 characters. The floor exists only to keep `───` in a diff or a
 * transcript from reading as an edge.
 */
const MIN_RULE_WIDTH = 8;

/**
 * How much of a frame edge has to actually be rule.
 *
 * Not all of it: Claude writes the worktree or branch name *into* the top
 * rule — `───────── HIVE-keymap-bug ──` — so an edge is mostly rule rather than
 * purely rule.
 *
 * A *share* rather than a count is also what fixes a narrow terminal: at
 * eighteen columns the edge is eighteen rule characters, under the old absolute
 * floor of twenty, and the app stopped claiming the key there. Requiring the
 * row to be *mostly* rule is what lets the floor come down safely — a
 * box-drawn TUI row like `├── Files ──┤` carries too much else to qualify.
 */
const MIN_RULE_SHARE = 0.6;

/**
 * Box-drawing corners, junctions and verticals — everything a *border* has and
 * a *rule* does not.
 *
 * The one glyph class that separates Claude's input frame from every other
 * program's chrome. Claude draws two plain horizontal rules, sometimes with a
 * name written into the upper one; it never draws a corner. `fzf --border`,
 * `atuin`, lazygit and the welcome box Claude itself prints at startup all do —
 * and a border row is otherwise ~90% rule characters, so a share test alone
 * reads it as an edge. `←` is load-bearing inside every one of those.
 */
const BOX_JUNCTION = /[┌┐└┘├┤┬┴┼│┃╭╮╰╯╠╣╦╩╬║]/u;

/** Is this row an edge of Claude's input frame? */
function isRuleRow(row: string): boolean {
  const trimmed = row.trim();
  if (trimmed.length < MIN_RULE_WIDTH) return false;
  if (BOX_JUNCTION.test(trimmed)) return false;
  const rule = trimmed.match(RULE)?.length ?? 0;
  return rule / trimmed.length >= MIN_RULE_SHARE;
}

/** Is this row of the input carrying anything the user typed? */
const isBlankInputRow = (row: string): boolean =>
  row.replace(PROMPT_PREFIX, '') === '';

/**
 * What the app may do with a bare `←` at this screen.
 *
 * Three answers rather than two, because "no" has two very different meanings
 * and the app needs to tell them apart (HIVE-79).
 */
export type BareBackClaim =
  /** Claude's input, and empty: the app takes the key. */
  | 'claim'
  /**
   * Claude's input, and **not** empty — or not provably empty. The pty gets the
   * key, which is correct while a message is being written and merely unlucky
   * when a repaint hid the evidence. Either way the app knows it lost the key,
   * which is what {@link TerminalKeyAction} `back-declined` exists to say.
   */
  | 'declined'
  /**
   * Not Claude's input at all — a shell, another TUI, an unreadable buffer. The
   * app has no business here and does not announce anything: a user pressing
   * `←` in `vim` is moving the caret, not missing a chord.
   */
  | 'foreign';

/**
 * Where the caret is, and whether the app may have the `←` (HIVE-79).
 *
 * **This is the whole of the bare-`←` decision, and it is deliberately narrow.**
 *
 * Two conditions, in the order they are cheapest to disprove:
 *
 * 1. **The caret is inside a frame** — a rule row somewhere above it and a rule
 *    row somewhere below it, within {@link FRAME_SCAN}. This is what makes the
 *    test *Claude-specific* rather than prompt-shaped. A login shell survives
 *    `claude` exiting (story 096), and plenty of shell prompts are a bare `❯`;
 *    without this a user who quit Claude and went back to their shell would
 *    find `←` silently stolen. There is no rule under a shell prompt.
 *
 * 2. **Every row of the input is empty** once a prompt marker is stripped —
 *    the whole region between the two edges, not just the caret's row. Claude
 *    itself only offers the binding when the input is empty; its own footer
 *    proves it, reading `⏸ manual mode on · ← 2 agents` at an empty prompt and
 *    dropping the `← 2 agents` the moment a character is typed. Testing the
 *    whole region means the app takes the key precisely when Claude would have
 *    navigated, and never when it would have moved the caret.
 *
 *    Whole **rows**, deliberately, rather than the part before the caret. Those
 *    differ in one case that matters: a half-typed message whose caret has been
 *    sent back to the start with `Ctrl-A` or `Home`. There is nothing to the
 *    caret's left, but the message is still there and Claude would not
 *    navigate.
 *
 * Failure is still **open**: anything unrecognised leaves the key with the pty,
 * which is exactly the behaviour before any of this existed. The opposite
 * default — swallow when unsure — would break line editing in every TUI the app
 * has never seen, and would do it silently. What has changed is that the app no
 * longer fails open *silently*: condition 2 without condition 3 is `declined`,
 * and the surface says so.
 */
export function claimBareBack({
  rows,
  caretRow,
  caretText,
}: CursorContext): BareBackClaim {
  if (caretRow < 0 || caretRow >= rows.length) return 'foreign';

  /**
   * Anything typed on the caret's own row and the app is silent — not even a
   * decline.
   *
   * This is the common case by a wide margin: a user pressing `←` to fix a
   * typo. Claude moves the caret one column, which is exactly what they asked
   * for; nothing was lost and there is nothing to announce. An earlier revision
   * answered `declined` here, and the strip then appeared on *every* arrow key
   * during ordinary editing — saying `← went to the session` over the input
   * being edited, which is both noise and untrue.
   */
  if (!isBlankInputRow(caretText)) return 'foreign';

  /**
   * The edges have to be **touching** the caret's row.
   *
   * Claude's empty input is exactly one row tall — rule, `❯`, rule — in every
   * frame captured from a real session, at every width from 18 columns to 120.
   * Requiring adjacency rather than "an edge somewhere within
   * {@link FRAME_SCAN}" is what keeps this from claiming keys inside other
   * programs' chrome: `fzf --border`, `atuin`, a lazygit panel all draw a box
   * whose borders sit several rows away with a list in between, and a looser
   * search finds those borders and calls them Claude's frame. `←` is
   * load-bearing in every one of them.
   */
  const above = caretRow - 1;
  const below = caretRow + 1;
  const edgeAbove = above >= 0 && isRuleRow(rows[above]);
  const edgeBelow = below < rows.length && isRuleRow(rows[below]);
  if (edgeAbove && edgeBelow) return 'claim';

  /**
   * **The caret has to be touching the frame on at least one side.**
   *
   * This is what keeps the announcement off other programs' chrome. Both
   * shapes the app genuinely cannot decide have exactly one edge against the
   * caret: a message begun with `Shift+Enter` puts the caret on a blank row
   * with the frame's *bottom* edge under it and the typed rows above; a
   * repaint caught mid-flight leaves the *top* edge above the caret and stale
   * text below. A box whose borders are several rows away with a list between
   * them — `fzf --border`, `atuin`, a lazygit panel — touches neither, and is
   * not this app's business in any of the three answers.
   */
  if (!edgeAbove && !edgeBelow) return 'foreign';

  /**
   * One edge touching, the other somewhere in reach: the ambiguous shape.
   *
   * Either the input holds another line, or a repaint has not caught up and it
   * really is empty. Indistinguishable from the screen — so the key goes to the
   * pty and the app says where it went.
   */
  const hasEdge = (from: number, step: number): boolean => {
    for (let row = from; row >= 0 && row < rows.length; row += step) {
      if (isRuleRow(rows[row])) return true;
    }
    return false;
  };
  return hasEdge(below, 1) && hasEdge(above, -1) ? 'declined' : 'foreign';
}

/**
 * Is the caret sitting in Claude Code's input with nothing typed?
 *
 * The boolean half of {@link claimBareBack}, kept because that is the question
 * most callers and every test actually asks.
 */
export const isEmptyClaudePrompt = (cursor: CursorContext): boolean =>
  claimBareBack(cursor) === 'claim';

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
  /**
   * `back` — the app has the key and should navigate.
   *
   * `back-declined` — the app wanted the key, the pty got it, and the user is
   * now somewhere the app did not send them (HIVE-79). Nothing to navigate;
   * something to *say*. See {@link TerminalKeyAction} `back-declined`.
   */
  chord: 'back' | 'back-declined';
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
   *
   * A declined claim is **announced rather than dropped** (HIVE-79). The key
   * still goes to the pty — that is what declining means, and it is what keeps
   * a half-written message editable — but the app hears about it, so losing the
   * key is no longer the same event as losing the user. See
   * {@link BareBackClaim} for the three answers and why "no" needed two of them.
   */
  if (isBareBack(event) && cursor) {
    const claim = claimBareBack(cursor);
    if (claim === 'claim') return 'app-chord';
    if (claim === 'declined') return 'back-declined';
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
     * The line *kill*, next to the line motions it belongs with. Cannot collide
     * with either the motions or the clipboard chords — no other rule here
     * looks at `Backspace`. See {@link isLineKillChord}.
     */
    if (isLineKillChord(event, isMac)) return 'line-kill';

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
