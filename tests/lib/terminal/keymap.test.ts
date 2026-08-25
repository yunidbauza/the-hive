import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LINE_MOTION_SEQUENCE,
  NEWLINE_SEQUENCE,
  backChordLabel,
  claimBareBack,
  decideTerminalKey,
  isBackChord,
  isBareBack,
  isEmptyClaudePrompt,
  isNewlineChord,
  lineMotion,
  type CursorContext,
  type KeyEventLike,
} from '@lib/terminal/keymap';
import { CLAUDE_FRAMES, asCursorContext } from '@tests/support/claude-frames';

/**
 * The keyboard matrix (story 095).
 *
 * This is the part of the story most likely to be got wrong and least likely to
 * be noticed: every rule here is correct on the platform its author is using and
 * broken on the other one. A pure function is the only version of it that can be
 * checked for both without two machines.
 */

function key(overrides: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    key: 'a',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

const MAC = { isMac: true, hasSelection: false };
const PC = { isMac: false, hasSelection: false };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decideTerminalKey — the default', () => {
  it('gives every bare key to the pty', () => {
    /**
     * The governing rule of the whole story. Arrows, Tab and Escape are what a
     * TUI is built on; an app that intercepts them cannot host one.
     */
    for (const name of ['ArrowLeft', 'ArrowUp', 'Tab', 'Escape', 'a', 'Enter']) {
      expect(decideTerminalKey(key({ key: name }), MAC)).toBe('to-pty');
      expect(decideTerminalKey(key({ key: name }), PC)).toBe('to-pty');
    }
  });
});

describe('decideTerminalKey — Shift+Enter is a line break', () => {
  /**
   * The defect this fixes is invisible from inside xterm: its `case 13` branch
   * reads `ev.altKey ? ESC + CR : CR` and never consults `shiftKey`, so
   * `Shift+Enter` and a bare `Enter` reach the child process as the *same
   * single byte*. Claude Code cannot distinguish what it cannot see, so it
   * submits — and a half-written second line is sent instead of started.
   */
  it('claims Shift+Enter on every platform', () => {
    // Platform-independent, unlike every other rule in this module: there is no
    // OS where `Shift+Enter` means something other than "new line, don't send".
    expect(decideTerminalKey(key({ key: 'Enter', shiftKey: true }), MAC)).toBe(
      'newline',
    );
    expect(decideTerminalKey(key({ key: 'Enter', shiftKey: true }), PC)).toBe(
      'newline',
    );
  });

  it('sends ESC+CR, which is what the child already understood', () => {
    /**
     * Pinned as a literal because the whole fix is this byte pair. It is not an
     * invention: it is xterm's own `Alt+Enter` encoding, and the exact sequence
     * Claude Code's `/terminal-setup` installs when it rebinds `Shift+Enter` in
     * iTerm2 and VS Code. The chord is renamed, not reinterpreted.
     */
    expect(NEWLINE_SEQUENCE).toBe('\x1b\r');
  });

  it('leaves a bare Enter alone', () => {
    // The control. Submitting is what that key is for; a fix that swallowed it
    // would leave the prompt with no way to send at all.
    expect(decideTerminalKey(key({ key: 'Enter' }), MAC)).toBe('to-pty');
    expect(decideTerminalKey(key({ key: 'Enter' }), PC)).toBe('to-pty');
  });

  it('leaves Alt+Enter to xterm, which already encodes it', () => {
    // Translating a key that needs no translating would be the one way to make
    // this worse than it was.
    expect(
      decideTerminalKey(key({ key: 'Enter', altKey: true }), MAC),
    ).toBe('to-pty');
    expect(
      decideTerminalKey(key({ key: 'Enter', shiftKey: true, altKey: true }), PC),
    ).toBe('to-pty');
  });

  it('leaves Ctrl+Enter and Cmd+Enter to the child process', () => {
    /**
     * Several TUIs bind these for themselves, and the user asked for `Shift`.
     * The governing rule — a focused interactive terminal wins every bare key —
     * is only worth breaking for the key that was actually broken.
     */
    expect(
      decideTerminalKey(key({ key: 'Enter', ctrlKey: true, shiftKey: true }), PC),
    ).toBe('to-pty');
    expect(
      decideTerminalKey(key({ key: 'Enter', metaKey: true, shiftKey: true }), MAC),
    ).toBe('to-pty');
  });

  it('recognises exactly one chord', () => {
    expect(isNewlineChord(key({ key: 'Enter', shiftKey: true }))).toBe(true);
    expect(isNewlineChord(key({ key: 'Enter' }))).toBe(false);
    expect(isNewlineChord(key({ key: 'a', shiftKey: true }))).toBe(false);

    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      expect(
        isNewlineChord(key({ key: 'Enter', shiftKey: true, [modifier]: true })),
      ).toBe(false);
    }
  });
});

