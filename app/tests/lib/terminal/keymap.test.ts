import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  backChordLabel,
  decideTerminalKey,
  isBackChord,
  isMacPlatform,
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

describe('isMacPlatform', () => {
  it('prefers userAgentData when the runtime provides it', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'macOS' } });
    expect(isMacPlatform()).toBe(true);

    vi.stubGlobal('navigator', { userAgentData: { platform: 'Windows' } });
    expect(isMacPlatform()).toBe(false);
  });

  it('falls back to platform for runtimes without it', () => {
    // Deprecated and still universally implemented — `userAgentData` is
    // Chromium-only, which is fine for Electron and not for the demo surface.
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: '' });
    expect(isMacPlatform()).toBe(true);

    vi.stubGlobal('navigator', { platform: 'Linux x86_64', userAgent: '' });
    expect(isMacPlatform()).toBe(false);
  });

  it('falls back again to the user agent when platform is empty', () => {
    vi.stubGlobal('navigator', { platform: '', userAgent: 'Mozilla (Macintosh)' });
    expect(isMacPlatform()).toBe(true);
  });
});
