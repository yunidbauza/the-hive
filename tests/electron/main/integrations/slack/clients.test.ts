// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `clients.ts` is otherwise deliberately untested — everything in it is the
 * Slack SDK's own behaviour, and a test that reached it would have to open a
 * real WebSocket to learn anything.
 *
 * The exception is the `missing_scope` fallback, which is **this app's**
 * decision and not the SDK's. `conversations.list` is called with
 * `types: 'public_channel,private_channel'`, and Slack fails the *whole* call
 * when the token has no `groups:read` rather than returning the public half —
 * so a user who followed the documented setup (`channels:read`,
 * `channels:history`) got `connect()` catching, `failed` pushed, and a socket
 * that never opened. The retry is what turns that into channel watching over
 * the channels the token can actually see (fix-round-2, HIVE-124).
 */

/** One `conversations.list` call, as `WebClient.paginate` received it. */
interface Call {
  method: string;
  options: { types?: string; limit?: number; exclude_archived?: boolean };
}

const calls: Call[] = [];

/** Set per test: what `paginate` should do for a given `types` value. */
let pages: (types: string) => unknown[] = () => [];

/** Slack's own error shape — the SDK throws with the JSON body on `.data`. */
const platformError = (error: string): Error =>
  Object.assign(new Error(`An API error occurred: ${error}`), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error },
  });

vi.mock('@slack/socket-mode', () => ({
  SocketModeClient: class {
    start = vi.fn();
    disconnect = vi.fn();
    on = vi.fn();
  },
}));

vi.mock('@slack/web-api', () => ({
  WebClient: class {
    auth = { test: vi.fn(async () => ({ team: 'behiques', user: 'hive' })) };

    paginate(method: string, options: Call['options']) {
      calls.push({ method, options });

      const produced = pages(options.types ?? '');

      return (async function* () {
        for (const page of produced) yield page;
      })();
    }
  },
}));

const { openSlackWeb } = await import(
  '../../../../../electron/main/integrations/slack/clients'
);

const PUBLIC = [{ id: 'C1', name: 'eng-code-review' }];
const PRIVATE = [{ id: 'G1', name: 'eng-secret' }];

beforeEach(() => {
  calls.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openSlackWeb().listChannels', () => {
  it('asks for public and private channels, unarchived, a page at a time', async () => {
    pages = () => [{ channels: [...PUBLIC, ...PRIVATE] }];

    await expect(openSlackWeb('xoxb-2-B').listChannels()).resolves.toEqual([
      { id: 'C1', name: 'eng-code-review' },
      { id: 'G1', name: 'eng-secret' },
    ]);

    expect(calls).toEqual([
      {
        method: 'conversations.list',
        options: {
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
        },
      },
    ]);
  });

  /**
   * The whole reason this file has a suite. Without the retry the bridge gets
   * a rejection here, pushes `failed`, and opens no socket at all — on a
   * workspace where public-channel watching would have worked perfectly.
   */
  it('retries public-only when the token has no groups:read, rather than failing the connection', async () => {
    pages = (types) => {
      if (types.includes('private_channel')) throw platformError('missing_scope');

      return [{ channels: PUBLIC }];
    };

    await expect(openSlackWeb('xoxb-2-B').listChannels()).resolves.toEqual([
      { id: 'C1', name: 'eng-code-review' },
    ]);

    expect(calls.map((call) => call.options.types)).toEqual([
      'public_channel,private_channel',
      'public_channel',
    ]);
    // Degrading in silence would make the missing private rooms a mystery.
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('groups:read'));
  });

  /**
   * The fallback is scoped to the one error it was written for. A revoked
   * token or a rate limit must still reach the bridge, which reports it —
   * retrying public-only would turn every outage into a silent half-answer.
   */
  it('does not swallow any other Slack failure', async () => {
    pages = () => {
      throw platformError('invalid_auth');
    };

    await expect(openSlackWeb('xoxb-2-B').listChannels()).rejects.toThrow(
      /invalid_auth/,
    );
    expect(calls).toHaveLength(1);
  });

  it('does not mistake a plain rejection for a missing scope', async () => {
    pages = () => {
      throw new Error('socket hang up');
    };

    await expect(openSlackWeb('xoxb-2-B').listChannels()).rejects.toThrow(
      /socket hang up/,
    );
    expect(calls).toHaveLength(1);
  });

  it('skips a channel Slack listed without an id or a name', async () => {
    pages = () => [{ channels: [{ id: 'C1' }, { name: 'nameless' }, ...PUBLIC] }, {}];

    await expect(openSlackWeb('xoxb-2-B').listChannels()).resolves.toEqual(PUBLIC);
  });
});
