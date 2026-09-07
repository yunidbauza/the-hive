import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';

import type { SlackSocket, SlackWeb } from './bridge';

/**
 * The two Slack SDK clients, behind the seams `bridge.ts` was written against
 * (HIVE-124).
 *
 * Deliberately the thinnest thing in this folder, and deliberately untested:
 * everything a test could assert here is `@slack/socket-mode`'s own behaviour,
 * and a unit test that reached this file would have to open a real WebSocket to
 * learn anything. `bridge.ts` takes `openSocket` and `openWeb` as dependencies
 * for exactly that reason — the decisions live there, where a fake socket can
 * drive them, and the network lives here, where nothing does.
 */

/** Ack before anything else: an un-acked envelope is redelivered three times. */
interface SocketEventArg {
  ack?: () => Promise<void>;
}

export const openSlackSocket = (appToken: string): SlackSocket => {
  const client = new SocketModeClient({ appToken });

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

export const openSlackWeb = (botToken: string): SlackWeb => {
  const client = new WebClient(botToken);

  return {
    authTest: async () => {
      const result = await client.auth.test();

      return { team: result.team ?? '', user: result.user ?? '' };
    },
    /*
      Public and private both, because an agent can only be woken by a channel
      the bot was invited to and a private invite is the ordinary case for a
      code-review room. Archived channels are excluded — a name that resolves to
      an archived id would look subscribed and never fire.
    */
    listChannels: async () => {
      const channels: { name: string; id: string }[] = [];

      /*
        200, not the 1000 hard cap: Slack's own docs recommend it, and a large
        workspace times the request out at the cap. `paginate` makes the extra
        round trips invisible, and this runs once per connection.
      */
      for await (const page of client.paginate('conversations.list', {
        types: 'public_channel,private_channel',
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
    },
  };
};
