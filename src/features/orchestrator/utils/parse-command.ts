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
 * session" and "unknown project" are runtime failures that need the store, so the
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
    .map((line) => {
      /**
       * **Leading whitespace survives; runs inside the line do not.**
       *
       * The per-line `.trim()` this replaces destroyed indentation, and that
       * mattered more than it looks. The session's own prompt row does not trim
       * per line (`normalizeLines` in `lib/terminal/text.ts` strips controls and
       * nothing else), so the same pasted code block arrived indented through
       * one row and flattened through the other — two prompts disagreeing about
       * one message, in the story whose whole point is that the line break
       * survives the trip.
       *
       * Collapsing *interior* runs is the long-standing behaviour and stays:
       * `send x  yes   go` still yields `yes go`.
       */
      const indent = /^[^\S\n]*/u.exec(line)?.[0] ?? '';
      return indent + line.slice(indent.length).replace(/[^\S\n]+/gu, ' ').trimEnd();
    })
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

/**
 * Like {@link takeWord}, but a quoted argument counts as one word (HIVE-94).
 *
 * `spawn` takes a project, and a project can now be named by its *display
 * name* — which is prose and may contain spaces. `spawn The Hive fix the bug`
 * is unparseable by construction: nothing in the string says where the name
 * stops and the task starts. Quotes are how the user says so, and they are the
 * convention every shell already taught them.
 *
 * Deliberately **only the opening character decides**. There is no escaping and
 * no quote handling anywhere else in the grammar: an unterminated quote falls
 * back to plain word-splitting rather than swallowing the rest of the line, so
 * a stray `"` in a task is still a task and not a parse failure. Both quote
 * characters are accepted because an apostrophe-free name is not something a
 * user should have to think about.
 */
function takeArgument(input: string): [word: string, rest: string] {
  const quote = input[0];
  if (quote !== '"' && quote !== "'") return takeWord(input);

  const closing = input.indexOf(quote, 1);
  // Unterminated: not a quoted argument at all. `"The` is then an ordinary
  // word, which fails to resolve and is reported as an unknown project — a far
  // better outcome than consuming the task.
  if (closing === -1) return takeWord(input);

  const word = input.slice(1, closing);
  const rest = input.slice(closing + 1).replace(/^\s+/u, '');
  // An empty `""` is not an argument. Reporting it as a missing one is what the
  // user meant, and keeps `!project` at the call site the only emptiness check.
  return [word, rest];
}

export function parseCommand(raw: string): ParsedCommand {
  /**
   * `raw` is trimmed and otherwise left alone; only the *derived* message and
   * task are collapsed.
   *
   * The distinction matters because `raw` is echoed verbatim into the
   * transcript (`hive-store.ts`), so normalising it would quietly rewrite what
   * the user sees they typed. That is also how the field behaved before this
   * story — the old code collapsed only inside `message`/`task` — and there was
   * no reason for that to change.
   */
  const input = raw.trim();
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
      const [target, tail] = takeWord(rest);
      const message = normalize(tail);
      // Both "no session" and "no message" are usage errors: a `send` missing
      // either half cannot be routed anywhere.
      if (!target || message === '') {
        return { kind: 'usage', raw: input, command: 'send' };
      }
      return { kind: 'send', raw: input, target, message };
    }

    case 'spawn': {
      const [project, tail] = takeArgument(rest);
      const task = normalize(tail);
      if (!project || task === '') {
        return { kind: 'usage', raw: input, command: 'spawn' };
      }
      return { kind: 'spawn', raw: input, project, task };
    }

    default:
      return { kind: 'unknown', raw: input, command: verb };
  }
}
