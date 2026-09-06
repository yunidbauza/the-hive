import type { SlackEvent } from '../../../shared/slack-contract';

/**
 * `@hive <agent> <task>`, and who is allowed to type it (HIVE-124).
 *
 * This is the first way anyone off this machine can start an agent run, so the
 * allow-list is checked before anything else is read. It **defaults to empty**:
 * nothing in this app can honestly discover the user's own Slack id —
 * `auth.test` returns the *bot's* identity, and the human's id is known only to
 * the MCP server the agents talk to — and guessing it would repeat the
 * paraphrase mistake HIVE-123 corrected.
 *
 * A refusal is **silent**. Replying "you are not authorised" tells an unknown
 * person that this machine is listening and whose it is; the log line is for
 * the owner, who can read it.
 *
 * An unknown leading word is task text, not a failed agent name. Guessing wrong
 * is worse than waking the subscribers: a broadcast reaches somebody who can
 * read the message, where a refusal reaches nobody and looks like silence.
 */

export type SlackCommand =
  | { kind: 'refused' }
  | { kind: 'broadcast' }
  | { kind: 'command'; agent: string; task: string };

/** `<@U09HIVEBOT>` and `<@U09HIVEBOT|hive>`, however many lead the message. */
const LEADING_MENTIONS = /^(?:\s*<@[A-Z0-9]+(?:\|[^>]*)?>\s*)+/;

export function readCommand(
  event: SlackEvent,
  known: readonly string[],
  commanders: readonly string[],
): SlackCommand {
  if (!commanders.includes(event.user)) return { kind: 'refused' };

  const rest = event.text.replace(LEADING_MENTIONS, '').trim();
  if (rest === '') return { kind: 'broadcast' };

  const [head, ...tail] = rest.split(/\s+/);
  /*
    Case-insensitive because a person typing in Slack is not typing a filename,
    and `agents.json` names are lowercase by construction — `parseAgent`
    refuses anything else — so folding here can never match two agents.
  */
  const agent = known.find((name) => name.toLowerCase() === head.toLowerCase());
  if (agent === undefined) return { kind: 'broadcast' };

  return { kind: 'command', agent, task: tail.join(' ') };
}
