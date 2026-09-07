// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSlackBridge,
  type SlackSocket,
  type SlackWeb,
} from '../../../../../electron/main/integrations/slack/bridge';
import { readSubscriptions } from '../../../../../electron/main/integrations/slack/subscriptions';
import {
  SLACK_EVENT_DEBOUNCE_MS,
  SLACK_EVENT_DEDUPE_MAX,
  SLACK_EVENT_MIN_GAP_MS,
} from '../../../../../electron/shared/slack-contract';

const message = (ts: string, user = 'U08BA712189', channel = 'C0123ABCD') => ({
  type: 'events_api',
  payload: { event: { type: 'message', channel, user, ts, text: `msg ${ts}` } },
});

const mention = (ts: string, text: string, user = 'U08BA712189') => ({
  type: 'events_api',
  payload: {
    event: { type: 'app_mention', channel: 'C0123ABCD', user, ts, text },
  },
});

function harness(over: Partial<Parameters<typeof createSlackBridge>[0]> = {}) {
  const listeners = new Map<string, (arg: unknown) => void>();
  const socket: SlackSocket & { started: number; disconnected: number } = {
    started: 0,
    disconnected: 0,
    start: vi.fn(async function (this: typeof socket) {
      this.started += 1;
      listeners.get('connected')?.(undefined);
    }),
    disconnect: vi.fn(async function (this: typeof socket) {
      this.disconnected += 1;
    }),
    on: (event: string, fn: (arg: unknown) => void) => listeners.set(event, fn),
  } as never;

  const web: SlackWeb = {
    authTest: vi.fn(async () => ({ team: 'behiques', user: 'hive' })),
    listChannels: vi.fn(async () => [{ name: 'eng-code-review', id: 'C0123ABCD' }]),
  };

  const wakes: { name: string; entry: unknown; job: boolean }[] = [];
  const statuses: unknown[] = [];
  /** The app token each `openSocket` was handed, in order — one entry per attempt. */
  const opened: string[] = [];

  const bridge = createSlackBridge({
    tokens: { read: () => ({ appToken: 'xapp-1-A', botToken: 'xoxb-2-B' }) },
    config: () => ({ socketMode: true, commanders: ['U08BA712189'] }),
    subscriptions: () =>
      readSubscriptions([
        { name: 'pr-patrol', paused: false, valid: true, on: ['slack.channel:#eng-code-review'] },
        { name: 'acr', paused: false, valid: true, on: ['slack.app_mention'] },
      ]),
    openSocket: (appToken: string) => {
      opened.push(appToken);

      return socket;
    },
    openWeb: () => web,
    onWake: (name, entry, opts) => wakes.push({ name, entry, job: opts.job }),
    onStatus: (status) => statuses.push(status),
    now: () => Date.now(),
    ...over,
  });

  /**
   * One `slack_event`, in the shape `@slack/socket-mode` actually emits.
   *
   * Load-bearing, and the reason this comment is long. The SDK does **not**
   * hand the listener the WebSocket frame: `SocketModeClient.js` splits it into
   * siblings —
   *
   * ```js
   * this.emit('slack_event', { ack, envelope_id, type: event.type, body: event.payload, … });
   * ```
   *
   * — so `type` is `'events_api'` and `body` is the Events API payload alone.
   * An earlier harness delivered `{ body: <the whole frame> }`, which no Slack
   * installation ever produces, and it certified a `bodyOf` that unwrapped
   * `.body` and handed `readEnvelope` a payload with no `type` on it. Every
   * real event was dropped, silently, with the pane reading "Connected".
   *
   * The fixtures and `events.ts` speak the *frame*, which is the right unit for
   * them — so this splits a frame the way the SDK does rather than the fixtures
   * being rewritten around the SDK's split.
   */
  const deliver = (envelope: unknown) => {
    const frame = envelope as { type?: unknown; payload?: unknown };

    listeners.get('slack_event')?.({
      ack: async () => undefined,
      envelope_id: '1d3c8e00-0000-4000-8000-000000000009',
      type: frame.type,
      body: frame.payload,
    });
  };

  return { bridge, socket, web, wakes, statuses, opened, deliver, listeners };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('connecting', () => {
  it('opens the socket when the switch is on, tokens are held and an agent subscribes', async () => {
    const h = harness();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();
    expect(h.socket.started).toBe(1);
  });

  it('does not connect while the switch is off', async () => {
    const h = harness({ config: () => ({ socketMode: false, commanders: [] }) });
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();
    expect(h.socket.started).toBe(0);
    expect(h.statuses.at(-1)).toEqual({ kind: 'off' });
  });

  it('does not connect without both tokens', async () => {
    const h = harness({ tokens: { read: () => ({ appToken: 'xapp-1-A' }) } });
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();
    expect(h.socket.started).toBe(0);
  });

  it('does not connect while no enabled agent subscribes', async () => {
    const h = harness({
      subscriptions: () =>
        readSubscriptions([
          { name: 'quiet', paused: false, valid: true, on: ['ledger'] },
        ]),
    });
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();
    expect(h.socket.started).toBe(0);
    expect(h.statuses.at(-1)).toEqual({ kind: 'off' });
  });

  it('opens the socket once across repeated syncs', async () => {
    const h = harness();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();
    h.bridge.sync();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();
    expect(h.socket.started).toBe(1);
  });

  it('does not open a socket a sync turned off while the connect was in flight', async () => {
    let socketMode = true;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      config: () => ({ socketMode, commanders: ['U08BA712189'] }),
      openWeb: () => ({
        authTest: async () => ({ team: 'behiques', user: 'hive' }),
        listChannels: async () => {
          await gate;

          return [{ name: 'eng-code-review', id: 'C0123ABCD' }];
        },
      }),
    });

    h.bridge.sync();
    socketMode = false;
    h.bridge.sync();
    release();
    await vi.runOnlyPendingTimersAsync();

    expect(h.socket.started).toBe(0);
    expect(h.statuses.at(-1)).toEqual({ kind: 'off' });
  });

  /*
    The sibling of the test above, through the other await. `connect` is not the
    only continuation: `announceConnected` awaits `auth.test` after the socket
    is already up, so an answer to a question asked before the user said stop
    can land on the pane afterwards and paint `connected` over their `off`.
  */
  it('does not report connected when a sync turned Slack off mid auth.test', async () => {
    let socketMode = true;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      config: () => ({ socketMode, commanders: ['U08BA712189'] }),
      openWeb: () => ({
        authTest: async () => {
          await gate;

          return { team: 'behiques', user: 'hive' };
        },
        listChannels: async () => [{ name: 'eng-code-review', id: 'C0123ABCD' }],
      }),
    });

    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();
    expect(h.socket.started).toBe(1);
    expect(h.statuses.at(-1)).toEqual({ kind: 'connecting' });

    socketMode = false;
    h.bridge.sync();
    expect(h.statuses.at(-1)).toEqual({ kind: 'off' });

    release();
    await vi.runOnlyPendingTimersAsync();
    expect(h.statuses.at(-1)).toEqual({ kind: 'off' });
  });

  /**
   * A token *replaced* is not a token cleared, and only the second one used to
   * work (fix-round-2, HIVE-124).
   *
   * `sync()` reads the tokens fresh but then returns early on `socket !== null`
   * — so rotating the app token in Slack left the bridge holding a revoked one
   * for the rest of the process's life, `failed` and unrecoverable without a
   * restart or a toggle. Clearing was always handled (the token goes
   * `undefined` and the whole thing tears down); replacing was the silent
   * no-op, and nothing covered it.
   */
  it('reconnects with the new token when one is rotated under a live socket', async () => {
    let appToken = 'xapp-1-OLD';
    const h = harness({ tokens: { read: () => ({ appToken, botToken: 'xoxb-2-B' }) } });

    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();
    expect(h.opened).toEqual(['xapp-1-OLD']);

    appToken = 'xapp-1-NEW';
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    // The stale connection is closed, and the second one carries the new token.
    expect(h.socket.disconnected).toBe(1);
    expect(h.opened).toEqual(['xapp-1-OLD', 'xapp-1-NEW']);
    expect(h.statuses.at(-1)).toEqual({
      kind: 'connected',
      workspace: 'behiques',
      bot: 'hive',
      unresolved: [],
    });
  });

  /** The other half of the same claim: an *unchanged* token reconnects nothing. */
  it('does not reconnect when a sync re-reads the same pair', async () => {
    const h = harness();

    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    expect(h.opened).toEqual(['xapp-1-A']);
    expect(h.socket.disconnected).toBe(0);
  });

  /**
   * The same rotation one tick earlier, through `opening` rather than through
   * `socket !== null` — the other early return, and the one a fix that only
   * guarded the first would leave open.
   */
  it('reconnects when a token is replaced while the first handshake is still in flight', async () => {
    let appToken = 'xapp-1-OLD';
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      tokens: { read: () => ({ appToken, botToken: 'xoxb-2-B' }) },
      openWeb: () => ({
        authTest: async () => ({ team: 'behiques', user: 'hive' }),
        listChannels: async () => {
          await gate;

          return [{ name: 'eng-code-review', id: 'C0123ABCD' }];
        },
      }),
    });

    h.bridge.sync();
    expect(h.opened).toEqual([]);

    appToken = 'xapp-1-NEW';
    h.bridge.sync();
    release();
    await vi.runOnlyPendingTimersAsync();

    // The abandoned attempt never opened a socket; the replacement did, once.
    expect(h.opened).toEqual(['xapp-1-NEW']);
  });

  it('disconnects when the last subscriber is paused', async () => {
    let paused = false;
    const h = harness({
      subscriptions: () =>
        readSubscriptions([
          { name: 'pr-patrol', paused, valid: true, on: ['slack.channel:#eng-code-review'] },
        ]),
    });
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();
    expect(h.socket.started).toBe(1);

    paused = true;
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();
    expect(h.socket.disconnected).toBe(1);
    expect(h.statuses.at(-1)).toEqual({ kind: 'off' });
  });
});

