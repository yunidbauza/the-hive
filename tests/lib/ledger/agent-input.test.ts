import { describe, expect, it } from 'vitest';

import { parseAgentInput } from '@lib/ledger/agent-input';

/**
 * The agent view's input grammar (HIVE-116).
 *
 * One verb and a default, which is the whole design: this box is a way to talk
 * to an agent, not a console. The tests that matter most are the ones proving
 * prose is never mistaken for a malformed command.
 */
describe('parseAgentInput', () => {
  it('reads answer <ref> <text>', () => {
    expect(parseAgentInput('answer a71 approve')).toEqual({
      kind: 'answer',
      thread: 'a71',
      body: 'approve',
    });
  });

  it('keeps the whole tail of an answer', () => {
    expect(parseAgentInput('answer a71 hold for me, I will look tonight')).toEqual(
      {
        kind: 'answer',
        thread: 'a71',
        body: 'hold for me, I will look tonight',
      },
    );
  });

  it('takes a canonical id as readily as a short ref', () => {
    // `ledger.answer` resolves either in main, so this grammar must not be
    // the thing that decides which forms are legal.
    expect(parseAgentInput('answer 20260830-141530-0001 yes')).toEqual({
      kind: 'answer',
      thread: '20260830-141530-0001',
      body: 'yes',
    });
  });

  it('treats anything else as an ask addressed to this agent', () => {
    expect(parseAgentInput('check the deploy again')).toEqual({
      kind: 'ask',
      body: 'check the deploy again',
    });
  });

  it('does not mistake the bare word answer for the verb', () => {
    expect(parseAgentInput('answer')).toEqual({ kind: 'ask', body: 'answer' });
  });

  it('treats a ref with no reply as prose, not a malformed verb', () => {
    // There is no usage error to report here and nowhere to report it: a
    // half-typed command is indistinguishable from a sentence that begins
    // with the same two words, and refusing the sentence is the worse guess.
    expect(parseAgentInput('answer a71')).toEqual({
      kind: 'ask',
      body: 'answer a71',
    });
  });

  it('lets a sentence that merely starts with answer through as prose', () => {
    // The verb is recognised only when the second word *looks like* a thread —
    // a ref or a canonical id. Without that, "answer me this: …" would be
    // silently posted as an answer to a thread called `me`, which fails as a
    // write and loses the message.
    expect(parseAgentInput('answer me this: is staging green?')).toEqual({
      kind: 'ask',
      body: 'answer me this: is staging green?',
    });
  });

  it('does not take a ref-shaped word that is not a ref', () => {
    expect(parseAgentInput('answer alpha with the log')).toEqual({
      kind: 'ask',
      body: 'answer alpha with the log',
    });
  });

  it('collapses runs of whitespace and trims the ends', () => {
    expect(parseAgentInput('  check    the   deploy  ')).toEqual({
      kind: 'ask',
      body: 'check the deploy',
    });
  });

  it('reports an empty box, so a stray Enter posts nothing', () => {
    expect(parseAgentInput('   ')).toEqual({ kind: 'empty' });
    expect(parseAgentInput('')).toEqual({ kind: 'empty' });
  });

  it('survives a newline pasted into the box', () => {
    expect(parseAgentInput('answer a71 line one\nline two')).toEqual({
      kind: 'answer',
      thread: 'a71',
      body: 'line one line two',
    });
  });
});