describe('decideTerminalKey — AltGr', () => {
  it('treats an Alt-modified key as a character, not a chord', () => {
    /**
     * Windows synthesises `ctrlKey: true, altKey: true` for AltGr, for legacy
     * compatibility. On layouts where AltGr produces `c` or `v` the copy and
     * paste rules would swallow a character the user was typing into a shell.
     */
    expect(
      decideTerminalKey(key({ key: 'c', ctrlKey: true, altKey: true }), PC),
    ).toBe('to-pty');
    expect(
      decideTerminalKey(
        key({ key: 'v', ctrlKey: true, shiftKey: true, altKey: true }),
        PC,
      ),
    ).toBe('to-pty');
  });
});

describe('decideTerminalKey — macOS', () => {
  it('sends Ctrl+C to the pty even when text is selected', () => {
    /**
     * Copy is Cmd+C here, so Ctrl+C is unambiguously the terminal's. Selection
     * must not change that: interrupting a runaway process is the more urgent
     * meaning, and a user who happens to have text highlighted has not stopped
     * wanting to stop it.
     */
    expect(
      decideTerminalKey(key({ key: 'c', ctrlKey: true }), {
        isMac: true,
        hasSelection: true,
      }),
    ).toBe('to-pty');
  });

  it('copies with Cmd+C when there is a selection', () => {
    expect(
      decideTerminalKey(key({ key: 'c', metaKey: true }), {
        isMac: true,
        hasSelection: true,
      }),
    ).toBe('copy');
  });

  it('does not copy with Cmd+C when there is nothing selected', () => {
    expect(decideTerminalKey(key({ key: 'c', metaKey: true }), MAC)).toBe('to-pty');
  });

  it('pastes with Cmd+V', () => {
    expect(decideTerminalKey(key({ key: 'v', metaKey: true }), MAC)).toBe('paste');
  });

  it('ignores the Linux chords', () => {
    // Ctrl+Shift+C on macOS is not a copy binding anywhere; treating it as one
    // would steal a chord the pty may legitimately receive.
    expect(
      decideTerminalKey(key({ key: 'C', ctrlKey: true, shiftKey: true }), MAC),
    ).toBe('to-pty');
  });
});

describe('decideTerminalKey — Linux and Windows', () => {
  it('copies with Ctrl+Shift+C and pastes with Ctrl+Shift+V', () => {
    // What GNOME Terminal and VS Code do. Matching the platform beats
    // inventing a convention, however tidy the invented one would be.
    expect(
      decideTerminalKey(key({ key: 'C', ctrlKey: true, shiftKey: true }), PC),
    ).toBe('copy');
    expect(
      decideTerminalKey(key({ key: 'V', ctrlKey: true, shiftKey: true }), PC),
    ).toBe('paste');
  });

  it('sends bare Ctrl+C to the pty when nothing is selected', () => {
    expect(decideTerminalKey(key({ key: 'c', ctrlKey: true }), PC)).toBe('to-pty');
  });

  it('copies on bare Ctrl+C only while a selection exists', () => {
    expect(
      decideTerminalKey(key({ key: 'c', ctrlKey: true }), {
        isMac: false,
        hasSelection: true,
      }),
    ).toBe('copy');
  });

  it('ignores Cmd, which these platforms do not have', () => {
    expect(
      decideTerminalKey(key({ key: 'c', metaKey: true }), {
        isMac: false,
        hasSelection: true,
      }),
    ).toBe('to-pty');
  });
});

