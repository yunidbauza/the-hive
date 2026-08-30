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
  /**
   * The `message.id` of the most recent turn counted.
   *
   * One model turn can arrive as **several** `assistant` events — a `thinking`
   * block and a `tool_use` block are two events sharing one `message.id`.
   * Captured from a real run: four `assistant` events, three distinct ids, and
   * the binary's own `result.num_turns` of 3. Counting events would therefore
   * have cut a tool-using agent off at three quarters of its stated limit, and
   * the more tools it used the worse the error — silently killing healthy runs,
   * which is a worse failure than the undercount the partial-line handling
   * guards against.
   *
   * Only the *last* id is kept rather than a set: the events of one message
   * arrive together, so a duplicate is always adjacent, and a set would grow
   * without bound across a long run for no extra correctness.
   */
  lastId: string | null;
}

export const NO_TURNS: TurnCount = { turns: 0, partial: '', lastId: null };

/**
 * The `message.id` of an assistant event, or `null` when the line is not one.
 *
 * A turn is the model speaking, whether or not it calls a tool. `system`,
 * `user`, `rate_limit_event` and the trailing `result` are not turns: counting
 * `user` would double every step, since each tool result comes back as one.
 *
 * Anything that is not parseable JSON naming an assistant message is `null`,
 * silently. The stream carries a final `result` line, hook events and warnings
 * on the same pipe, and a run must not be cut short because something
 * unexpected shared the channel — nor may a malformed line throw, since this
 * runs inside a stdout handler where a throw would take the run's log with it.
 *
 * An assistant event with **no** id still counts, as the sentinel below: it is
 * a turn that cannot be deduplicated, and dropping it would undercount.
 */
const NO_ID = '';

function assistantMessageId(line: string): string | null {
  const text = line.trim();

  if (text === '') return null;

  try {
    const event: unknown = JSON.parse(text);

    if (
      typeof event !== 'object' ||
      event === null ||
      (event as { type?: unknown }).type !== 'assistant'
    ) {
      return null;
    }

    const id = (event as { message?: { id?: unknown } }).message?.id;

    return typeof id === 'string' && id !== '' ? id : NO_ID;
  } catch {
    return null;
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
  let lastId = state.lastId;

  for (const line of lines) {
    const id = assistantMessageId(line);

    if (id === null) continue;

    // A second event of the message already counted is the same turn. An
    // unidentified event (`NO_ID`) always counts — see `assistantMessageId`.
    if (id !== NO_ID && id === lastId) continue;

    turns += 1;
    lastId = id;
  }

  return { turns, partial, lastId };
}
