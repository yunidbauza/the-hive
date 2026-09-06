import {
  SLACK_CHANNEL_KIND,
  SLACK_EVENT_TEXT_MAX,
  SLACK_MENTION_KIND,
  type SlackEvent,
} from '../../../shared/slack-contract';

/**
 * One Socket Mode envelope in, zero or one event out (HIVE-124).
 *
 * Pure, and separate from `bridge.ts` for the reason `scheduler-rules.ts` is
 * separate from `scheduler.ts`: what is worth testing exhaustively is the
 * decision, and a test that had to open a socket to reach it would test the
 * socket instead.
 *
 * The drops matter more than the reads. A `subtype` means the message is not
 * somebody saying something — `message_changed`, `message_deleted`,
 * `channel_join` all arrive as `type: 'message'` — and waking an agent for a
 * join notice is the kind of noise that gets a feature turned off. `bot_id`
 * covers the case that actually bites: an agent posting through Slack produces
 * a message in the channel it watches, and without this drop the first reply it
 * writes wakes it again to read its own words.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

export function readEnvelope(envelope: unknown): SlackEvent | null {
  if (!isRecord(envelope)) return null;
  if (envelope.type !== 'events_api') return null;
  if (!isRecord(envelope.payload)) return null;

  const event = envelope.payload.event;
  if (!isRecord(event)) return null;

  const kind =
    event.type === 'message'
      ? SLACK_CHANNEL_KIND
      : event.type === 'app_mention'
        ? SLACK_MENTION_KIND
        : null;
  if (kind === null) return null;

  if (event.subtype !== undefined) return null;
  if (event.bot_id !== undefined) return null;

  const channel = str(event.channel);
  const ts = str(event.ts);
  const user = str(event.user);
  if (channel === null || ts === null || user === null) return null;

  return {
    kind,
    channel,
    ts,
    threadTs: str(event.thread_ts) ?? ts,
    user,
    text: typeof event.text === 'string' ? event.text : '',
  };
}

/**
 * The channel as the wake prompt names it.
 *
 * The **id is always present**, even when the name resolved, because the agent
 * has to pass an id to `slack_read_channel` and re-resolving it would spend a
 * tool call on something main already knew. Without a name, the id alone: a
 * `#` in front of a `C0123ABCD` would be a channel name that does not exist.
 */
const place = (event: SlackEvent, channelName: string | null): string =>
  channelName === null ? `(${event.channel})` : `${channelName} (${event.channel})`;

const clip = (text: string): string =>
  text.length <= SLACK_EVENT_TEXT_MAX ? text : `${text.slice(0, SLACK_EVENT_TEXT_MAX)}…`;

export function describeEvent(event: SlackEvent, channelName: string | null): string {
  return (
    `${place(event, channelName)} · thread ${event.threadTs} · ` +
    `from ${event.user}: ${clip(event.text)}`
  );
}

/**
 * A burst, as one line.
 *
 * Collapsed rather than listed: the queue's job is to cause one wake, and the
 * agent reads the channel itself on that wake. The count is what tells it
 * whether one message or thirty are waiting, and the newest is quoted because
 * it is the one most likely to be the reason.
 *
 * The **thread** named is the newest message's thread, so an agent that replies
 * without reading lands in the right place; the count is the signal that it
 * should read rather than reply.
 */
export function describeBurst(
  events: readonly SlackEvent[],
  channelName: string | null,
): string {
  if (events.length === 0) return '';
  const newest = events.reduce((best, item) => (item.ts > best.ts ? item : best));
  if (events.length === 1) return describeEvent(newest, channelName);
  return (
    `${place(newest, channelName)} · ${events.length} messages · ` +
    `newest thread ${newest.threadTs} from ${newest.user}: ${clip(newest.text)}`
  );
}