describe('coalescing', () => {
  it('turns a burst inside the debounce into one wake', async () => {
    const h = harness();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    h.deliver(message('1757012345.000100'));
    h.deliver(message('1757012345.000200'));
    h.deliver(message('1757012345.000300'));
    expect(h.wakes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(SLACK_EVENT_DEBOUNCE_MS);
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0].name).toBe('pr-patrol');
    expect(h.wakes[0].job).toBe(false);
    expect((h.wakes[0].entry as { text: string }).text).toContain('3 messages');
    expect((h.wakes[0].entry as { kind: string }).kind).toBe('slack.channel');
    expect((h.wakes[0].entry as { id: string }).id).toBe('1757012345.000300');
    expect((h.wakes[0].entry as { text: string }).text).toContain('#eng-code-review');
  });

  it('holds the second wake behind the floor and delivers it when the gap opens', async () => {
    const h = harness();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    h.deliver(message('1757012345.000100'));
    await vi.advanceTimersByTimeAsync(SLACK_EVENT_DEBOUNCE_MS);
    expect(h.wakes).toHaveLength(1);

    h.deliver(message('1757012400.000100'));
    await vi.advanceTimersByTimeAsync(SLACK_EVENT_DEBOUNCE_MS);
    expect(h.wakes).toHaveLength(1);

    /*
      To the millisecond, because this is what tells a *remainder* re-arm apart
      from a fresh-gap one. Wake #1 landed at t = DEBOUNCE, so the floor opens
      at t = DEBOUNCE + MIN_GAP: the flush that found it closed must re-arm for
      what is left of the gap, not start a whole new one. Advancing by MIN_GAP
      from here would reach t = 2·DEBOUNCE + MIN_GAP and pass either way.
    */
    await vi.advanceTimersByTimeAsync(SLACK_EVENT_MIN_GAP_MS - SLACK_EVENT_DEBOUNCE_MS - 1);
    expect(h.wakes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.wakes).toHaveLength(2);
  });

  /*
    Correction 1 to the brief: the dedupe key is per *agent*, not global.

    An `@hive` mention posted in a watched channel arrives twice — once as
    `app_mention`, once as `message`. A global `(channel, ts)` key would let the
    mention's delivery to its own subscriber swallow the channel watcher's copy,
    so an agent watching `#eng-code-review` would silently stop seeing every
    message that mentioned the app. The invariant is that one Slack message
    never wakes *the same agent* twice.
  */
  it('wakes an agent watching both routes once, and still wakes the channel watcher', async () => {
    const h = harness({
      subscriptions: () =>
        readSubscriptions([
          {
            name: 'both',
            paused: false,
            valid: true,
            on: ['slack.channel:#eng-code-review', 'slack.app_mention'],
          },
          {
            name: 'pr-patrol',
            paused: false,
            valid: true,
            on: ['slack.channel:#eng-code-review'],
          },
        ]),
    });
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    h.deliver(mention('1757012400.002100', '<@U09HIVEBOT> hello'));
    h.deliver(message('1757012400.002100'));
    await vi.advanceTimersByTimeAsync(SLACK_EVENT_DEBOUNCE_MS);

    expect(h.wakes.filter((w) => w.name === 'both')).toHaveLength(1);
    expect(h.wakes.filter((w) => w.name === 'pr-patrol')).toHaveLength(1);
  });

  it('bounds the dedupe cache, so the oldest key is evicted first', async () => {
    const h = harness();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    const first = '1757010000.000000';
    h.deliver(message(first));
    for (let index = 1; index <= SLACK_EVENT_DEDUPE_MAX; index += 1) {
      h.deliver(message(`17570100${String(index).padStart(2, '0')}.000001`));
    }
    /*
      The oldest key has been evicted, so the same message is admitted again —
      the cache is bounded rather than a leak that grows for the app's lifetime.
    */
    h.deliver(message(first));
    await vi.advanceTimersByTimeAsync(SLACK_EVENT_DEBOUNCE_MS);

    expect(h.wakes).toHaveLength(1);
    expect((h.wakes[0].entry as { text: string }).text).toContain(
      `${SLACK_EVENT_DEDUPE_MAX + 2} messages`,
    );
  });
});

