import { NEWLINE_SEQUENCE } from '@lib/terminal/keymap';
import { sessionChannelState } from '@lib/terminal/pty-transport';
import { normalizeLines } from '@lib/terminal/text';

/**
 * Putting text into a live session (story 097).
 *
 * The whole mechanism of the coordination layer, and deliberately tiny. Claude
 * Code's TUI sits at a prompt, so text plus a carriage return is exactly what a
 * person typing would produce — and therefore exactly what the orchestrator
 * produces. No message bus, no protocol, no injection format.
 *
 * **Reads no store.** Ids arrive as arguments, the same discipline
 * `pty-transport.ts` holds itself to. That is also what keeps this module out
 * of an import cycle with `resolve-transport.ts`, which is the store-aware half
 * of the seam and would otherwise import this one's caller.
 */

export type SendResult = { ok: true } | { ok: false; reason: string };

/**
 * Line breaks are kept; every other control character is dropped.
 *
 * **This used to flatten a newline to a space, and the reason it did has since
 * stopped being true.** The old rationale was that a multi-line message would
 * otherwise submit its first line and leave the rest sitting at the prompt as a
 * half-typed second command — which was correct while `\r` was the only thing
 * this module could send. It is not any more: the terminal half of this story
 * gives the pty {@link NEWLINE_SEQUENCE}, which starts a line without
 * submitting. Flattening now would mean the console offers a key that inserts a
 * line break and then silently removes it on the way out.
 *
 * Control characters other than the break are still stripped rather than
 * refused, unchanged: this text is written into a terminal the user reads and
 * trusts, and a paste carrying a stray byte should still send.
 */
export function normalizeInput(text: string): string {
  return normalizeLines(text);
}

export function sendToSession(entityId: string, text: string): SendResult {
  const message = normalizeInput(text);
  /**
   * An empty message is refused rather than sent.
   *
   * Sending it would submit a bare carriage return, which at a TUI prompt is a
   * turn the user did not take — and at a shell prompt is a blank line in a
   * transcript someone will later read as meaningful.
   */
  if (message === '') return { ok: false, reason: 'nothing to send' };

  /**
   * Refuse rather than no-op, and say which kind of nothing this is.
   *
   * Main's `write` returns early for an entity with no live session —
   * silently, and correctly, because it cannot know whether that is a bug. The
   * renderer can: a session that was never opened has no process yet, and one
   * that exited needs a restart. Different problems, different fixes, and a
   * routing layer that fails silently is the worst possible outcome.
   */
  switch (sessionChannelState(entityId)) {
    case 'none':
      return {
        ok: false,
        reason: `${entityId} has no live session — open it to start one`,
      };
    case 'exited':
      return {
        ok: false,
        reason: `${entityId} has exited — restart it to send again`,
      };
    case 'live':
      break;
  }

  const bridge = window.hive;
  // Barely reachable — a channel can only exist where a bridge did. Explicit
  // anyway: the alternative is a TypeError thrown from inside a keystroke
  // handler, which reads as an xterm bug.
  if (!bridge) {
    return { ok: false, reason: 'this build has no terminal bridge' };
  }

  /**
   * One {@link NEWLINE_SEQUENCE} between the lines, one `\r` at the end.
   *
   * `\r`, not `\n`, for the submit. A terminal's Enter key sends carriage
   * return, and the line discipline is what turns it into "line submitted". A
   * bare line feed is inserted literally by some shells and readline
   * configurations, leaving the message typed but never sent.
   * `sessions/bootstrap.ts` rests on the same fact for the same reason.
   *
   * Which is exactly why the *interior* breaks cannot also be `\r`: each one
   * would submit, turning a three-line message into three separate turns. The
   * sequence that starts a line without submitting is the one the keyboard now
   * sends for `Shift+Enter`, so a message assembled here and a message typed by
   * hand reach the child process as the same bytes.
   */
  const body = message.split('\n').join(NEWLINE_SEQUENCE);
  bridge.pty.write({ sessionId: entityId, data: `${body}\r` });
  return { ok: true };
}
