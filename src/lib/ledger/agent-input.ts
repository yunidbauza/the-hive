import { LEDGER_REF_PREFIX } from '@shared/ledger-contract';

/**
 * What the agent view's one input box means (HIVE-116).
 *
 * One verb and a default. `answer <thread> <text>` closes an open ask;
 * everything else is prose the overmind is saying *to* this agent, which
 * reaches it as an `ask`. There is no unknown-command case on purpose: this
 * box is a way to talk to an agent, not a console, and refusing a sentence
 * because its first word happened to be a verb is the worse guess.
 *
 * ## Why not the orchestrator's parser
 *
 * `parseCommand` lives in `features/orchestrator/`, which `features/agents/`
 * may not import — an ESLint boundary, not a convention. But the fence is the
 * smaller reason. The grammars genuinely differ: the console has a verb list
 * and answers an unrecognised word with a usage line, while this one has a
 * fallback that swallows everything. Sharing them would mean one parser told
 * which of two grammars it is in, which is two functions in a trenchcoat.
 *
 * ## Why the thread has to look like a thread
 *
 * The verb is recognised only when the second word is a ref (`a12`) or a
 * canonical id. A looser rule reads "answer me this: is staging green?" as an
 * answer to a thread named `me` — a write that fails in main and loses the
 * message on the way. Prose that happens to start with the verb is far more
 * likely than a thread named after an English pronoun.
 */
export type AgentInput =
  | { kind: 'answer'; thread: string; body: string }
  | { kind: 'ask'; body: string }
  | { kind: 'empty' };

/**
 * A ref (`a12`) or a canonical id (`20260830-141530-0001`).
 *
 * The prefix comes from the contract rather than a literal, so a ref that is
 * respelled there cannot leave this box quietly refusing to answer. Both forms
 * are accepted because `ledger.answer` resolves either in main, and this
 * grammar must not be the thing that decides which are legal.
 */
const THREAD = new RegExp(
  `^(?:${LEDGER_REF_PREFIX}\\d+|\\d{8}-\\d{6}-\\d{4})$`,
);

export function parseAgentInput(raw: string): AgentInput {
  // A pasted newline is whitespace here: the ledger holds one body, and a box
  // that silently dropped everything after the first line would be worse.
  const text = raw.trim().replace(/\s+/g, ' ');

  if (text === '') return { kind: 'empty' };

  const match = /^answer (\S+) (.+)$/.exec(text);

  if (match !== null) {
    const [, thread, body] = match;

    if (thread !== undefined && body !== undefined && THREAD.test(thread)) {
      return { kind: 'answer', thread, body };
    }
  }

  return { kind: 'ask', body: text };
}
