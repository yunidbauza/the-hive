import { sessionChannelState } from '@lib/terminal/pty-transport';

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
 * Every newline becomes a single space.
 *
 * A multi-line message pasted into the row would otherwise submit its first
 * line and leave the rest sitting at the prompt as a half-typed second command.
 *
 * `\r\n` is matched before either bare form, so a Windows line ending collapses
 * to one space rather than two — the kind of detail that survives review and
 * then shows up as mysterious double-spacing in a transcript.
 */
export function normalizeInput(text: string): string {
  return text.replace(/\r\n|\r|\n/g, ' ').trim();
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
   * `\r`, not `\n`. A terminal's Enter key sends carriage return, and the line
   * discipline is what turns it into "line submitted". A bare line feed is
   * inserted literally by some shells and readline configurations, leaving the
   * message typed but never sent. `sessions/bootstrap.ts` rests on the same
   * fact for the same reason.
   */
  bridge.pty.write({ sessionId: entityId, data: `${message}\r` });
  return { ok: true };
}
