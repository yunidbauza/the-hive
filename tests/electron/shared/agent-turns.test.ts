// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  NO_TURNS,
  countAssistantTurns,
} from '../../../electron/shared/agent-turns';

/** One line of `--output-format stream-json`, as the binary emits it. */
const event = (type: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ type, ...extra })}\n`;

/** An assistant event, which always carries the id of the message it belongs to. */
const assistant = (id: string, block = 'text') =>
  event('assistant', { message: { id, content: [{ type: block }] } });

/** Fold a whole transcript in one go, the way a single chunk would arrive. */
const count = (...chunks: string[]) =>
  chunks.reduce(countAssistantTurns, NO_TURNS).turns;

describe('countAssistantTurns', () => {
  /*
    A turn is the model speaking. `user` is not one — every tool result comes
    back as a `user` event, so counting those would double every step and cut a
    run off at half its stated limit.
  */
  it('counts assistant messages and nothing else', () => {
    expect(
      count(
        event('system', { subtype: 'init' }),
        assistant('msg_a'),
        event('user'),
        assistant('msg_b'),
        event('rate_limit_event'),
        event('result', { subtype: 'success' }),
      ),
    ).toBe(2);
  });

  /*
    Captured from a real `claude -p --output-format stream-json` run that read a
    file: **four** assistant events, three distinct `message.id`s — the first
    message emitted its `thinking` block and its `tool_use` block as separate
    events — and the binary's own `result.num_turns` of 3.

    Counting events would therefore have cut a tool-using agent off at three
    quarters of its stated limit, and the more tools it used the worse the
    error. The binary's `num_turns` is the definition worth agreeing with.
  */
  it('counts one turn per message, not per content block', () => {
    const captured = [
      assistant('msg_011CeYD9GDS8D7AQzxVWBDgw', 'thinking'),
      assistant('msg_011CeYD9GDS8D7AQzxVWBDgw', 'tool_use'),
      event('user'),
      assistant('msg_011CeYD9ap7xk6ujok7hSFJq', 'tool_use'),
      event('user'),
      assistant('msg_011CeYD9nWLPH6Weium6eT7B', 'text'),
      event('result', { num_turns: 3 }),
    ];

    expect(count(...captured)).toBe(3);
  });

  /*
    Only the last id is remembered, so a message id that comes back after
    another message counts again. That is the honest reading — the events of one
    message arrive together, so anything else is a new turn — and it is what
    keeps the state from growing across a long run.
  */
  it('counts a repeat that is not adjacent', () => {
    expect(count(assistant('msg_a'), assistant('msg_b'), assistant('msg_a'))).toBe(
      3,
    );
  });

  /*
    An assistant event with no id cannot be deduplicated, so it counts. Dropping
    it would undercount, which is the failure direction that makes a limit
    useless rather than merely wrong.
  */
  it('counts an assistant event carrying no message id', () => {
    expect(count(event('assistant'), event('assistant'))).toBe(2);
  });

  it('starts at nothing', () => {
    expect(NO_TURNS).toEqual({ turns: 0, partial: '', lastId: null });
    expect(count('')).toBe(0);
  });

  /*
    The reason this is a fold rather than a function over lines. A pipe splits
    where it likes, and a counter that read each chunk as a whole line would
    miss the turn entirely — undercounting, which is the direction that makes a
    limit useless rather than merely wrong.
  */
  it('joins an event split across two chunks', () => {
    const whole = assistant('msg_a');
    const cut = Math.floor(whole.length / 2);

    expect(count(whole.slice(0, cut), whole.slice(cut))).toBe(1);
  });

  it('carries the unfinished tail rather than parsing it', () => {
    const state = countAssistantTurns(
      NO_TURNS,
      `${assistant('msg_a')}{"type":"assi`,
    );

    expect(state.turns).toBe(1);
    expect(state.partial).toBe('{"type":"assi');
  });

  /*
    An event that was never fully written was never a turn. A stream that ends
    mid-object leaves it uncounted, which is the honest reading — and the same
    rule that makes the split-chunk case work.
  */
  it('does not count a final line with no newline after it', () => {
    expect(count(assistant('msg_a'), '{"type":"assistant"}')).toBe(1);
  });

  /*
    Warnings and blank lines share this pipe, and a malformed line must not
    throw: this runs inside a stdout handler, where a throw takes the run's log
    down with it.
  */
  it('skips a line that is not JSON', () => {
    expect(
      count('warning: something\n', '\n', assistant('msg_a'), 'null\n', '42\n'),
    ).toBe(1);
  });

  it('skips JSON with no type of its own', () => {
    expect(count('{"message":"hi"}\n', assistant('msg_a'))).toBe(1);
  });

  it('is a fold — the same chunks in sequence reach the same count', () => {
    const whole = `${assistant('msg_a')}${event('user')}${assistant('msg_b')}`;
    const halves = [whole.slice(0, 30), whole.slice(30)];

    expect(count(whole)).toBe(count(...halves));
  });
});
