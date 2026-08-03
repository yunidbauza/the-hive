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
 * macOS, by the only signal available in a sandboxed renderer.
 *
 * Not `window.hive.appInfo()`, which knows `process.platform` exactly but is
 * asynchronous and desktop-only — a key handler cannot await, and the browser
 * target needs an answer too. `navigator.platform` is deprecated and still
 * universally implemented; `userAgentData` is Chromium-only, which is fine for
 * Electron and not for the demo surface, so it is tried first and fallen back
 * from.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
  if (data?.platform) return data.platform.toLowerCase().startsWith('mac');
  return /mac/i.test(navigator.platform || navigator.userAgent);
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
  { isMac, hasSelection }: KeyContext,
): TerminalKeyAction {
  if (isBackChord(event, isMac)) return 'app-chord';

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