describe('the back chord', () => {
  it('is Cmd+[ on macOS, the system-wide Back binding', () => {
    expect(decideTerminalKey(key({ key: '[', metaKey: true }), MAC)).toBe(
      'app-chord',
    );
    expect(backChordLabel(true)).toBe('⌘[');
  });

  it('is no longer Cmd+←, which macOS spends on beginning-of-line', () => {
    /**
     * The story-110 regression. `Cmd+←` fired the chord regardless of what was
     * on the prompt, so pressing it to jump to the start of a half-typed
     * message threw the user out of the session and lost the message.
     */
    expect(isBackChord(key({ key: 'ArrowLeft', metaKey: true }), true)).toBe(false);
    expect(decideTerminalKey(key({ key: 'ArrowLeft', metaKey: true }), MAC)).toBe(
      'line-start',
    );
  });

  it('leaves Cmd+Shift+[ and Cmd+Alt+[ alone on macOS', () => {
    // "Previous tab" and an editor bracket motion respectively. Neither is this
    // chord, and a test that only checked `metaKey` would eat both.
    expect(isBackChord(key({ key: '[', metaKey: true, shiftKey: true }), true)).toBe(
      false,
    );
    expect(isBackChord(key({ key: '[', metaKey: true, altKey: true }), true)).toBe(
      false,
    );
  });

  it('is not Cmd+[ off macOS, where there is no Cmd key', () => {
    expect(isBackChord(key({ key: '[', metaKey: true }), false)).toBe(false);
  });

  it('is Ctrl+Shift+← elsewhere, because Ctrl+← is a readline binding', () => {
    /**
     * The reason this differs by platform. `Ctrl+←` is "move back one word" in
     * readline; hijacking it would break ordinary line editing in every shell.
     */
    expect(
      decideTerminalKey(key({ key: 'ArrowLeft', ctrlKey: true }), PC),
    ).toBe('to-pty');
    expect(
      decideTerminalKey(key({ key: 'ArrowLeft', ctrlKey: true, shiftKey: true }), PC),
    ).toBe('app-chord');
    expect(backChordLabel(false)).toBe('Ctrl+Shift+←');
  });

  it('leaves a bare ← to the child process', () => {
    expect(isBackChord(key({ key: 'ArrowLeft' }), true)).toBe(false);
    expect(isBackChord(key({ key: 'ArrowLeft' }), false)).toBe(false);
  });

  it('is checked before the copy rules it shares a prefix with', () => {
    // On Linux the chord and the copy binding both start Ctrl+Shift. A looser
    // ordering would have the copy rule swallow the navigation chord.
    expect(
      decideTerminalKey(key({ key: 'ArrowLeft', ctrlKey: true, shiftKey: true }), PC),
    ).toBe('app-chord');
  });
});

/**
 * `Cmd`+arrow on macOS (story 110).
 *
 * Two separate defects, one cause. `Cmd+←` was the back chord, so it navigated
 * instead of moving the caret; `Cmd+→` was nothing at all, and xterm encodes no
 * sequence for it, so the key was silently swallowed. Both are now translated to
 * the `Home`/`End` a macOS terminal emulator sends for these chords.
 */
