import type { ParsedCommand } from '@/types/command';

/**
 * The orchestrator console's parser.
 *
 * Pure by contract (story 041): it reads a string and returns a
 * `ParsedCommand`. It does not touch the store, so every row of the grammar —
 * including every error path — is testable without a fixture, a timer, or a
 * render.
 *
 * Anything it cannot know from the text alone stays *out* of here. "No such
 * session" and "unknown repo" are runtime failures that need the store, so the
 * parser happily returns `open`/`spawn` with an id that may not exist; the
 * executor is what rejects it. The split is the point: shape errors here,
 * existence errors there.
 */
/**
 * Tidy the input without flattening it.
 *
 * Runs of whitespace are collapsed — that is deliberate and long-standing, so a
 * double space between two words does not survive into a routed message — but
 * **line breaks are not whitespace for this purpose**. `Shift+Enter` puts them
 * there on purpose, and a parser that folds a three-line message into one line
 * silently discards the thing the user pressed a key to create.
 *
 * So the collapse is applied *within* each line and the lines are rejoined.
 * Single-line input, which is every command the grammar had before, is affected
 * in exactly the way it was before.
 */
function normalize(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/gu, ' ').trim())
    .join('\n')
    .trim();
}

/**
 * Split the leading word off a string, returning it and everything after it.
 *
 * Replaces a `split(/\s+/)` over the whole input, which could not survive
 * {@link normalize}: tokenising the entire string and rejoining with `' '` is
 * itself a newline-flattening step, one layer further down. Taking words off the
 * front leaves the tail — the part that is prose rather than grammar — untouched.
 */
function takeWord(input: string): [word: string, rest: string] {
  const match = /^(\S+)([\s\S]*)$/u.exec(input);
  if (!match) return ['', ''];
  return [match[1], match[2].replace(/^\s+/u, '')];
}

export function parseCommand(raw: string): ParsedCommand {
  const input = normalize(raw);
  if (input === '') return { kind: 'empty', raw: input };

  const [verb, rest] = takeWord(input);

  switch (verb) {
    case 'help':
      return { kind: 'help', raw: input };

    case 'status':
      return { kind: 'status', raw: input };

    case 'clear':
      return { kind: 'clear', raw: input };

    case 'open': {
      const [target] = takeWord(rest);
      if (!target) return { kind: 'usage', raw: input, command: 'open' };
      return { kind: 'open', raw: input, target };
    }

    case 'send': {
      const [target, message] = takeWord(rest);
      // Both "no session" and "no message" are usage errors: a `send` missing
      // either half cannot be routed anywhere.
      if (!target || message === '') {
        return { kind: 'usage', raw: input, command: 'send' };
      }
      return { kind: 'send', raw: input, target, message };
    }

    case 'spawn': {
      const [repo, task] = takeWord(rest);
      if (!repo || task === '') {
        return { kind: 'usage', raw: input, command: 'spawn' };
      }
      return { kind: 'spawn', raw: input, repo, task };
    }

    default:
      return { kind: 'unknown', raw: input, command: verb };
  }
}
