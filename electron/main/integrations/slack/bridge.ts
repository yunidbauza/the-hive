import type { PendingWakeEntry } from '../../../shared/agent-contract';
import {
  SLACK_COMMAND_KIND,
  SLACK_EVENT_DEBOUNCE_MS,
  SLACK_EVENT_DEDUPE_MAX,
  SLACK_EVENT_MIN_GAP_MS,
  SLACK_MENTION_KIND,
  type SlackEvent,
  type SlackSocketStatus,
  type SlackSocketTestResult,
} from '../../../shared/slack-contract';

import { readCommand } from './command';
import { describeBurst, readEnvelope } from './events';
import { needsSocket, type SlackSubscriptions } from './subscriptions';

/**
 * Slack Socket Mode, as a wake source (HIVE-124).
 *
 * The crux of the story, and the one module in this folder that holds state.
 * Everything it decides *with* is pure and tested next door — `readEnvelope`
 * says whether an envelope is a message at all, `readCommand` says whether an
 * `@hive` is an instruction and who is allowed to type one, `readSubscriptions`
 * says which agents care — so what is left here is the part only a stateful
 * thing can own: **when** a wake happens, and how many of them there are.
 *
 * ## Why two fences, and why a command clears both
 *
 * Push replaces a five-minute tick. Without a fence, a channel that gets thirty
 * messages in a standup spends thirty agent runs on them, and the feature's
 * first day is also its last. So a burst inside {@link SLACK_EVENT_DEBOUNCE_MS}
 * collapses into one wake, and two wakes of the same agent are never closer
 * than {@link SLACK_EVENT_MIN_GAP_MS}.
 *
 * A person typing `@hive pr-patrol review 42` gets neither. They are asking for
 * a run the way pressing Run asks for one, and a minute of silence in reply to
 * a direct instruction reads as broken. It also does **not** touch the floor's
 * clock: resetting it would mean a command delayed the channel wake standing
 * behind it, which is the opposite of what asking for something should do.
 *
 * ## Why the collapse is one entry, not several
 *
 * `Scheduler.onEvent` takes a single {@link PendingWakeEntry}, and
 * `describeEntry` renders exactly one line from it. Handing the queue five
 * entries for five messages would put five nearly identical lines in the wake
 * prompt to describe one thing that happened. `describeBurst` already says "12
 * messages, newest …", which is what the agent needs to decide whether to read
 * the channel — so the buffer collapses to one entry whose `kind`, `id` and
 * `from` come from the newest message in it.
 *
 * ## Why the dedupe key carries the agent
 *
 * An `@hive` posted in a watched channel arrives **twice**: once as
 * `app_mention` and once as `message`. Deduping on `(channel, ts)` alone looks
 * right and is a bug — the mention's delivery to its own subscriber would
 * consume the key, and the channel watcher's copy would be dropped, so an agent
 * watching `#eng-code-review` would silently stop seeing every message that
 * mentioned the app. The invariant is per agent: one Slack message never wakes
 * *the same agent* twice.
 */

export interface SlackSocket {
  start(): Promise<void>;
  disconnect(): Promise<void>;
  on(
    event: 'slack_event' | 'connected' | 'disconnected' | 'error',
    fn: (arg: unknown) => void,
  ): void;
}

export interface SlackWeb {
  /** `auth.test` — the **bot's** identity and its workspace, never a person's. */
  authTest(): Promise<{ team: string; user: string }>;
  listChannels(): Promise<{ name: string; id: string }[]>;
}

export interface SlackBridge {
  /** Re-read config, tokens and subscriptions, and connect or disconnect. */
  sync(): void;
  /** The pane's Test button. Opens no socket. */
  test(): Promise<SlackSocketTestResult>;
  /** Channel names from `wake.on` that resolved to no Slack channel id. */
  unresolved(): string[];
  stop(): void;
}

