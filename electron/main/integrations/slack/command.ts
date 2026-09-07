import {
  SLACK_EVENT_TEXT_MAX,
  type SlackEvent,
} from '../../../shared/slack-contract';

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
 *
 * The same reasoning ends at an **empty** task, which is why a named agent with
 * nothing after it is a broadcast too. A `command` is a job run, and the wake
 * prompt for one says "Do the job named above and nothing else" — with no job
 * named, that is an instruction to do nothing, spent on a real model turn. A
 * broadcast is what the words actually asked for: somebody said the agent's
 * name and nothing else, and the agent decides.
 *
 * The console path cannot produce this and never could — `assertText` refuses
 * an empty `extra` — so the fence has to be here, where the text is somebody's
 * typing rather than a form field.
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

  const task = tail.join(' ');
  /* `@hive pr-patrol` alone is a mention of an agent, not a job for it. */
  if (task === '') return { kind: 'broadcast' };

  /*
    Bounded, because this ends up in an argv and in `agents.json`.

    Everything else that becomes a wake's `text` is already clipped — channel
    and mention bursts go through `describeBurst`, and the console's own `extra`
    through `assertText` — and this was the one string that arrived from off the
    machine with no bound at all. A 40 KB Slack message became a 40 KB command
    line. {@link SLACK_EVENT_TEXT_MAX} is the cap the rest of this feature
    already uses, so a command is bounded the same way the message that carried
    it would have been.
  */
  return {
    kind: 'command',
    agent,
    task:
      task.length <= SLACK_EVENT_TEXT_MAX
        ? task
        : `${task.slice(0, SLACK_EVENT_TEXT_MAX)}…`,
  };
}
