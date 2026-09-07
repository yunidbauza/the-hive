import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';

import type { SlackSocket, SlackWeb } from './bridge';

/**
 * The two Slack SDK clients, behind the seams `bridge.ts` was written against
 * (HIVE-124).
 *
 * Deliberately the thinnest thing in this folder: almost everything a test
 * could assert here is `@slack/socket-mode`'s own behaviour, and a unit test
 * that reached it would have to open a real WebSocket to learn anything.
 * `bridge.ts` takes `openSocket` and `openWeb` as dependencies for exactly that
 * reason — the decisions live there, where a fake socket can drive them, and
 * the network lives here, where nothing does.
 *
 * The one exception, and the reason this file has a suite at all, is
 * {@link MISSING_SCOPE}: the fallback below is *this app's* decision about what
 * to do when Slack refuses half the request, not the SDK's, so it is tested
 * against a stubbed `WebClient` like any other decision.
 */

/** Ack before anything else: an un-acked envelope is redelivered three times. */
interface SocketEventArg {
  ack?: () => Promise<void>;
}

/**
 * Reconnection is `bridge.ts`'s, not the SDK's (fix-round-3, HIVE-124).
 *
 * Left on — the default — the client retries `apps.connections.open` forever
 * and reports nothing when the retries cannot succeed. A revoked app token
 * throws out of `delayReconnectAttempt`'s own un-awaited callback: no state is
 * emitted, no listener fires, and the pane sits on `Connected` describing a
 * socket that will never carry another message.
 *
 * Off, a drop surfaces as `disconnected` and a failing reconnect rejects out of
 * `start()` into `connect`'s catch, where it becomes `failed` with Slack's own
 * error text. The cost is that this app now owns the retry ladder — see
 * {@link SLACK_RECONNECT_DELAYS_MS} — which is the same trade `bridge.ts`
 * already makes for every other decision in this folder.
 */
const AUTO_RECONNECT = false;

export const openSlackSocket = (appToken: string): SlackSocket => {
  const client = new SocketModeClient({
    appToken,
    autoReconnectEnabled: AUTO_RECONNECT,
  });

  return {
    start: async () => {
      await client.start();
    },
    disconnect: () => client.disconnect(),
    on: (event, fn) => {
      if (event !== 'slack_event') {
        client.on(event, (arg: unknown) => fn(arg));

        return;
      }

      client.on('slack_event', (arg: SocketEventArg) => {
        /*
          `.catch` and not a bare `void`: a dropped WebSocket mid-ack rejects,
          and under Node's default `--unhandled-rejections=throw` that is an
          uncaught exception in the Electron main process.
        */
        void arg.ack?.().catch(() => undefined);
        fn(arg);
      });
    },
  };
};

/**
 * Public and private both, because an agent can only be woken by a channel the
 * bot was invited to and a private invite is the ordinary case for a code-review
 * room.
 */
const ALL_TYPES = 'public_channel,private_channel';

/** The half of {@link ALL_TYPES} that `channels:read` alone can answer. */
const PUBLIC_ONLY = 'public_channel';

/**
 * Slack's word for "you asked for something this token may not have".
 *
 * The failure mode that made this necessary: `groups:read` is what
 * `private_channel` requires, and Slack fails the **whole** `conversations.list`
 * call with this rather than returning the public half — so a user who followed
 * the documented setup (`channels:read`, `channels:history`) got `connect()`
 * catching, `failed` pushed, and a socket that never opened. Degrading to the
 * public half is strictly better than that: channel watching still works
 * everywhere `channels:read` reaches, and the private rooms the token cannot
 * see resolve to nothing — which the pane already reports as `unresolved`
 * rather than dropping in silence.
 */
const MISSING_SCOPE = 'missing_scope';

/**
 * `@slack/web-api` throws a `WebAPIPlatformError` carrying Slack's own JSON on
 * `.data`. Read structurally rather than by class, so a rejection that reached
 * this from anywhere else is not mistaken for one.
 */
const isMissingScope = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;

  const data: unknown = (error as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return false;

  return (data as { error?: unknown }).error === MISSING_SCOPE;
};

export const openSlackWeb = (botToken: string): SlackWeb => {
  const client = new WebClient(botToken);

  const list = async (types: string): Promise<{ name: string; id: string }[]> => {
    const channels: { name: string; id: string }[] = [];

    /*
      200, not the 1000 hard cap: Slack's own docs recommend it, and a large
      workspace times the request out at the cap. `paginate` makes the extra
      round trips invisible, and this runs once per connection.

      Archived channels are excluded — a name that resolves to an archived id
      would look subscribed and never fire.
    */
    for await (const page of client.paginate('conversations.list', {
      types,
      exclude_archived: true,
      limit: 200,
    })) {
      const listed = (page as { channels?: { id?: string; name?: string }[] }).channels;
      for (const item of listed ?? []) {
        if (item.id !== undefined && item.name !== undefined) {
          channels.push({ id: item.id, name: item.name });
        }
      }
    }

    return channels;
  };

  return {
    authTest: async () => {
      const result = await client.auth.test();

      return { team: result.team ?? '', user: result.user ?? '' };
    },
    listChannels: async () => {
      try {
        return await list(ALL_TYPES);
      } catch (error) {
        if (!isMissingScope(error)) throw error;

        console.warn(
          `[hive] slack: conversations.list was refused private channels ` +
            `(the bot token has no groups:read) — watching public channels only.`,
        );

        return await list(PUBLIC_ONLY);
      }
    },
  };
};
