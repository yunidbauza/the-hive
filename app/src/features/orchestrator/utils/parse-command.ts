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
export function parseCommand(raw: string): ParsedCommand {
  const input = raw.trim();
  if (input === '') return { kind: 'empty', raw: input };

  const [verb, ...rest] = input.split(/\s+/);

  switch (verb) {
    case 'help':
      return { kind: 'help', raw: input };

    case 'status':
      return { kind: 'status', raw: input };

    case 'clear':
      return { kind: 'clear', raw: input };

    case 'open': {
      const [target] = rest;
      if (!target) return { kind: 'usage', raw: input, command: 'open' };
      return { kind: 'open', raw: input, target };
    }

    case 'send': {
      const [target, ...words] = rest;
      // Both "no session" and "no message" are usage errors: a `send` missing
      // either half cannot be routed anywhere.
      if (!target || words.length === 0) {
        return { kind: 'usage', raw: input, command: 'send' };
      }
      return { kind: 'send', raw: input, target, message: words.join(' ') };
    }

    case 'spawn': {
      const [repo, ...words] = rest;
      if (!repo || words.length === 0) {
        return { kind: 'usage', raw: input, command: 'spawn' };
      }
      return { kind: 'spawn', raw: input, repo, task: words.join(' ') };
    }

    default:
      return { kind: 'unknown', raw: input, command: verb };
  }
}