describe('decideTerminalKey — Cmd+arrow line motions on macOS', () => {
  it('translates Cmd+← and Cmd+→ to beginning and end of line', () => {
    expect(decideTerminalKey(key({ key: 'ArrowLeft', metaKey: true }), MAC)).toBe(
      'line-start',
    );
    expect(decideTerminalKey(key({ key: 'ArrowRight', metaKey: true }), MAC)).toBe(
      'line-end',
    );
  });

  it('carries the sequences the child actually parses as Home and End', () => {
    /**
     * Not arbitrary bytes: these are xterm's normal-mode encodings for the
     * physical keys, and they are in `claude`'s own key table — `[H` → `home`,
     * `[F` → `end`. Asserted here so a well-meant "tidy-up" to `Ctrl+A`/`Ctrl+E`
     * (which mean something else entirely inside vim) fails loudly.
     */
    expect(LINE_MOTION_SEQUENCE['line-start']).toBe('\x1b[H');
    expect(LINE_MOTION_SEQUENCE['line-end']).toBe('\x1b[F');
  });

  it('leaves Alt+← and Alt+→ to the pty as word motions', () => {
    // The keys that already worked, and the reason the bug was noticeable: word
    // movement was fine while line movement was not.
    expect(decideTerminalKey(key({ key: 'ArrowLeft', altKey: true }), MAC)).toBe(
      'to-pty',
    );
    expect(decideTerminalKey(key({ key: 'ArrowRight', altKey: true }), MAC)).toBe(
      'to-pty',
    );
  });

  it('leaves bare and Shift-ed arrows alone', () => {
    expect(decideTerminalKey(key({ key: 'ArrowLeft' }), MAC)).toBe('to-pty');
    expect(decideTerminalKey(key({ key: 'ArrowRight' }), MAC)).toBe('to-pty');
    expect(
      decideTerminalKey(key({ key: 'ArrowLeft', metaKey: true, shiftKey: true }), MAC),
    ).toBe('to-pty');
  });

  it('does not fire off macOS, where Home and End are real keys', () => {
    expect(lineMotion(key({ key: 'ArrowLeft', metaKey: true }), false)).toBeNull();
    expect(decideTerminalKey(key({ key: 'ArrowRight', metaKey: true }), PC)).toBe(
      'to-pty',
    );
  });

  it('beats the empty-prompt rule, which only claims a bare ←', () => {
    // A user at an empty prompt pressing Cmd+← wants the caret moved, not the
    // session left — and `←` alone is still there for leaving.
    expect(
      decideTerminalKey(key({ key: 'ArrowLeft', metaKey: true }), {
        ...MAC,
        cursor: CLAUDE_EMPTY,
      }),
    ).toBe('line-start');
  });
});

/**
 * The bare-`←` rule.
 *
 * Every fixture here comes from a real `claude` session driven through a real
 * pty at 96 columns, not from a guess about how Claude Code renders. Two frames
 * were captured, empty and with `hello` typed, and the difference between them
 * is the whole rule: Claude's own footer reads `⏸ manual mode on · ← 2 agents`
 * at an empty prompt and drops the `← 2 agents` affordance the moment a
 * character is typed. Claude binds `←` exactly when the input is empty, so this
 * fires exactly then too.
 */

/** An edge of Claude's input frame, as captured at 100 columns. */
const RULE = '─'.repeat(100);

/** The status rows Claude draws under the frame. Present so the window ends. */
const FOOTER = '  the-hive | main | Opus 5 (1M context) - high | [--------] --%';

/** A frame, in the shape the surface reports it: rows plus the caret's index. */
const frame = (
  rows: readonly string[],
  caretRow: number,
  /**
   * What the *user* typed on the caret's row. Defaults to the raw row, which
   * is what a terminal reports when Claude is not drawing its faint
   * placeholder — i.e. almost always. The placeholder case passes `''`.
   */
  caretText?: string,
): CursorContext => ({
  rows,
  caretRow,
  caretText: caretText ?? rows[caretRow] ?? '',
});

/**
 * A fresh empty prompt. The frame every version of this rule has matched.
 *
 * The ` ` is not a typo and not decoration: Claude separates its marker
 * from the input with a **no-break space**, which is a real cell rather than
 * padding, so xterm's right-trim leaves it in place. `PROMPT_PREFIX` has to
 * strip it, and this fixture is what proves it does.
 */
const CLAUDE_EMPTY = frame(['', RULE, '❯ ', RULE, FOOTER], 2);

/** The same frame with a message typed into it. */
const CLAUDE_TYPED = frame(['', RULE, '❯ hello there', RULE, FOOTER], 2);

/**
 * The frames that used to fail, captured from a real `claude` 2.1.245 (HIVE-79).
 *
 * Each one was driven out of a live session through a real pty and rendered
 * through a VT emulator, then read exactly as the surface reads xterm's buffer.
 * They are the point of the ticket: the canonical frame above always worked, so
 * every one of these is a shape the two-row rule got wrong in production.
 */

/**
 * `Shift+Enter` after typing — and the reason the fix could not be a wider
 * regex.
 *
 * The caret drops to an empty second input row with the frame's bottom edge
 * directly beneath it, so the old two-row test saw an empty caret row above a
 * rule and **claimed the key**. A user reaching back to edit their first line
 * was thrown out of the session and lost the message — the regression story 110
 * and HIVE-65 fixed one surface over, reappearing here.
 */
