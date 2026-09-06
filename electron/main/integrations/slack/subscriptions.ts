import {
  WAKE_ON_CHANNEL_PREFIX,
  type WakeOn,
} from '../../../shared/agent-contract';
import { SLACK_MENTION_KIND } from '../../../shared/slack-contract';

/**
 * What the socket has to be open for (HIVE-124).
 *
 * The bridge connects only while at least one **enabled** agent subscribes to
 * something the socket carries, and disconnects when the last one is paused or
 * removed. That is the ticket's criterion, and it is why this is recomputed on
 * every agent change rather than read once at boot.
 *
 * `slack.mention` is deliberately absent from the mention list. It is not
 * Slack's `app_mention` and never was: it means *search my mentions on the
 * wakes this agent already takes*, Slack emits no event for a person's
 * mentions, and an agent that names only `slack.mention` must not hold a socket
 * open for events that will never arrive.
 */

export interface SubscribableAgent {
  name: string;
  paused: boolean;
  /** A definition the waker refuses subscribes to nothing. */
  valid: boolean;
  on: readonly string[];
}

export interface SlackSubscriptions {
  /** `#name`, lowercased, → the agents watching it, in registry order. */
  channels: Map<string, string[]>;
  mentions: string[];
  /** Every enabled agent, for `@hive <name>` matching. */
  known: string[];
}

const isChannel = (value: string): value is WakeOn =>
  value.startsWith(WAKE_ON_CHANNEL_PREFIX);

export function readSubscriptions(
  agents: readonly SubscribableAgent[],
): SlackSubscriptions {
  const channels = new Map<string, string[]>();
  const mentions: string[] = [];
  const known: string[] = [];

  for (const agent of agents) {
    if (agent.paused || !agent.valid) continue;
    known.push(agent.name);

    for (const value of agent.on) {
      if (value === SLACK_MENTION_KIND) {
        mentions.push(agent.name);
        continue;
      }
      if (!isChannel(value)) continue;
      /*
        Lowercased on the way in, because Slack channel names are lowercase by
        Slack's own rule and a definition that typed `#Eng-Code-Review` means
        the same channel. Matching case-sensitively would be a subscription that
        validates, renders in the pane, and never fires.
      */
      const name = value.slice(WAKE_ON_CHANNEL_PREFIX.length).toLowerCase();
      const key = name.startsWith('#') ? name : `#${name}`;
      const watchers = channels.get(key);
      if (watchers === undefined) channels.set(key, [agent.name]);
      else watchers.push(agent.name);
    }
  }

  return { channels, mentions, known };
}

export const needsSocket = (subs: SlackSubscriptions): boolean =>
  subs.channels.size > 0 || subs.mentions.length > 0;
