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

    it('keeps line breaks, which are not whitespace for this purpose', () => {
      /**
       * `⇧↵` puts them there on purpose. The collapse above is deliberate and
       * long-standing, but applying it across newlines too would fold a
       * three-line message into one line — silently discarding the thing the
       * user pressed a key to create. So the collapse runs *within* each line.
       */
      expect(parseCommand('send lead-form first\nsecond')).toMatchObject({
        target: 'lead-form',
        message: 'first\nsecond',
      });

      expect(parseCommand('spawn nova-web do  this\nthen  that')).toMatchObject({
        project: 'nova-web',
        task: 'do this\nthen that',
      });
    });

    it('keeps indentation, so both prompt rows agree about one message', () => {
      /**
       * The per-line `.trim()` this replaces flattened a pasted code block —
       * but only through *this* row. The session's own prompt does not trim per
       * line, so the same paste arrived indented through one and flat through
       * the other: two prompts disagreeing about one message, in the change
       * whose whole point is that the line break survives the trip.
       *
       * Interior runs still collapse; that is the long-standing behaviour and
       * the test above pins it.
       */
      expect(
        parseCommand('send lead-form fix this:\n    if (x)  return;\n    done'),
      ).toMatchObject({
        message: 'fix this:\n    if (x) return;\n    done',
      });
    });

    it('leaves `raw` as the user typed it, collapsing only the message', () => {
      /**
       * `raw` is echoed verbatim into the transcript, so normalising it would
       * quietly rewrite what the user sees they typed. Only the derived field
       * is collapsed — which is also how this behaved before the newline work.
       */
      expect(parseCommand('send lead-form  yes   go')).toMatchObject({
        raw: 'send lead-form  yes   go',
        message: 'yes go',
      });
    });

    it('reads the target across a line break, not just a space', () => {
      // A message begun on its own line is still a message.
      expect(parseCommand('send lead-form\nthe whole thing')).toMatchObject({
        target: 'lead-form',
        message: 'the whole thing',
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
    it('takes a project and the rest of the line as the task', () => {
      expect(parseCommand('spawn nova-web fix the footer')).toEqual({
        kind: 'spawn',
        raw: 'spawn nova-web fix the footer',
        project: 'nova-web',
        task: 'fix the footer',
      });
    });

    it('reports usage when the task is missing', () => {
      expect(parseCommand('spawn nova-web')).toEqual({
        kind: 'usage',
        raw: 'spawn nova-web',
        command: 'spawn',
      });
    });

    it('reports usage when the project is missing', () => {
      expect(parseCommand('spawn')).toMatchObject({
        kind: 'usage',
        command: 'spawn',
      });
    });

    /**
     * Quoted project references (HIVE-94).
     *
     * A project can be named by its *display name*, which is prose and may
     * contain spaces — and `spawn The Hive fix the bug` is unparseable by
     * construction, because nothing in it says where the name stops. Quotes are
     * how the user says so, and they are the convention every shell taught them.
     */
    it('takes a double-quoted project as one argument', () => {
      expect(parseCommand('spawn "The Hive" fix the footer')).toEqual({
        kind: 'spawn',
        raw: 'spawn "The Hive" fix the footer',
        project: 'The Hive',
        task: 'fix the footer',
      });
    });

    it('takes a single-quoted project too', () => {
      expect(parseCommand("spawn 'The Hive' fix it")).toMatchObject({
        project: 'The Hive',
        task: 'fix it',
      });
    });

    /*
      An unterminated quote falls back to plain word-splitting rather than
      swallowing the line. `"The` then fails to resolve and is reported as an
      unknown project — a far better outcome than silently eating the task.
    */
    it('does not let an unterminated quote consume the task', () => {
      expect(parseCommand('spawn "The Hive fix the footer')).toMatchObject({
        project: '"The',
        task: 'Hive fix the footer',
      });
    });

    it('treats an empty quoted argument as a missing one', () => {
      expect(parseCommand('spawn "" fix the footer')).toMatchObject({
        kind: 'usage',
        command: 'spawn',
      });
    });

    // A quote elsewhere in the line is ordinary text: only the first character
    // of the argument decides, and there is no escaping anywhere in the grammar.
    it('leaves a quote inside the task alone', () => {
      expect(parseCommand('spawn hive say "hello there"')).toMatchObject({
        project: 'hive',
        task: 'say "hello there"',
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