const MULTILINE_CARET_ON_EMPTY_ROW = frame(
  ['', RULE, '❯ hi there', '', RULE, FOOTER],
  3,
);

/**
 * A two-line message cleared, caught mid-repaint.
 *
 * Claude rewrites the first input row before the second, so for a tick the
 * input is empty while stale text still sits where the bottom edge belongs. The
 * old test found no rule under the caret and let the key go; the new one finds
 * the frame, sees text inside it, and **declines** — the honest answer, and the
 * one the app can now announce.
 */
const STALE_SECOND_ROW = frame(
  ['', RULE, '❯', '  second line', RULE, FOOTER],
  2,
);

/**
 * Bash mode. `!` replaces the `❯` outright rather than joining it.
 *
 * The input is empty and Claude would have navigated, but the old marker class
 * had no `!`, so it read the mode indicator as typed content and gave the key
 * away.
 */
const BASH_MODE = frame(['', RULE, '!', RULE, FOOTER], 2);

/**
 * An eighteen-column terminal.
 *
 * Claude draws the edge the full width, so at eighteen columns the edge is
 * eighteen rule characters — under the old absolute floor of twenty, which is
 * why a narrow pane silently stopped claiming the key.
 */
const NARROW = frame(['', '─'.repeat(18), '❯', '─'.repeat(18)], 2);