describe('commands', () => {
  it('runs a named agent immediately, past the debounce and the floor', async () => {
    const h = harness();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    h.deliver(mention('1757012400.002100', '<@U09HIVEBOT> pr-patrol review 42'));
    expect(h.wakes).toEqual([
      {
        name: 'pr-patrol',
        entry: {
          kind: 'slack.command',
          id: '1757012400.002100',
          from: 'U08BA712189',
          text: 'review 42',
        },
        job: true,
      },
    ]);
  });

  it('does not reset the floor, so a channel wake behind it is not delayed', async () => {
    const h = harness();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    h.deliver(mention('1757012400.002100', '<@U09HIVEBOT> pr-patrol review 42'));
    h.deliver(message('1757012401.000100'));
    await vi.advanceTimersByTimeAsync(SLACK_EVENT_DEBOUNCE_MS);

    expect(h.wakes).toHaveLength(2);
  });

  it('delivers two commands separately rather than collapsing them', async () => {
    const h = harness();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    h.deliver(mention('1757012400.002100', '<@U09HIVEBOT> pr-patrol review 42'));
    h.deliver(mention('1757012400.002200', '<@U09HIVEBOT> pr-patrol review 43'));

    expect(h.wakes.map((w) => (w.entry as { text: string }).text)).toEqual([
      'review 42',
      'review 43',
    ]);
  });

  it('buffers a bare mention for every mention subscriber', async () => {
    const h = harness();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    h.deliver(mention('1757012400.002100', '<@U09HIVEBOT> anyone home'));
    await vi.advanceTimersByTimeAsync(SLACK_EVENT_DEBOUNCE_MS);

    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0].name).toBe('acr');
    expect(h.wakes[0].job).toBe(false);
    expect((h.wakes[0].entry as { kind: string }).kind).toBe('slack.app_mention');
  });

  it('drops a mention from an author who is not allow-listed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    h.deliver(mention('1757012400.002100', '<@U09HIVEBOT> pr-patrol go', 'U0STRANGER'));
    await vi.advanceTimersByTimeAsync(SLACK_EVENT_DEBOUNCE_MS + SLACK_EVENT_MIN_GAP_MS);
    expect(h.wakes).toHaveLength(0);
    warn.mockRestore();
  });

  it('rate-limits the refusal log rather than writing one line per message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    for (let index = 0; index < 6; index += 1) {
      h.deliver(
        mention(`175701240${index}.002100`, '<@U09HIVEBOT> pr-patrol go', 'U0STRANGER'),
      );
    }
    expect(warn).toHaveBeenCalledTimes(1);

    /* Past the window, the next refusal reports how many it swallowed. */
    await vi.advanceTimersByTimeAsync(SLACK_EVENT_MIN_GAP_MS);
    h.deliver(mention('1757012407.002100', '<@U09HIVEBOT> pr-patrol go', 'U0STRANGER'));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1][0])).toContain('5 more');

    expect(h.wakes).toHaveLength(0);
    warn.mockRestore();
  });
});

