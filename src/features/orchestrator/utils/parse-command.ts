import { LEDGER_TAIL_DEFAULT } from '@/types/command';
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

    /**
     * The only verb in the grammar with flags.
     *
     * A loop over {@link takeWord} rather than a tokenise-and-scan, for the
     * reason `takeWord` exists at all: the tail of a command is prose, and
     * splitting the whole string to find a flag is the newline-flattening step
     * this parser was rewritten to avoid.
     *
     * Every malformed flag is a `usage` outcome rather than a runtime failure,
     * which is this file's standing split: shape errors here, existence errors
     * in the store. `-n abc` is a shape the parser can reject by itself.
     */
    case 'ledger': {
      let open = false;
      let events = false;
      let from: string | undefined;
      let to: string | undefined;
      let limit = LEDGER_TAIL_DEFAULT;
      let cursor = rest;

      while (cursor !== '') {
        const [token, tail] = takeWord(cursor);

        if (token === '--open') {
          open = true;
          cursor = tail;
          continue;
        }

        if (token === '--events') {
          events = true;
          cursor = tail;
          continue;
        }

        if (token === '--from' || token === '--to' || token === '-n') {
          const [value, next] = takeWord(tail);
          if (!value) return { kind: 'usage', raw: input, command: 'ledger' };

          if (token === '--from') {
            from = value;
          } else if (token === '--to') {
            to = value;
          } else {
            // A tail of "not a number" or "nothing" is not a tail that could be
            // printed, so it is a shape error rather than an empty result.
            if (!/^\d+$/u.test(value)) {
              return { kind: 'usage', raw: input, command: 'ledger' };
            }
            const count = Number.parseInt(value, 10);
            if (count < 1) return { kind: 'usage', raw: input, command: 'ledger' };
            limit = count;
          }

          cursor = next;
          continue;
        }

        return { kind: 'usage', raw: input, command: 'ledger' };
      }

      /*
        The optional halves are spread rather than assigned, so an absent filter
        leaves no key at all. A `from: undefined` would reach `matches()` as a
        filter that is present but matches nothing — the opposite of no filter.
      */
      return {
        kind: 'ledger',
        raw: input,
        open,
        events,
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        limit,
      };
    }

    /** `send`'s shape exactly — a target, then prose. */
    case 'ask': {
      const [target, tail] = takeWord(rest);
      const message = normalize(tail);
      if (!target || message === '') {
        return { kind: 'usage', raw: input, command: 'ask' };
      }
      return { kind: 'ask', raw: input, target, message };
    }

    case 'answer': {
      const [thread, tail] = takeWord(rest);
      const message = normalize(tail);
      if (!thread || message === '') {
        return { kind: 'usage', raw: input, command: 'answer' };
      }
      return { kind: 'answer', raw: input, thread, message };
    }

    case 'agents':
      return { kind: 'agents', raw: input };

    /**
     * `send`'s shape, not `open`'s (HIVE-126).
     *
     * The tail used to be dropped here, deliberately: `AgentRunRequest` was
     * `{ name }` with a closed key set, so a task had nowhere to travel, and
     * waking the agent was a better answer than refusing the line. What that
     * reasoning cost was a verb that lied — `run pr-reviewer review PR 1234`
     * reported success and woke an agent that had never heard of the PR — so
     * the key set was opened for prose instead.
     *
     * What survives of it is the shape below: unlike `send`, an absent tail is
     * **not** a usage error, because `run <agent>` on its own is still a whole
     * command. Only a missing name is.
     */
    case 'run': {
      const [target, tail] = takeWord(rest);
      if (!target) return { kind: 'usage', raw: input, command: 'run' };
      /*
        One line, unlike `send` and `ask`.

        `normalize` keeps line breaks, because a message reaching a pty or the
        log is prose that may be a list. This one is neither: it reaches
        `wakePrompt` as the tail of `You woke because: manual — …`, through a
        guard (`assertText`, the one `spawn.task` uses) that refuses every C0
        character including LF. Flattening here is what keeps the grammar and
        the boundary agreeing — the alternative is a command that parses and
        then dies at the IPC with "control characters are not allowed".

        It also states the division of labour this story is drawing: `run` says
        *why* in a phrase, and prose that needs line breaks is what `ask` is
        for.
      */
      const prompt = normalize(tail).replace(/\s*\n\s*/gu, ' ');
      if (prompt === '') return { kind: 'run', raw: input, target };
      return { kind: 'run', raw: input, target, prompt };
    }

    /*
      `open`'s shape — a bare target, and anything after it is surplus rather
      than an error (HIVE-117).

      Each of these means exactly one thing, so there is nothing a trailing
      word could add, and refusing the line would turn a request the console
      *can* honour into nothing at all. `run` above is the one that grew a
      second argument, because it is the only one a person can have a reason
      for.

      `rotate` joined the group in HIVE-122 rather than earning a case of its
      own: it is grammatically indistinguishable from the three beside it — an
      agent name, and nothing the renderer may say about how — and its payload
      is the same `AgentNameRequest` theirs is.
    */
    case 'pause':
    case 'resume':
    case 'rotate':
    case 'kill': {
      const [target] = takeWord(rest);
      if (!target) return { kind: 'usage', raw: input, command: verb };
      return { kind: verb, raw: input, target };
    }

    default:
      return { kind: 'unknown', raw: input, command: verb };
  }
}