describe('isEmptyClaudePrompt — the frames a real session produces', () => {
  it('matches an empty prompt inside the frame', () => {
    expect(isEmptyClaudePrompt(CLAUDE_EMPTY)).toBe(true);
  });

  it('does not match once anything has been typed', () => {
    // The case that would break line editing. `←` here means "move the caret",
    // and Claude has already withdrawn the navigation affordance.
    expect(isEmptyClaudePrompt(CLAUDE_TYPED)).toBe(false);
  });

  it('does not match a typed message whose caret was sent back to the start', () => {
    /**
     * `Ctrl-A` / `Home` in a half-written message. There is nothing to the
     * caret's *left*, so a rule that read only the left-hand side would fire
     * and throw the user out of a session they were mid-sentence in — while
     * Claude, which still has text in its input, would not have navigated at
     * all. Judging whole rows is what closes that gap.
     */
    expect(
      isEmptyClaudePrompt(frame(['', RULE, '❯ half a message', RULE], 2)),
    ).toBe(false);
  });

  it('keeps ← for the user on a multi-line message with an empty caret row', () => {
    /**
     * HIVE-79's worst case, and the one the old rule got backwards: it claimed
     * this. The row the caret is on is empty, but the *input* is not, and Claude
     * would have moved the caret rather than navigating.
     */
    expect(isEmptyClaudePrompt(MULTILINE_CARET_ON_EMPTY_ROW)).toBe(false);
    expect(claimBareBack(MULTILINE_CARET_ON_EMPTY_ROW)).toBe('declined');
  });

  it('claims an empty bash-mode prompt', () => {
    expect(isEmptyClaudePrompt(BASH_MODE)).toBe(true);
  });

  it('claims a prompt showing Claude’s own placeholder', () => {
    /**
     * **The root cause of HIVE-79**, and the one candidate mechanism the ticket
     * named that turned out to be the real one.
     *
     * Claude writes `Try "write a test for …"` into its *empty* input as real
     * cells, and goes on offering `← for agents` in the footer while it is
     * showing — so it would navigate, and the app has to take the key. Read as
     * plain text the row is a typed message and the key leaked.
     *
     * The row arrives here already blanked: the surface drops faint cells,
     * because the placeholder is `\x1b[2m` and a typed message never is. See
     * {@link CursorContext.rows}.
     */
    const placeholder = frame(['', RULE, '❯ ', RULE, FOOTER], 2);
    expect(isEmptyClaudePrompt(placeholder)).toBe(true);
  });

  it('claims an empty prompt in a very narrow terminal', () => {
    expect(isEmptyClaudePrompt(NARROW)).toBe(true);
  });

  it('declines rather than leaks when a repaint hides the evidence', () => {
    /**
     * The input really is empty here, so this is still the wrong *answer* — but
     * it is now a knowable one. `declined` is what the surface turns into an
     * announcement, which is the difference between losing a key and losing the
     * user.
     */
    expect(claimBareBack(STALE_SECOND_ROW)).toBe('declined');
  });

  it('does not match a bare shell prompt, however prompt-shaped', () => {
    /**
     * The login shell survives `claude` ending badly (story 096 and
     * `sessionCommand`), and plenty of shells prompt with `❯` — starship and
     * pure both do. The frame is what separates the two; without it the app
     * would silently steal `←` from a plain terminal — and, being `foreign`
     * rather than `declined`, it announces nothing either.
     */
    expect(claimBareBack(frame(['$ ls', 'app % '], 1))).toBe('foreign');
    expect(claimBareBack(frame(['', '❯ ', ''], 1))).toBe('foreign');
    expect(claimBareBack(frame(['', '❯ ', 'total 48'], 1))).toBe('foreign');
  });

  it('tolerates a box-drawn left border and a plain > marker', () => {
    // Not the current rendering, but cheap, and older revisions drew both.
    expect(isEmptyClaudePrompt(frame(['', RULE, '│ > ', RULE], 2))).toBe(true);
    expect(isEmptyClaudePrompt(frame(['', RULE, '│ > x', RULE], 2))).toBe(false);
  });

  it('reads a title written into the top edge as an edge', () => {
    // Claude writes the worktree name into the upper rule, so an edge is
    // mostly rule rather than purely rule.
    const titled = `${'─'.repeat(74)} hive-79-bare-left ──`;
    expect(isEmptyClaudePrompt(frame(['', titled, '❯ ', RULE], 2))).toBe(true);
  });

  it('wants a real edge, not a stray dash or two', () => {
    expect(isEmptyClaudePrompt(frame(['', '───', '❯ ', '───'], 2))).toBe(false);
  });

  it('is foreign when the caret is on a rule itself', () => {
    /**
     * Not an input row at all — a transcript the user has scrolled into. Caught
     * by the typed-row test rather than by a rule of its own: a row of rule
     * characters does not survive {@link PROMPT_PREFIX} as empty, so it reads
     * as "the user typed something" and the app steps aside. An explicit
     * `isRuleRow(caret)` guard was written here first and removed — it could
     * not be reached, and an unreachable branch is a claim nothing can check.
     */
    expect(claimBareBack(frame([RULE, RULE, RULE], 1))).toBe('foreign');
  });

  it('is foreign when the caret index is outside the reported rows', () => {
    expect(claimBareBack(frame([], 0))).toBe('foreign');
    expect(claimBareBack(frame(['❯'], -1))).toBe('foreign');
  });

  it('is silent through ordinary editing, not merely declining', () => {
    /**
     * The noise this rule exists to avoid. Typing `helo` and pressing `←` three
     * times to fix it is the single most common thing a user does in a session;
     * each press must be `foreign`, not `declined`, or the strip appears over
     * the input on every keystroke saying something that is not true.
     */
    for (const typed of ['❯ helo', '❯ h', '  a continuation row']) {
      expect(claimBareBack(frame(['', RULE, typed, RULE], 2))).toBe('foreign');
    }
  });

  it('will not read another program’s panel border as Claude’s frame', () => {
    /**
     * `fzf --border`, `atuin`, a lazygit panel: a box whose borders sit several
     * rows from the caret with a list in between. An earlier revision searched
     * eight rows either way for *any* edge, found these, and claimed `←` — in
     * programs where `←` is load-bearing and the user is mid-search.
     *
     * Claude's empty input is exactly one row tall, at every width captured
     * from a real session, so the edges must be touching the caret's row.
     */
    const panel = [
      '┌─────────────────────────────┐',
      '│ src/lib/terminal/keymap.ts  │',
      '│ src/lib/terminal/ansi.ts    │',
      '> ',
      '└─────────────────────────────┘',
    ];
    expect(claimBareBack(frame(panel, 3))).toBe('foreign');
  });

  it('wants both edges, not just the one below the caret', () => {
    /**
     * The half-frame the old two-row rule was: a rule under the caret and
     * nothing above it. Enough to pass before, and not enough now — without a
     * top edge there is no *region*, so there is nothing to check for emptiness
     * and no honest way to call this Claude's input. A shell whose last command
     * printed a rule lands here.
     */
    expect(claimBareBack(frame(['total 48', '❯ ', RULE], 1))).toBe('foreign');
  });

  it('gives up rather than reaching past the window it was handed', () => {
    // An input taller than the scan: the top edge is out of reach, so the
    // answer is "not mine" rather than a guess made on half the evidence.
    const tall = ['a message', 'that runs', 'to many', 'rows', '', RULE];
    expect(claimBareBack(frame(tall, 4))).toBe('foreign');
  });
});