describe('channel resolution', () => {
  it('ignores a channel no enabled agent subscribes to', async () => {
    const h = harness();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    h.deliver(message('1757012345.000100', 'U08BA712189', 'C9OTHER'));
    await vi.advanceTimersByTimeAsync(SLACK_EVENT_DEBOUNCE_MS);
    expect(h.wakes).toHaveLength(0);
  });

  /**
   * The emission shape, written out literally rather than through `deliver`.
   *
   * `deliver` builds it, so this is the one place a reader can see what the SDK
   * hands over without following a helper: `type` and `body` as siblings, and
   * `body` holding the Events API payload alone. Unwrapping `.body` and passing
   * it on was the shipped bug — every real message dropped, no log line, pane
   * reading "Connected" — and it survived eleven reviews because the harness
   * spoke a shape Slack never sends.
   */
  it('reads the sibling type/body the SDK emits, not the frame it received', async () => {
    const h = harness();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    h.listeners.get('slack_event')?.({
      ack: async () => undefined,
      envelope_id: '1d3c8e00-0000-4000-8000-000000000003',
      type: 'events_api',
      body: {
        type: 'event_callback',
        team_id: 'T01ABCDEF',
        event: {
          type: 'message',
          channel: 'C0123ABCD',
          user: 'U08BA712189',
          ts: '1757012345.000100',
          text: 'can someone review 42',
        },
      },
    });
    await vi.advanceTimersByTimeAsync(SLACK_EVENT_DEBOUNCE_MS);

    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0].name).toBe('pr-patrol');
  });

  it('ignores an envelope that is not a Slack event at all', async () => {
    const h = harness();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    h.deliver({ type: 'hello' });
    await vi.advanceTimersByTimeAsync(SLACK_EVENT_DEBOUNCE_MS);
    expect(h.wakes).toHaveLength(0);
  });

  it('refreshes a stale index when an agent names a channel after connecting', async () => {
    let listed = [{ name: 'eng-code-review', id: 'C0123ABCD' }];
    let watching = ['slack.channel:#eng-code-review'];
    const h = harness({
      openWeb: () => ({
        authTest: async () => ({ team: 'behiques', user: 'hive' }),
        listChannels: async () => listed,
      }),
      subscriptions: () =>
        readSubscriptions([
          { name: 'pr-patrol', paused: false, valid: true, on: watching },
        ]),
    });
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();
    expect(h.bridge.unresolved()).toEqual([]);

    /* Named, but the workspace has no such room yet — reported, not dropped. */
    watching = ['slack.channel:#eng-code-review', 'slack.channel:#new-room'];
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();
    expect(h.bridge.unresolved()).toEqual(['#new-room']);
    expect(h.statuses.at(-1)).toEqual({
      kind: 'connected',
      workspace: 'behiques',
      bot: 'hive',
      unresolved: ['#new-room'],
    });

    /* The room now exists. The socket is still up, so only a refresh can see it. */
    listed = [...listed, { name: 'new-room', id: 'C9NEWROOM' }];
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();
    expect(h.bridge.unresolved()).toEqual([]);
    expect(h.statuses.at(-1)).toEqual({
      kind: 'connected',
      workspace: 'behiques',
      bot: 'hive',
      unresolved: [],
    });

    h.deliver(message('1757012345.000100', 'U08BA712189', 'C9NEWROOM'));
    await vi.advanceTimersByTimeAsync(SLACK_EVENT_DEBOUNCE_MS);
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0].name).toBe('pr-patrol');
    expect(h.socket.started).toBe(1);
  });

  it('reports a channel name that resolves to nothing rather than dropping it silently', async () => {
    const h = harness({
      subscriptions: () =>
        readSubscriptions([
          { name: 'pr-patrol', paused: false, valid: true, on: ['slack.channel:#not-a-channel'] },
        ]),
    });
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();
    expect(h.bridge.unresolved()).toEqual(['#not-a-channel']);
    expect(h.statuses.at(-1)).toEqual({
      kind: 'connected',
      workspace: 'behiques',
      bot: 'hive',
      unresolved: ['#not-a-channel'],
    });
  });
});

