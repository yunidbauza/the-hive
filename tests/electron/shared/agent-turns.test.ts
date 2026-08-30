// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  NO_TURNS,
  countAssistantTurns,
} from '../../../electron/shared/agent-turns';

/** One line of `--output-format stream-json`, as the binary emits it. */
const event = (type: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ type, ...extra })}\n`;

/** Fold a whole transcript in one go, the way a single chunk would arrive. */
const count = (...chunks: string[]) =>
  chunks.reduce(countAssistantTurns, NO_TURNS).turns;

describe('countAssistantTurns', () => {
  /*
    A turn is the model speaking. `user` is not one — every tool result comes
    back as a `user` event, so counting those would double every step and cut a
    run off at half its stated limit.
  */
  it('counts assistant events and nothing else', () => {
    expect(
      count(
        event('system', { subtype: 'init' }),
        event('assistant'),
        event('user'),
        event('assistant'),
        event('result', { subtype: 'success' }),
      ),
    ).toBe(2);
  });

  it('starts at nothing', () => {
    expect(NO_TURNS).toEqual({ turns: 0, partial: '' });
    expect(count('')).toBe(0);
  });

  /*
    The reason this is a fold rather than a function over lines. A pipe splits
    where it likes, and a counter that read each chunk as a whole line would
    miss the turn entirely — undercounting, which is the direction that makes a
    limit useless rather than merely wrong.
  */
  it('joins an event split across two chunks', () => {
    expect(count('{"type":"assi', 'stant"}\n')).toBe(1);
  });

  it('carries the unfinished tail rather than parsing it', () => {
    const state = countAssistantTurns(NO_TURNS, `${event('assistant')}{"type":"assi`);

    expect(state.turns).toBe(1);
    expect(state.partial).toBe('{"type":"assi');
  });

  /*
    An event that was never fully written was never a turn. A stream that ends
    mid-object leaves it uncounted, which is the honest reading — and the same
    rule that makes the split-chunk case work.
  */
  it('does not count a final line with no newline after it', () => {
    expect(count(event('assistant'), '{"type":"assistant"}')).toBe(1);
  });

  /*
    Warnings and blank lines share this pipe, and a malformed line must not
    throw: this runs inside a stdout handler, where a throw takes the run's log
    down with it.
  */
  it('skips a line that is not JSON', () => {
    expect(
      count('warning: something\n', '\n', event('assistant'), 'null\n', '42\n'),
    ).toBe(1);
  });

  it('skips JSON with no type of its own', () => {
    expect(count('{"message":"hi"}\n', event('assistant'))).toBe(1);
  });

  it('is a fold — the same chunks in sequence reach the same count', () => {
    const whole = `${event('assistant')}${event('user')}${event('assistant')}`;
    const halves = [whole.slice(0, 30), whole.slice(30)];

    expect(count(whole)).toBe(count(...halves));
  });
});