/**
 * Every frame a real session produced, against the rule as shipped (HIVE-79).
 *
 * The acceptance criterion the ticket leads with — *the frame that fails is
 * captured from a real session, not inferred* — and the reason it leads with it
 * is that this codebase has been burned by an inferred mechanism recorded as
 * fact before. The fixtures above are hand-written for readability, one shape
 * each; these are the raw recordings, whole caret windows, nothing tidied.
 *
 * Eighteen states out of one live `claude` 2.1.245. Three are decided
 * differently than they were before this change — see
 * `tests/support/claude-frames.ts` for which, and what each one cost.
 */
describe('the frames of a real claude 2.1.245', () => {
  it('covers the empty prompt, a typed one, and a narrow terminal', () => {
    // A guard on the fixture itself: a recording that lost its interesting
    // frames would still pass every assertion below by asserting nothing.
    const named = CLAUDE_FRAMES.map((captured) => captured.name);
    expect(named).toContain('bash mode, empty');
    expect(named).toContain('multi-line, caret on empty second row');
    expect(named).toContain('empty prompt at 18x12');
    expect(CLAUDE_FRAMES.filter((f) => f.claim === 'claim').length).toBeGreaterThan(
      5,
    );
  });

  it.each(CLAUDE_FRAMES)('$name -> $claim', (captured) => {
    expect(claimBareBack(asCursorContext(captured))).toBe(captured.claim);
  });
});

describe('isBareBack', () => {
  it('is ArrowLeft with no modifier at all', () => {
    expect(isBareBack(key({ key: 'ArrowLeft' }))).toBe(true);
  });

  it('rejects every modified form', () => {
    /**
     * `Shift+←` extends a selection and `Alt+←` is "back one word"; both belong
     * to the child process. `⌘←` and `Ctrl+Shift+←` are the explicit chord,
     * handled before this, and must not fall through to it.
     */
    expect(isBareBack(key({ key: 'ArrowLeft', shiftKey: true }))).toBe(false);
    expect(isBareBack(key({ key: 'ArrowLeft', altKey: true }))).toBe(false);
    expect(isBareBack(key({ key: 'ArrowLeft', metaKey: true }))).toBe(false);
    expect(isBareBack(key({ key: 'ArrowLeft', ctrlKey: true }))).toBe(false);
  });

  it('is not any other arrow', () => {
    expect(isBareBack(key({ key: 'ArrowRight' }))).toBe(false);
  });
});