export interface SlackBridgeDeps {
  tokens: { read(): { appToken?: string; botToken?: string } };
  config: () => { socketMode: boolean; commanders: string[] };
  subscriptions: () => SlackSubscriptions;
  openSocket: (appToken: string) => SlackSocket;
  openWeb: (botToken: string) => SlackWeb;
  onWake: (name: string, entry: PendingWakeEntry, opts: { job: boolean }) => void;
  onStatus: (status: SlackSocketStatus) => void;
  now: () => number;
  /** Injected by the unit test, as in `scheduler.ts`. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

const NO_BOT_TOKEN =
  `No bot token is stored, so there is nothing to test with. Paste an ` +
  `xoxb- token first.`;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The `slack_event` argument, unwrapped.
 *
 * `@slack/socket-mode` emits an object carrying `ack`, `body` and a few
 * conveniences; the adapter acks and forwards `{ body }`, and `readEnvelope`
 * wants the body. Tolerant of a bare envelope so the shape of the adapter is
 * not load-bearing here.
 */
const bodyOf = (arg: unknown): unknown =>
  typeof arg === 'object' && arg !== null && 'body' in arg
    ? (arg as { body: unknown }).body
    : arg;

/** `#eng-code-review` — the key `readSubscriptions` indexes channels under. */
const channelKey = (name: string): string => `#${name.toLowerCase()}`;

export function createSlackBridge(deps: SlackBridgeDeps): SlackBridge {
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;

  let stopped = false;
  let socket: SlackSocket | null = null;
  /** True between the decision to connect and the socket being live or failed. */
  let opening = false;
  let refreshing = false;
  let pushed: SlackSocketStatus | null = null;
  /** The web client of the live connection, kept so a refresh reuses it. */
  let web: SlackWeb | null = null;

  /**
   * Which connection attempt is the current one.
   *
   * Bumped by every {@link teardown}. `stopped` alone is not enough: `connect`
   * awaits `listChannels` and `announceConnected` awaits `auth.test`, and
   * during either await a `sync()` can turn the switch off or watch the last
   * agent be paused. Without this, that `sync()` tears down a connection that
   * is still arriving, the continuation resumes, opens a socket anyway and
   * pushes `connected` over the `off` the user just caused — a socket
   * delivering wakes after Slack was turned off, self-healing only on a next
   * `sync()` nothing schedules.
   *
   * There are exactly three places an `era` is captured — `connect`,
   * `announceConnected` (which takes it as a parameter, because it is resumed
   * from a socket event rather than started by one) and `refreshChannels` — and
   * two guards that read it: {@link isCurrent} for control flow, and
   * {@link pushFor} for anything the pane is told. Every `await` in this module
   * is followed by one of them; a new one must be too.
   */
  let generation = 0;

  /** `#name → id`, and `null` until `conversations.list` has answered once. */
  let nameToId: Map<string, string> | null = null;
  let idToName = new Map<string, string>();

  /**
   * `(channel, ts, agent)`, insertion-ordered, oldest evicted.
   *
   * A `Set` is the whole cache: JavaScript's iteration order *is* insertion
   * order, so the first key the iterator yields is the oldest one, and an LRU
   * with timestamps would buy nothing a bounded FIFO does not already give.
   */
  const seen = new Set<string>();

  /**
   * Per agent: what has arrived since its last wake.
   *
   * Bounded in practice rather than by a cap. A buffer lives at most one
   * {@link SLACK_EVENT_MIN_GAP_MS} — the flush that finds the floor closed
   * re-arms for the remainder rather than starting the clock over — so the
   * worst case is a minute of one channel's traffic, and capping it would make
   * `describeBurst`'s count lie about how much is waiting.
   */
  const buffers = new Map<string, SlackEvent[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastEventWakeAt = new Map<string, number>();

  /**
   * Is `era` still the connection this bridge is running?
   *
   * The one question every continuation past an `await` has to ask. `stopped`
   * is folded in because a stopped bridge is nobody's current connection.
   */
  const isCurrent = (era: number): boolean => !stopped && era === generation;

  /**
   * Say something to the pane.
   *
   * **Synchronous callers only.** Anything speaking from the far side of an
   * `await` must use {@link pushFor} instead: by then the user may have turned
   * Slack off, and a stale `connected` landing on top of the `off` they caused
   * is the exact bug the generation counter exists to prevent.
   */
  const push = (status: SlackSocketStatus): void => {
    if (pushed !== null && JSON.stringify(pushed) === JSON.stringify(status)) return;
    pushed = status;
    deps.onStatus(status);
  };

  /**
   * A push from a continuation, dropped if its connection has been torn down.
   *
   * Era-aware rather than "is there a socket": teardown followed by a *new*
   * connection leaves a socket in place, and the stale continuation's answer —
   * an older workspace, an older unresolved list — must still not overwrite the
   * live one's. The generation is the only thing that tells those apart.
   */
  const pushFor = (era: number, status: SlackSocketStatus): void => {
    if (!isCurrent(era)) return;
    push(status);
  };

  const unresolved = (): string[] => {
    const index = nameToId;
    if (index === null) return [];

    return [...deps.subscriptions().channels.keys()].filter((name) => !index.has(name));
  };

  /**
   * Say the unresolved list again, without claiming anything else changed.
   *
   * {@link unresolved} is live — it re-reads `subscriptions()` — but the copy
   * the pane holds arrived on a status push, so a refresh that resolves a name
   * has to send one or the verb and the pane disagree until the next reconnect.
   */
  const repushUnresolved = (era: number): void => {
    const last = pushed;
    if (last === null || last.kind !== 'connected') return;

    pushFor(era, {
      kind: 'connected',
      workspace: last.workspace,
      bot: last.bot,
      unresolved: unresolved(),
    });
  };

  /* ------------------------------------------------------------- the queue */

  const claim = (event: SlackEvent, agent: string): boolean => {
    const key = `${event.channel}\u0000${event.ts}\u0000${agent}`;
    if (seen.has(key)) return false;

    seen.add(key);
    while (seen.size > SLACK_EVENT_DEDUPE_MAX) {
      const oldest = seen.values().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }

    return true;
  };

  /**
   * Arm the debounce, or leave the armed one alone.
   *
   * Deliberately **not** a resetting debounce. A channel with a message every
   * two seconds would push a resetting timer forever and never wake anybody —
   * exactly the channel where the wake matters most. This is a fixed window
   * from the first buffered message, so a burst always resolves.
   */
  const arm = (name: string, delay: number): void => {
    if (timers.has(name)) return;
    timers.set(
      name,
      setTimeoutFn(() => {
        timers.delete(name);
        flush(name);
      }, delay),
    );
  };

  const flush = (name: string): void => {
    if (stopped) return;

    const queued = buffers.get(name);
    if (queued === undefined || queued.length === 0) {
      buffers.delete(name);

      return;
    }

    const since = deps.now() - (lastEventWakeAt.get(name) ?? Number.NEGATIVE_INFINITY);
    if (since < SLACK_EVENT_MIN_GAP_MS) {
      arm(name, SLACK_EVENT_MIN_GAP_MS - since);

      return;
    }

    const newest = queued.reduce((best, item) => (item.ts > best.ts ? item : best));
    buffers.delete(name);
    lastEventWakeAt.set(name, deps.now());

    deps.onWake(
      name,
      {
        kind: newest.kind,
        id: newest.ts,
        from: newest.user,
        text: describeBurst(queued, idToName.get(newest.channel) ?? null),
      },
      { job: false },
    );
  };

  const buffer = (name: string, event: SlackEvent): void => {
    if (!claim(event, name)) return;

    const queued = buffers.get(name);
    if (queued === undefined) buffers.set(name, [event]);
    else queued.push(event);

    arm(name, SLACK_EVENT_DEBOUNCE_MS);
  };

  /* ------------------------------------------------------------- the reads */

  /**
   * One line a minute for refusals, with a count of what it swallowed.
   *
   * Silent to Slack, and now bounded in the log too. Replying "you are not
   * authorised" tells a stranger that this machine is listening and whose it
   * is; the owner is the one who needs to know. But one line per refused
   * mention is unbounded main-process noise — anyone in a watched channel can
   * type `@hive` as fast as they like — so the window is
   * {@link SLACK_EVENT_MIN_GAP_MS}, this app's existing answer to "how often is
   * too often", and the count is what stops the throttle hiding a flood.
   */
  let refusalWarnAt = Number.NEGATIVE_INFINITY;
  let refusalsSinceWarn = 0;

  const warnRefused = (event: SlackEvent): void => {
    refusalsSinceWarn += 1;

    const at = deps.now();
    if (at - refusalWarnAt < SLACK_EVENT_MIN_GAP_MS) return;

    const swallowed = refusalsSinceWarn - 1;
    refusalWarnAt = at;
    refusalsSinceWarn = 0;

    console.warn(
      `[hive] slack: ignored @hive from ${event.user} — not on the commander list` +
        (swallowed > 0 ? ` (and ${swallowed} more since the last line)` : ''),
    );
  };

  /**
   * An `@hive`, as an instruction or as a wake.
   *
   * The allow-list is checked **before** the shape of the text, so a mention
   * from anyone not on it is refused whether or not it names an agent. That is
   * deliberate and is not a bug to fix: a broadcast wake *is* an agent run — it
   * spends model budget and executes a definition — so the question "who may
   * start a run from Slack" has the same answer either way, and the shape of
   * the words does not change who is causing it. `command.ts`'s neighbouring
   * rationale for preferring a broadcast to a refusal is about a *known* author
   * choosing unclear words, and does not carry to an unknown one.
   *
   * The consequence, stated so nobody has to rediscover it: the commander list
   * defaults to empty, so until the user adds their own Slack id
   * `wake.on: [slack.app_mention]` produces no wakes at all. The pane's
   * Wakes-on summary is where that is made visible — an empty list renders as
   * "@hive → nobody yet · add a Slack user id" — not here.
   */
  const routeMention = (event: SlackEvent, subs: SlackSubscriptions): void => {
    const command = readCommand(event, subs.known, deps.config().commanders);

    if (command.kind === 'refused') {
      warnRefused(event);

      return;
    }

    if (command.kind === 'command') {
      if (!claim(event, command.agent)) return;

      /*
        Immediate, individual, and it does not touch `lastEventWakeAt`. Two
        commands are two runs with two task strings; collapsing them would lose
        one of the things a person actually asked for.
      */
      deps.onWake(
        command.agent,
        {
          kind: SLACK_COMMAND_KIND,
          id: event.ts,
          from: event.user,
          text: command.task,
        },
        { job: true },
      );

      return;
    }

    for (const name of subs.mentions) buffer(name, event);
  };

  const routeChannel = (event: SlackEvent, subs: SlackSubscriptions): void => {
    const name = idToName.get(event.channel);
    if (name === undefined) return;

    const watchers = subs.channels.get(name);
    if (watchers === undefined) return;

    for (const watcher of watchers) buffer(watcher, event);
  };

  const onSocketEvent = (arg: unknown): void => {
    if (stopped) return;

    const event = readEnvelope(bodyOf(arg));
    if (event === null) return;

    const subs = deps.subscriptions();
    if (event.kind === SLACK_MENTION_KIND) routeMention(event, subs);
    else routeChannel(event, subs);
  };

  /* -------------------------------------------------------- the connection */

  const setChannelIndex = (channels: readonly { name: string; id: string }[]): void => {
    nameToId = new Map(channels.map((item) => [channelKey(item.name), item.id]));
    idToName = new Map(channels.map((item) => [item.id, channelKey(item.name)]));
  };

  /**
   * `auth.test`, and the `connected` the pane draws from it.
   *
   * `era` is not decoration. This awaits, and a `sync()` during that await can
   * turn Slack off — so both pushes go through {@link pushFor}, or the answer
   * to a question asked before the user said stop lands on the pane after.
   */
  const announceConnected = async (client: SlackWeb, era: number): Promise<void> => {
    try {
      const { team, user } = await client.authTest();
      pushFor(era, {
        kind: 'connected',
        workspace: team,
        bot: user,
        unresolved: unresolved(),
      });
    } catch (error) {
      /*
        The socket is up; only the identity call failed — a bot token without
        `auth:read` is the ordinary cause. `connected` with two nulls is the
        honest reading, because `failed` would say wakes are not arriving when
        they are, and the log line is what stops the two nulls being a mystery.
      */
      console.warn(`[hive] slack: auth.test failed — ${messageOf(error)}`);
      pushFor(era, {
        kind: 'connected',
        workspace: null,
        bot: null,
        unresolved: unresolved(),
      });
    }
  };

  const connect = async (appToken: string, botToken: string): Promise<void> => {
    const era = generation;
    const live = (): boolean => isCurrent(era);
    let opened: SlackSocket | null = null;

    try {
      const client = deps.openWeb(botToken);
      /*
        Once per connection, not per event. Slack events carry the channel
        **id** and never the name, and `wake.on` names channels the way a person
        writes them, so one side has to be translated — and doing it here means
        a wake costs no API call at all. `refreshChannels` is the on-demand
        second door, for a name added after the socket came up.
      */
      const channels = await client.listChannels();
      if (!live()) return;

      web = client;
      setChannelIndex(channels);

      opened = deps.openSocket(appToken);
      const socketRef = opened;
      opened.on('slack_event', (arg) => {
        if (live()) onSocketEvent(arg);
      });
      opened.on('connected', () => {
        if (live()) void announceConnected(client, era);
      });
      /*
        The client reconnects itself, so a drop is `connecting` rather than
        `failed`: nothing is broken, and nothing is arriving either.
      */
      opened.on('disconnected', () => pushFor(era, { kind: 'connecting' }));
      opened.on('error', (arg) =>
        pushFor(era, { kind: 'failed', message: messageOf(arg) }),
      );

      socket = opened;
      await opened.start();

      /* Turned off while the handshake was in flight — close what we opened. */
      if (!live()) {
        if (socket === socketRef) socket = null;
        void socketRef.disconnect().catch(() => undefined);
      }
    } catch (error) {
      if (!live()) return;

      if (socket === opened) socket = null;
      if (opened !== null) void opened.disconnect().catch(() => undefined);
      pushFor(era, { kind: 'failed', message: messageOf(error) });
    } finally {
      /* Never clear a *later* attempt's flag: this one may already be stale. */
      if (era === generation) opening = false;
    }
  };

  /**
   * A channel named after the socket came up (HIVE-124).
   *
   * The index is built once per connection, and `sync()` returns early while a
   * socket exists — so without this, adding `slack.channel:#new-room` to an
   * agent leaves `routeChannel` looking the name up in a stale index, finding
   * nothing, and dropping every message in that room in silence until the app
   * restarts. Costs one `conversations.list` only when a subscribed name is
   * actually missing, so the steady state is still zero API calls per wake.
   */
  const refreshChannels = (subs: SlackSubscriptions): void => {
    const index = nameToId;
    const client = web;
    if (index === null || client === null || refreshing) return;
    if (![...subs.channels.keys()].some((name) => !index.has(name))) return;

    refreshing = true;
    const era = generation;
    void (async () => {
      try {
        const channels = await client.listChannels();
        if (!isCurrent(era)) return;

        setChannelIndex(channels);
        repushUnresolved(era);
      } catch (error) {
        console.warn(
          `[hive] slack: could not refresh the channel index — ${messageOf(error)}`,
        );
      } finally {
        if (era === generation) refreshing = false;
      }
    })();
  };

  const teardown = (): void => {
    const open = socket;
    generation += 1;
    socket = null;
    web = null;
    opening = false;
    refreshing = false;
    nameToId = null;
    idToName = new Map();

    for (const timer of timers.values()) clearTimeoutFn(timer);
    timers.clear();
    buffers.clear();

    if (open !== null) void open.disconnect().catch(() => undefined);
  };

  const sync = (): void => {
    if (stopped) return;

    const { socketMode } = deps.config();
    const { appToken, botToken } = deps.tokens.read();
    const subs = deps.subscriptions();

    /*
      All three, every time. The switch is the user's intent, the tokens are
      what a socket can be opened *with*, and `needsSocket` is the ticket's
      criterion: the socket is held open only while some enabled agent is
      listening for what it carries.
    */
    if (
      !socketMode ||
      appToken === undefined ||
      botToken === undefined ||
      !needsSocket(subs)
    ) {
      teardown();
      push({ kind: 'off' });

      return;
    }

    if (socket !== null) {
      refreshChannels(subs);

      return;
    }
    if (opening) return;

    opening = true;
    push({ kind: 'connecting' });
    void connect(appToken, botToken);
  };

  const test = async (): Promise<SlackSocketTestResult> => {
    const { botToken } = deps.tokens.read();
    if (botToken === undefined) return { kind: 'error', message: NO_BOT_TOKEN };

    try {
      const { team, user } = await deps.openWeb(botToken).authTest();

      return { kind: 'ok', workspace: team, bot: user };
    } catch (error) {
      return { kind: 'error', message: messageOf(error) };
    }
  };

  return {
    sync,
    test,
    unresolved,
    stop: () => {
      stopped = true;
      teardown();
    },
  };
}