describe('status and teardown', () => {
  it('reports connected with the workspace auth.test returned', async () => {
    const h = harness();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();
    expect(h.statuses.at(-1)).toEqual({
      kind: 'connected',
      workspace: 'behiques',
      bot: 'hive',
      unresolved: [],
    });
  });

  /**
   * The suppression, stated as a property rather than left implicit
   * (fix-round-2, HIVE-124).
   *
   * `push` compares the serialised status against the last one and drops a
   * repeat. That is what makes the pane's mount-time read (`slack:socket-state`)
   * necessary rather than a convenience: "just push the last status again when
   * somebody subscribes" is the obvious fix, it would compile, and it would be
   * silently dropped by this line every time. Without a test naming it, the
   * next person tries exactly that and believes it worked.
   */
  it('drops a repeat of the last status, so re-announcing it reaches nobody', async () => {
    const h = harness();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    const before = h.statuses.length;
    const last = h.statuses.at(-1);

    // The socket dropping and coming back re-announces the identical status.
    h.listeners.get('connected')?.(undefined);
    await vi.runOnlyPendingTimersAsync();

    expect(h.statuses).toHaveLength(before);
    // Suppressed on the wire, but still the bridge's answer when it is *asked*.
    expect(h.bridge.status()).toEqual(last);
  });

  /**
   * The read half of the same story: a pane that mounts long after boot asks
   * rather than waits, because the push it would wait for already happened.
   */
  it('answers with the last status pushed, and with off before there is one', async () => {
    const h = harness();
    expect(h.bridge.status()).toEqual({ kind: 'off' });

    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    expect(h.bridge.status()).toEqual({
      kind: 'connected',
      workspace: 'behiques',
      bot: 'hive',
      unresolved: [],
    });
  });

  it('reports a failure the socket raised rather than staying on connecting', async () => {
    const h = harness();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    h.listeners.get('error')?.(new Error('invalid app token'));
    expect(h.statuses.at(-1)).toEqual({ kind: 'failed', message: 'invalid app token' });
  });

  it('answers Test from auth.test without opening a socket', async () => {
    const h = harness();
    await expect(h.bridge.test()).resolves.toEqual({
      kind: 'ok',
      workspace: 'behiques',
      bot: 'hive',
    });
    expect(h.socket.started).toBe(0);
  });

  it('answers Test with an error when no bot token is held', async () => {
    const h = harness({ tokens: { read: () => ({}) } });
    const result = await h.bridge.test();
    expect(result.kind).toBe('error');
  });

  it('stops the socket and cancels every pending timer', async () => {
    const h = harness();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();

    h.deliver(message('1757012345.000100'));
    expect(vi.getTimerCount()).toBe(1);

    h.bridge.stop();
    /*
      The timer count, not only the absence of a wake: `flush` returns early on
      `stopped`, so "no wake arrived" passes even if `teardown` never cleared a
      thing. This is the assertion that holds the `clearTimeoutFn` loop.
    */
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(SLACK_EVENT_DEBOUNCE_MS + SLACK_EVENT_MIN_GAP_MS);

    expect(h.socket.disconnected).toBe(1);
    expect(h.wakes).toHaveLength(0);
  });

  it('ignores a sync after stop', async () => {
    const h = harness();
    h.bridge.stop();
    h.bridge.sync();
    await vi.runOnlyPendingTimersAsync();
    expect(h.socket.started).toBe(0);
  });
});
