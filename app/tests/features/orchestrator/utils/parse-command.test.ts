import { describe, expect, it } from 'vitest';

import { parseCommand } from '@features/orchestrator/utils/parse-command';

/**
 * The command grammar is the highest-value unit-test target in the app
 * (story 041): it is pure, it has explicit error paths, and it is the closest
 * thing the prototype has to the future daemon's API surface. Every row of the
 * grammar table gets a test, including every error.
 */
describe('parseCommand', () => {
  describe('no-argument commands', () => {
    it.each(['help', 'status', 'clear'] as const)('parses %s', (verb) => {
      expect(parseCommand(verb)).toEqual({ kind: verb, raw: verb });
    });

    it('ignores surrounding whitespace', () => {
      expect(parseCommand('   help   ')).toEqual({ kind: 'help', raw: 'help' });
    });

    it('treats blank input as empty rather than an error', () => {
      // Pressing Enter on an empty prompt is not a mistake worth a red line.
      expect(parseCommand('   ')).toEqual({ kind: 'empty', raw: '' });
      expect(parseCommand('')).toEqual({ kind: 'empty', raw: '' });
    });
  });

  describe('open', () => {
    it('takes a session id', () => {
      expect(parseCommand('open webhooks')).toEqual({
        kind: 'open',
        raw: 'open webhooks',
        target: 'webhooks',
      });
    });

    it('accepts an id that may not exist — that is the executor’s job', () => {
      /**
       * The parser cannot know what sessions exist. Shape errors here,
       * existence errors in the store; conflating them would make one of the
       * two untestable without the other.
       */
      expect(parseCommand('open nope')).toMatchObject({
        kind: 'open',
        target: 'nope',
      });
    });

    it('reports usage when the id is missing', () => {
      expect(parseCommand('open')).toEqual({
        kind: 'usage',
        raw: 'open',
        command: 'open',
      });
    });
  });

  describe('send', () => {
    it('takes an id and the rest of the line as the message', () => {
      expect(parseCommand('send lead-form y please')).toEqual({
        kind: 'send',
        raw: 'send lead-form y please',
        target: 'lead-form',
        message: 'y please',
      });
    });

    it('collapses runs of whitespace inside the message', () => {
      expect(parseCommand('send lead-form  yes   go')).toMatchObject({
        message: 'yes go',
      });
    });

    it('reports usage when the message is missing', () => {
      expect(parseCommand('send lead-form')).toEqual({
        kind: 'usage',
        raw: 'send lead-form',
        command: 'send',
      });
    });

    it('reports usage when everything is missing', () => {
      expect(parseCommand('send')).toMatchObject({
        kind: 'usage',
        command: 'send',
      });
    });
  });

  describe('spawn', () => {
    it('takes a repo and the rest of the line as the task', () => {
      expect(parseCommand('spawn apfm-web fix the footer')).toEqual({
        kind: 'spawn',
        raw: 'spawn apfm-web fix the footer',
        repo: 'apfm-web',
        task: 'fix the footer',
      });
    });

    it('reports usage when the task is missing', () => {
      expect(parseCommand('spawn apfm-web')).toEqual({
        kind: 'usage',
        raw: 'spawn apfm-web',
        command: 'spawn',
      });
    });

    it('reports usage when the repo is missing', () => {
      expect(parseCommand('spawn')).toMatchObject({
        kind: 'usage',
        command: 'spawn',
      });
    });
  });

  describe('anything else', () => {
    it('reports the verb it did not recognise', () => {
      expect(parseCommand('frobnicate the thing')).toEqual({
        kind: 'unknown',
        raw: 'frobnicate the thing',
        command: 'frobnicate',
      });
    });

    it('is case-sensitive, like a shell', () => {
      // `HELP` is not `help`. Silently accepting it would imply a
      // case-insensitivity the rest of the grammar does not have.
      expect(parseCommand('HELP')).toMatchObject({ kind: 'unknown' });
    });
  });

  it('never touches anything outside its argument', () => {
    // Purity is the contract that makes every row above testable without a
    // store, a timer, or a render.
    const input = 'send lead-form hello';
    expect(parseCommand(input)).toEqual(parseCommand(input));
  });
});
