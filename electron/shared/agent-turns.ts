/**
 * Counting an agent's turns out of `--output-format stream-json`.
 *
 * ## Why this is ours to count
 *
 * `limits.turns` was specified as `--max-turns 40` on the waker's command line.
 * That flag does not exist: `claude --help` at 2.1.251 offers `--max-budget-usd`
 * and no turn cap at all — `maxTurns` is an Agent SDK option, not a CLI one. So
 * the pane was drawing a control for a limit nothing could apply.
 *
 * The waker is already reading the child's stdout to build the run log, so it
 * is already looking at every event this needs. Counting there and terminating
 * the child is the whole mechanism, and this module is the part of it worth
 * testing on its own: a fold over text, with no process and no Node in it.
 *
 * ## Why a fold rather than a function over lines
 *
 * A pipe splits wherever it likes. `{"type":"assistant"` and the rest of that
 * object routinely arrive as two chunks, and a counter that parsed each chunk
 * as a line would miss the turn entirely — undercounting, which is the
 * direction that makes a limit useless rather than merely wrong. Carrying the
 * unterminated tail in the state is what makes the count independent of how the
 * OS decided to slice the stream.
 */

/** How many turns have been seen, and the tail of a line that has not ended. */
export interface TurnCount {
  turns: number;
  /** Bytes after the last `\n`, carried into the next chunk. */
  partial: string;
}

export const NO_TURNS: TurnCount = { turns: 0, partial: '' };

/**
 * Is this line one assistant turn?
 *
 * A turn is one `{"type":"assistant"}` event — the model speaking, whether or
 * not it calls a tool. `system`, `user` and the trailing `result` are not turns:
 * counting `user` would double every step, since each tool result comes back as
 * one.
 *
 * Anything that is not parseable JSON with a `type` is *not a turn*, silently.
 * The stream carries a final `result` line and can carry warnings on the same
 * pipe, and a run must not be cut short because something unexpected shared the
 * channel — nor may a malformed line throw, since this runs inside a stdout
 * handler where a throw would take the run's log down with it.
 */
function isAssistantTurn(line: string): boolean {
  const text = line.trim();

  if (text === '') return false;

  try {
    const event: unknown = JSON.parse(text);

    return (
      typeof event === 'object' &&
      event !== null &&
      (event as { type?: unknown }).type === 'assistant'
    );
  } catch {
    return false;
  }
}

/**
 * Fold one chunk of stdout into the running count.
 *
 * Pure: the caller keeps the state. Start from {@link NO_TURNS} at the top of a
 * wake, and compare `turns` against the definition's `limits.turns` after each
 * chunk.
 *
 * The trailing fragment is kept rather than parsed, so a chunk that ends
 * mid-object contributes nothing until the rest of it arrives. A stream that
 * ends without a final newline therefore leaves its last line uncounted, which
 * is correct: an event that was never fully written was never a turn.
 */
export function countAssistantTurns(
  state: TurnCount,
  chunk: string,
): TurnCount {
  const lines = `${state.partial}${chunk}`.split('\n');

  // The last element is whatever followed the final `\n` — the empty string
  // when the chunk ended cleanly, and an unfinished event when it did not.
  const partial = lines.pop() ?? '';
  let turns = state.turns;

  for (const line of lines) {
    if (isAssistantTurn(line)) turns += 1;
  }

  return { turns, partial };
}
