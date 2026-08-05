import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  backChordLabel,
  decideTerminalKey,
  isBackChord,
  isBareBack,
  isEmptyClaudePrompt,
  type KeyEventLike,
} from '@lib/terminal/keymap';

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
  it('is Cmd+← on macOS, where Cmd never reaches a pty', () => {
    expect(decideTerminalKey(key({ key: 'ArrowLeft', metaKey: true }), MAC)).toBe(
      'app-chord',
    );
    expect(backChordLabel(true)).toBe('⌘←');
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

  it('leaves Cmd+Shift+← to native text selection on macOS', () => {
    /**
     * "Select to start of line" in every native text field. A chord that ate it
     * would break ordinary editing in the message row and the picker — the same
     * mistake as taking `Ctrl+←` on Linux, and the reason this rule excludes
     * Shift rather than ignoring it.
     */
    expect(
      isBackChord(key({ key: 'ArrowLeft', metaKey: true, shiftKey: true }), true),
    ).toBe(false);
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

/** The bottom edge of Claude's input frame, as captured. */
const RULE = '─'.repeat(96);

/** The captured input row, empty. Two cells: the marker and one space. */
const CLAUDE_EMPTY = { line: '❯ ', below: RULE };

/** The same row with `hello` typed into it. */
const CLAUDE_TYPED = { line: '❯ hello', below: RULE };

describe('isEmptyClaudePrompt', () => {
  it('matches an empty prompt inside the rule frame', () => {
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
     * all. Judging the whole row is what closes that gap.
     */
    expect(isEmptyClaudePrompt(CLAUDE_TYPED)).toBe(false);
    expect(isEmptyClaudePrompt({ line: '❯ half a message', below: RULE })).toBe(
      false,
    );
  });

  it('does not match a bare shell prompt, however prompt-shaped', () => {
    /**
     * The login shell survives `claude` ending badly (story 096 and
     * `sessionCommand`), and plenty of shells prompt with `❯` — starship and
     * pure both do. The rule below the caret is what separates the two; without
     * it the app would silently steal `←` from a plain terminal.
     */
    expect(isEmptyClaudePrompt({ line: 'app % ', below: '' })).toBe(false);
    expect(isEmptyClaudePrompt({ line: '❯ ', below: '' })).toBe(false);
    expect(isEmptyClaudePrompt({ line: '❯ ', below: 'total 48' })).toBe(false);
  });

  it('tolerates a box-drawn left border and a plain > marker', () => {
    // Not the current rendering, but cheap, and older revisions drew both.
    expect(isEmptyClaudePrompt({ line: '│ > ', below: RULE })).toBe(true);
    expect(isEmptyClaudePrompt({ line: '│ > x', below: RULE })).toBe(false);
  });

  it('wants a real rule, not a stray dash or two', () => {
    // A box-drawn TUI row is not an input frame. Twenty is far below the full
    // terminal width Claude actually draws and far above incidental matches.
    expect(isEmptyClaudePrompt({ line: '❯ ', below: '─'.repeat(19) })).toBe(false);
    expect(isEmptyClaudePrompt({ line: '❯ ', below: '─'.repeat(20) })).toBe(true);
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

  it('gives it back to the pty the moment something is typed', () => {
    expect(
      decideTerminalKey(key({ key: 'ArrowLeft' }), { ...MAC, cursor: CLAUDE_TYPED }),
    ).toBe('to-pty');
  });

  it('gives it to the pty in a plain shell', () => {
    expect(
      decideTerminalKey(key({ key: 'ArrowLeft' }), {
        ...PC,
        cursor: { line: 'app % ', below: '' },
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
    // mid-message, with the bare key correctly going to the pty, `⌘←` leaves.
    expect(
      decideTerminalKey(key({ key: 'ArrowLeft', metaKey: true }), {
        ...MAC,
        cursor: CLAUDE_TYPED,
      }),
    ).toBe('app-chord');
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