describe('decideTerminalKey — bare ← at an empty Claude prompt', () => {
  it('takes the key for the app', () => {
    expect(
      decideTerminalKey(key({ key: 'ArrowLeft' }), { ...MAC, cursor: CLAUDE_EMPTY }),
    ).toBe('app-chord');
  });

  it('gives it back to the pty the moment something is typed, and stays quiet', () => {
    /**
     * `to-pty`, not `back-declined`. Nothing was lost: `←` on a row with a
     * message on it moves the caret one column, which is what the user asked
     * for and what Claude would have done anyway.
     *
     * This is the common case by a wide margin — every arrow key pressed while
     * fixing a typo lands here — and an earlier revision announced on all of
     * them, putting `← went to the session` over the input being edited four
     * seconds at a time. See {@link claimBareBack}.
     */
    expect(
      decideTerminalKey(key({ key: 'ArrowLeft' }), { ...MAC, cursor: CLAUDE_TYPED }),
    ).toBe('to-pty');
  });

  it('announces only the shape it genuinely cannot decide', () => {
    /**
     * A blank caret row with the frame's edges not touching it: either another
     * line of a message begun with `Shift+Enter`, or a repaint that has not
     * caught up on an input that really is empty. Indistinguishable from the
     * screen — so the pty gets the key and the app says where it went.
     */
    expect(
      decideTerminalKey(key({ key: 'ArrowLeft' }), {
        ...MAC,
        cursor: MULTILINE_CARET_ON_EMPTY_ROW,
      }),
    ).toBe('back-declined');
  });

  it('says nothing at all in a plain shell', () => {
    /**
     * `to-pty`, not `back-declined`. Nothing was declined here — the app never
     * had a claim on `←` outside Claude's input — and announcing one would put
     * a hint about leaving a session over somebody's `ls` output.
     */
    expect(
      decideTerminalKey(key({ key: 'ArrowLeft' }), {
        ...PC,
        cursor: frame(['$ ls', 'app % '], 1),
      }),
    ).toBe('to-pty');
  });

  it('fails open when the terminal cannot report its rows', () => {
    /**
     * Absent information is never a match. A caller that supplies no cursor —
     * or a buffer that cannot be read — gets the pre-existing chord-only
     * behaviour rather than a swallowed arrow key.
     */
    expect(
      decideTerminalKey(key({ key: 'ArrowLeft' }), { ...MAC, cursor: null }),
    ).toBe('to-pty');
    expect(decideTerminalKey(key({ key: 'ArrowLeft' }), MAC)).toBe('to-pty');
  });

  it('still honours the explicit chord while typing', () => {
    // The escape hatch the guarded rule deliberately does not replace:
    // mid-message, with the bare key correctly going to the pty, `⌘[` leaves.
    expect(
      decideTerminalKey(key({ key: '[', metaKey: true }), {
        ...MAC,
        cursor: CLAUDE_TYPED,
      }),
    ).toBe('app-chord');
  });

  it('moves the caret rather than leaving when Cmd+← is pressed mid-message', () => {
    /**
     * The story-110 regression, stated where it hurt most: a user with a
     * half-typed message reaching for beginning-of-line used to lose it.
     */
    expect(
      decideTerminalKey(key({ key: 'ArrowLeft', metaKey: true }), {
        ...MAC,
        cursor: CLAUDE_TYPED,
      }),
    ).toBe('line-start');
  });
});

describe('decideTerminalKey — after the process has ended (story 108)', () => {
  it('hands bare ← to the app with no cursor context at all', () => {
    /**
     * The `/exit` case. The last rows are a shell's `logout` and an exit
     * notice, which is prompt-shaped for neither `isEmptyClaudePrompt` nor
     * anything else — so the empty-prompt rule cannot fire, and before this the
     * key went to a pty that would never answer. The user was left with no
     * keyboard route back to the orchestrator at all.
     */
    expect(
      decideTerminalKey(key({ key: 'ArrowLeft' }), { ...MAC, ended: true }),
    ).toBe('app-chord');
    expect(
      decideTerminalKey(key({ key: 'ArrowLeft' }), { ...PC, ended: true }),
    ).toBe('app-chord');
  });

  it('takes only that one key — everything else still belongs to the terminal', () => {
    /**
     * A dead terminal is still a *readable* one, and reading it is why the tab
     * stays open. Widening this into "the app owns the keyboard now" would
     * break scrolling through the transcript the user stayed for.
     */
    expect(
      decideTerminalKey(key({ key: 'ArrowRight' }), { ...MAC, ended: true }),
    ).toBe('to-pty');
    expect(decideTerminalKey(key({ key: 'a' }), { ...MAC, ended: true })).toBe(
      'to-pty',
    );
  });

  it('does not fire while the process is still running', () => {
    // The default is `false`, and a live terminal keeps every bare key — the
    // governing rule this rule is a narrow exception to.
    expect(
      decideTerminalKey(key({ key: 'ArrowLeft' }), { ...MAC, ended: false }),
    ).toBe('to-pty');
    expect(decideTerminalKey(key({ key: 'ArrowLeft' }), MAC)).toBe('to-pty');
  });

  it('leaves copy alone', () => {
    expect(
      decideTerminalKey(key({ key: 'c', metaKey: true }), {
        isMac: true,
        hasSelection: true,
        ended: true,
      }),
    ).toBe('copy');
  });
});
