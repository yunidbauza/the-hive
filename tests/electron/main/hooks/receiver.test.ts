// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HOOK_HEADER_SESSION,
  HOOK_HEADER_TOKEN,
  type HookStatusEvent,
  type HookTicketIntentEvent,
} from '../../../../electron/shared/hook-contract';
import {
  METRICS_PATH,
  type SessionMetrics,
} from '../../../../electron/shared/metrics-contract';
import { createReceiver, type Receiver } from '../../../../electron/main/hooks/receiver';

/**
 * The receiver is exercised over a real loopback socket rather than by calling
 * its handler directly.
 *
 * The properties that matter here are HTTP-level — the method and path it
 * refuses, the header it authenticates on, the body size it declines to buffer —
 * and a direct call would assert the parts that were never in doubt while
 * skipping the ones that were.
 */
describe('hook receiver', () => {
  let receiver: Receiver;
  let events: HookStatusEvent[];
  let intents: HookTicketIntentEvent[];
  let cleared: string[];
  let dones: string[];
  let url: string;

  beforeEach(async () => {
    events = [];
    intents = [];
    cleared = [];
    dones = [];
    receiver = createReceiver({
      onCleared: (entityId) => cleared.push(entityId),
      onEvent: (event) => events.push(event),
      onTicketIntent: (event) => intents.push(event),
      onDone: (entityId) => dones.push(entityId),
      // Every session exists except the one explicitly named as gone.
      knowsSession: (entityId) => entityId !== 'sess-gone',
      onMetrics: () => {},
    });
    const started = await receiver.start();
    expect(started).not.toBeNull();
    url = started as string;
  });

  afterEach(async () => {
    await receiver.stop();
  });

  const post = (
    body: unknown,
    headers: Record<string, string> = {
      [HOOK_HEADER_TOKEN]: receiver.token,
      [HOOK_HEADER_SESSION]: 'sess-01',
    },
  ) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('binds loopback only', () => {
    expect(url.startsWith('http://127.0.0.1:')).toBe(true);
  });

  /**
   * The `/done` route (HIVE-93).
   *
   * Every test here is about **authority**, because that is all this route has
   * to get right: the request carries no payload, so the only questions are
   * whether it is from a session this app has and whether it holds the launch
   * token. What the app does afterwards — write `/exit`, record `done` — is
   * `sessions/index.test.ts`.
   */
  describe('/done', () => {
    const done = (
      headers: Record<string, string> = {
        [HOOK_HEADER_TOKEN]: receiver.token,
        [HOOK_HEADER_SESSION]: 'sess-01',
      },
      init: RequestInit = {},
    ) =>
      fetch(receiver.doneUrl as string, {
        method: 'POST',
        headers,
        ...init,
      });

    it('shares the socket with the hook route', () => {
      const origin = (raw: string) => new URL(raw).origin;
      expect(origin(receiver.doneUrl as string)).toBe(origin(url));
      expect(new URL(receiver.doneUrl as string).pathname).toBe('/done');
    });

    it('reports the session that declared itself finished', async () => {
      const response = await done();

      expect(response.status).toBe(204);
      expect(dones).toEqual(['sess-01']);
    });

    it('refuses a request without the launch token', async () => {
      const response = await done({
        [HOOK_HEADER_TOKEN]: 'not-the-token',
        [HOOK_HEADER_SESSION]: 'sess-01',
      });

      expect(response.status).toBe(403);
      expect(dones).toEqual([]);
    });

    it('refuses a session the app does not have', async () => {
      const response = await done({
        [HOOK_HEADER_TOKEN]: receiver.token,
        [HOOK_HEADER_SESSION]: 'sess-gone',
      });

      expect(response.status).toBe(404);
      expect(dones).toEqual([]);
    });

    it('refuses a request that names no session at all', async () => {
      const response = await done({ [HOOK_HEADER_TOKEN]: receiver.token });

      expect(response.status).toBe(400);
      expect(dones).toEqual([]);
    });

    it('is POST-only', async () => {
      const response = await fetch(receiver.doneUrl as string, { method: 'GET' });

      expect(response.status).toBe(404);
      expect(dones).toEqual([]);
    });

    it('drains a body rather than refusing one', async () => {
      /*
        The route expects none, so its cap is zero — but a caller that sends
        one anyway is answered normally. A red line in the user's terminal is
        never worth a payload nothing reads.
      */
      const response = await done(
        {
          [HOOK_HEADER_TOKEN]: receiver.token,
          [HOOK_HEADER_SESSION]: 'sess-01',
          'content-type': 'application/json',
        },
        { body: JSON.stringify({ summary: 'ignored entirely' }) },
      );

      expect(response.status).toBe(204);
      expect(dones).toEqual(['sess-01']);
    });
  });

  it.each([
    ['SessionStart', 'idle'],
    ['UserPromptSubmit', 'working'],
    ['PermissionRequest', 'waiting'],
    ['Elicitation', 'waiting'],
    ['PostToolUse', 'working'],
    ['Stop', 'idle'],
  ])('maps %s to %s', async (event, status) => {
    const response = await post({ hook_event_name: event, session_id: 'uuid' });
    expect(response.status).toBe(204);
    expect(events).toEqual([{ entityId: 'sess-01', event, status }]);
  });

  /**
   * Tool and agent identity (HIVE-83): the tracker that pairs a permission
   * request with the tool call that resolves it needs these carried through
   * whole, not cherry-picked away with the rest of the body.
   */
  describe('tool and agent identity', () => {
    it('forwards tool identity off a PostToolUse', async () => {
      const response = await post({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi', run_in_background: true },
        tool_use_id: 'toolu_01',
      });

      expect(response.status).toBe(204);
      expect(events[0]).toMatchObject({
        event: 'PostToolUse',
        toolName: 'Bash',
        toolUseId: 'toolu_01',
        runInBackground: true,
      });
    });

    it('forwards the agent id off a subagent event', async () => {
      const response = await post({
        hook_event_name: 'SubagentStart',
        agent_id: 'a828e337',
        agent_type: 'general-purpose',
      });

      expect(response.status).toBe(204);
      expect(events[0]).toMatchObject({ event: 'SubagentStart', agentId: 'a828e337' });
    });

    /**
     * A `Write` or `Edit` needing permission carries the whole file in
     * `tool_input`, which is exactly what pushes the body past
     * `HOOK_MAX_BODY_BYTES`. Measured against real Claude Code 2.1.238, the
     * wire order is `..., tool_name, tool_input, tool_use_id` — so
     * `tool_name` sits before the field that grows unbounded and survives
     * truncation, while `tool_use_id` sits after it and never does.
     */
    it('recovers tool_name from an oversized PermissionRequest, but not tool_use_id', async () => {
      const response = await post({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Write',
        tool_input: 'x'.repeat(256 * 1024),
        tool_use_id: 'toolu_01',
      });

      expect(response.status).toBe(204);
      expect(events).toEqual([
        {
          entityId: 'sess-01',
          event: 'PermissionRequest',
          status: 'waiting',
          toolName: 'Write',
        },
      ]);
    });
  });

  /**
   * `SessionEnd` and the `reason` gate.
   *
   * Only `clear` may be acted on. The others all mean the process is going
   * away, which the pty observes and reports as `terminated` — and acting on
   * them here is the exact bug this event was once withdrawn for: it locked the
   * user out of a live session by calling `/clear` a death.
   */
  it('reports a cleared session, and never as a status', async () => {
    const response = await post({
      hook_event_name: 'SessionEnd',
      reason: 'clear',
      session_id: 'uuid',
    });

    expect(response.status).toBe(204);
    expect(cleared).toEqual(['sess-01']);
    // Crucially not a status — `terminated` here is what broke it before.
    expect(events).toEqual([]);
  });

  it.each(['prompt_input_exit', 'logout', 'other'])(
    'ignores SessionEnd with reason %s — the pty owns that verdict',
    async (reason) => {
      const response = await post({
        hook_event_name: 'SessionEnd',
        reason,
        session_id: 'uuid',
      });

      expect(response.status).toBe(204);
      expect(cleared).toEqual([]);
      expect(events).toEqual([]);
    },
  );

  it('ignores a SessionEnd with no reason at all', async () => {
    const response = await post({ hook_event_name: 'SessionEnd' });

    expect(response.status).toBe(204);
    expect(cleared).toEqual([]);
  });

  it('does not report a cleared session the app has never heard of', async () => {
    const response = await post(
      { hook_event_name: 'SessionEnd', reason: 'clear' },
      { [HOOK_HEADER_TOKEN]: receiver.token, [HOOK_HEADER_SESSION]: 'sess-gone' },
    );

    expect(response.status).toBe(404);
    expect(cleared).toEqual([]);
  });

  it('rejects a request with no token', async () => {
    const response = await post(
      { hook_event_name: 'Stop' },
      { [HOOK_HEADER_SESSION]: 'sess-01' },
    );
    expect(response.status).toBe(403);
    expect(events).toEqual([]);
  });

  it('rejects a request with the wrong token', async () => {
    const response = await post(
      { hook_event_name: 'Stop' },
      { [HOOK_HEADER_TOKEN]: 'not-the-token', [HOOK_HEADER_SESSION]: 'sess-01' },
    );
    expect(response.status).toBe(403);
    expect(events).toEqual([]);
  });

  it('rejects a request naming no session', async () => {
    const response = await post(
      { hook_event_name: 'Stop' },
      { [HOOK_HEADER_TOKEN]: receiver.token },
    );
    expect(response.status).toBe(400);
    expect(events).toEqual([]);
  });

  it('refuses a session the app does not have', async () => {
    /**
     * A hook for an exited session must not create state for it — that is how a
     * long-running app accumulates one entry per stale session forever.
     */
    const response = await post(
      { hook_event_name: 'Stop' },
      { [HOOK_HEADER_TOKEN]: receiver.token, [HOOK_HEADER_SESSION]: 'sess-gone' },
    );
    expect(response.status).toBe(404);
    expect(events).toEqual([]);
  });

  it('accepts an unsubscribed event without acting on it', async () => {
    /**
     * 204 rather than 4xx: Claude may deliver more than was asked for, and a
     * failing hook prints an error in the user's session for something the app
     * simply does not care about.
     *
     * `PreCompact` rather than `PreToolUse` (HIVE-83): the latter is now
     * subscribed too — see the bookkeeping pair in `HOOK_EVENTS`.
     */
    const response = await post({ hook_event_name: 'PreCompact' });
    expect(response.status).toBe(204);
    expect(events).toEqual([]);
  });

  /**
   * The `Notification` hook — the only event whose status is not a
   * property of the event.
   *
   * Measured against Claude Code 2.1.227 in a real pty: `idle_prompt` sixty
   * seconds after a turn ended with nothing typed, `permission_prompt` about
   * six seconds after a permission prompt appears. Both mean the session is
   * blocked on a human; what they mean for the *inbox* is decided downstream.
   */
  describe('the Notification hook', () => {
    /**
     * HIVE-81: the two types no longer share a status. `permission_prompt` is a
     * session blocked on a human; `idle_prompt` fires a minute after the turn
     * already ended, and `idle` is what the session already was.
     */
    it.each([
      ['idle_prompt', 'idle'],
      ['permission_prompt', 'waiting'],
    ])(
      'maps %s to %s, carrying the type through',
      async (notificationType, status) => {
        const response = await post({
          hook_event_name: 'Notification',
          notification_type: notificationType,
          message: 'Claude is waiting for your input',
        });

        expect(response.status).toBe(204);
        expect(events).toEqual([
          {
            entityId: 'sess-01',
            event: 'Notification',
            status,
            notificationType,
          },
        ]);
      },
    );

    /**
     * Claude raises notifications this build has no reading of. Moving a
     * session to `waiting` on one would put a dot on the rail that no amount of
     * looking at the terminal explains — and a 4xx would print a hook failure
     * in the user's session for something the app simply does not care about.
     */
    it('publishes nothing for a type it does not know, and still answers 204', async () => {
      const response = await post({
        hook_event_name: 'Notification',
        notification_type: 'something_new',
      });

      expect(response.status).toBe(204);
      expect(events).toEqual([]);
    });

    it('publishes nothing for a Notification carrying no type', async () => {
      const response = await post({ hook_event_name: 'Notification' });

      expect(response.status).toBe(204);
      expect(events).toEqual([]);
    });

    /**
     * A `Notification` payload carries the prose Claude would have shown, which
     * is unbounded — so the type has to survive the same truncation the event
     * name does, or the biggest ones would silently stop reporting.
     */
    it('reads the type out of an oversized body', async () => {
      const response = await post({
        hook_event_name: 'Notification',
        notification_type: 'idle_prompt',
        message: 'x'.repeat(256 * 1024),
      });

      expect(response.status).toBe(204);
      expect(events).toEqual([
        {
          entityId: 'sess-01',
          event: 'Notification',
          status: 'idle',
          notificationType: 'idle_prompt',
        },
      ]);
    });

    it('carries the cwd along, as every other event does', async () => {
      await post({
        hook_event_name: 'Notification',
        notification_type: 'idle_prompt',
        cwd: '/repos/apfm-web',
      });

      expect(events[0].cwd).toBe('/repos/apfm-web');
    });
  });

  it('rejects a malformed body', async () => {
    const response = await post('not json at all');
    expect(response.status).toBe(400);
    expect(events).toEqual([]);
  });

  it('still acts on an oversized body instead of rejecting it', async () => {
    /**
     * The biggest payloads belong to `PermissionRequest`, whose `tool_input`
     * for a Write or an Edit is a whole file — so refusing them with 413 meant
     * a large edit never raised `waiting`, the one state the attention model
     * exists for. The body is drained past the cap; only the prefix is kept,
     * and `hook_event_name` lives there.
     */
    const response = await post({
      hook_event_name: 'PermissionRequest',
      tool_input: 'x'.repeat(256 * 1024),
    });

    expect(response.status).toBe(204);
    expect(events).toEqual([
      { entityId: 'sess-01', event: 'PermissionRequest', status: 'waiting' },
    ]);
  });

  it('ignores an oversized body whose event name is past the cap', async () => {
    // Nothing to act on, and still not an error the user's session must show.
    const response = await post({
      tool_input: 'x'.repeat(256 * 1024),
      hook_event_name: 'Stop',
    });

    expect(response.status).toBe(204);
    expect(events).toEqual([]);
  });

  /**
   * The `cwd` half of HIVE-78.
   *
   * `docs/branch-sync-note.md` listed "the session's live working directory" as
   * the first thing main did not have, and proposed inspecting the shell
   * process with `lsof` to get it. These tests record that it was already in
   * the payload — and that it is the *agent's* cwd, so it follows a session
   * into a worktree.
   */
  describe('cwd', () => {
    it('carries the working directory out with the status', async () => {
      const response = await post({
        hook_event_name: 'Stop',
        cwd: '/repo/.claude/worktrees/incorp-332',
      });

      expect(response.status).toBe(204);
      expect(events).toEqual([
        {
          entityId: 'sess-01',
          event: 'Stop',
          status: 'idle',
          cwd: '/repo/.claude/worktrees/incorp-332',
        },
      ]);
    });

    it.each([
      ['absent', {}],
      ['empty', { cwd: '' }],
      ['not a string', { cwd: 42 }],
    ])('omits the field when the payload carries none (%s)', async (_label, extra) => {
      // Absent rather than empty: the session layer reads absence as "nothing
      // to look at on this tick", and an empty string would be a directory.
      const response = await post({ hook_event_name: 'Stop', ...extra });

      expect(response.status).toBe(204);
      expect(events).toEqual([
        { entityId: 'sess-01', event: 'Stop', status: 'idle' },
      ]);
    });

    it('recovers the directory from an oversized body', async () => {
      // Same prefix trick the event name already relies on: a
      // `PermissionRequest` carrying a whole file is exactly the event that
      // produces `waiting`, and it must still say where it happened.
      const response = await post({
        hook_event_name: 'PermissionRequest',
        cwd: '/repo/worktree',
        tool_input: 'x'.repeat(256 * 1024),
      });

      expect(response.status).toBe(204);
      expect(events).toEqual([
        {
          entityId: 'sess-01',
          event: 'PermissionRequest',
          status: 'waiting',
          cwd: '/repo/worktree',
        },
      ]);
    });
  });

  describe('ticket intent', () => {
    it('reports a key the prompt claimed, before the status', async () => {
      /**
       * Ordering is asserted, not incidental: `onEvent` is what makes the
       * session `working`, and a renderer that learned the ticket second would
       * render the row under its old name for a frame — a visible flicker, on
       * exactly the frame the user pressed enter.
       */
      const order: string[] = [];
      const ordered = createReceiver({
        onCleared: () => {},
        onEvent: () => order.push('status'),
        onTicketIntent: () => order.push('intent'),
        onDone: () => {},
        knowsSession: () => true,
        onMetrics: () => {},
      });
      const started = (await ordered.start()) as string;

      await fetch(started, {
        method: 'POST',
        headers: {
          [HOOK_HEADER_TOKEN]: ordered.token,
          [HOOK_HEADER_SESSION]: 'sess-01',
        },
        body: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          prompt: 'work on ABC-123',
        }),
      });

      expect(order).toEqual(['intent', 'status']);
      await ordered.stop();
    });

    it('carries the key and nothing else', async () => {
      // The prompt never travels. The receiver exists to keep a status dot
      // honest, not to forward what the user typed.
      const response = await post({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'work on the ticket ABC-123 please',
      });

      expect(response.status).toBe(204);
      expect(intents).toEqual([{ entityId: 'sess-01', key: 'ABC-123' }]);
    });

    it('says nothing when the prompt only mentions a ticket', async () => {
      await post({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'the PR for ABC-123 broke CI',
      });

      expect(intents).toEqual([]);
    });

    it('ignores prompts on every other event', async () => {
      // Only `UserPromptSubmit` carries something the user just said. A
      // `prompt` field on any other event is not a fresh statement of intent.
      await post({ hook_event_name: 'Stop', prompt: 'work on ABC-123' });

      expect(intents).toEqual([]);
    });

    it('does not scan a truncated body', async () => {
      /**
       * A truncated body means the payload exceeded 64 KB — a paste, which is
       * the worst input for a shape test and the least likely to be "work on
       * ABC-123". The status still lands; only the intent is skipped.
       */
      const response = await post({
        hook_event_name: 'UserPromptSubmit',
        prompt: `work on ABC-123 ${'x'.repeat(256 * 1024)}`,
      });

      expect(response.status).toBe(204);
      expect(intents).toEqual([]);
      expect(events).toHaveLength(1);
    });

    it('reports nothing for a session the app does not have', async () => {
      const response = await post(
        { hook_event_name: 'UserPromptSubmit', prompt: 'work on ABC-123' },
        { [HOOK_HEADER_TOKEN]: receiver.token, [HOOK_HEADER_SESSION]: 'sess-gone' },
      );

      expect(response.status).toBe(404);
      expect(intents).toEqual([]);
    });
  });

  it('serves only its own path and method', async () => {
    expect((await fetch(url.replace('/hook', '/'), { method: 'POST' })).status).toBe(404);
    expect((await fetch(url, { method: 'GET' })).status).toBe(404);
    expect(events).toEqual([]);
  });

  it('answers nothing once stopped', async () => {
    await receiver.stop();
    await expect(post({ hook_event_name: 'Stop' })).rejects.toThrow();
  });

  it('reports a bind failure as null rather than throwing', async () => {
    /**
     * The contract the whole design leans on: a receiver that cannot bind must
     * degrade status, never break a spawn. Port 1 is privileged, so binding it
     * as an ordinary user fails.
     */
    const doomed = createReceiver({
    onCleared: () => {},
      onEvent: () => {},
      onTicketIntent: () => {},
      onDone: () => {},
      knowsSession: () => true,
      onMetrics: () => {},
      port: 1,
    });
    await expect(doomed.start()).resolves.toBeNull();
    await doomed.stop();
  });

  it('survives a throwing listener without taking the process down', async () => {
    const exploding = createReceiver({
    onCleared: () => {},
      onEvent: () => {
        throw new Error('listener blew up');
      },
      onTicketIntent: () => {},
      onDone: () => {},
      knowsSession: () => true,
      onMetrics: () => {},
    });
    const started = await exploding.start();
    const response = await fetch(started as string, {
      method: 'POST',
      headers: {
        [HOOK_HEADER_TOKEN]: exploding.token,
        [HOOK_HEADER_SESSION]: 'sess-01',
      },
      body: JSON.stringify({ hook_event_name: 'Stop' }),
    });
    expect(response.status).toBe(500);
    await exploding.stop();
  });
});

describe('hook receiver tokens', () => {
  it('gives each receiver a distinct token', () => {
    const a = createReceiver({ onEvent: () => {}, onCleared: () => {}, onTicketIntent: () => {}, onMetrics: () => {}, onDone: () => {}, knowsSession: () => true });
    const b = createReceiver({ onEvent: () => {}, onCleared: () => {}, onTicketIntent: () => {}, onMetrics: () => {}, onDone: () => {}, knowsSession: () => true });
    expect(a.token).not.toBe(b.token);
    expect(a.token).toHaveLength(36);
  });

  it('has no url before it starts', () => {
    const receiver = createReceiver({ onEvent: () => {}, onCleared: () => {}, onTicketIntent: () => {}, onMetrics: () => {}, onDone: () => {}, knowsSession: () => true });
    expect(receiver.url).toBeNull();
  });
});


/**
 * The status line path (HIVE-79).
 *
 * Same socket, same token, same session header — a different body shape and a
 * much smaller cap. These assertions are mostly about the ways it must *refuse*,
 * because it is a second door on a socket the receiver's own header argues hard
 * for the safety of.
 */
describe('the status line path', () => {
  let receiver: Receiver;
  let metrics: { entityId: string; reported: SessionMetrics }[];
  let url: string;

  beforeEach(async () => {
    metrics = [];
    receiver = createReceiver({
      onEvent: () => {},
      onCleared: () => {},
      onTicketIntent: () => {},
      onMetrics: (entityId, reported) => metrics.push({ entityId, reported }),
      onDone: () => {},
      knowsSession: (entityId) => entityId !== 'sess-gone',
    });
    const started = await receiver.start();
    expect(started).not.toBeNull();
    url = receiver.metricsUrl as string;
  });

  afterEach(async () => {
    await receiver.stop();
  });

  const post = (
    body: unknown,
    headers: Record<string, string> = {
      [HOOK_HEADER_TOKEN]: receiver.token,
      [HOOK_HEADER_SESSION]: 'sess-01',
    },
  ) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('is a second path on the same socket', () => {
    expect(url.startsWith('http://127.0.0.1:')).toBe(true);
    expect(url.endsWith(METRICS_PATH)).toBe(true);
  });

  it('is null before a successful bind', () => {
    const unbound = createReceiver({
      onEvent: () => {},
      onCleared: () => {},
      onTicketIntent: () => {},
      onMetrics: () => {},
      onDone: () => {},
      knowsSession: () => true,
    });
    expect(unbound.metricsUrl).toBeNull();
  });

  it('records what a session reported', async () => {
    const response = await post({
      model: { display_name: 'Opus 4.5' },
      context_window: { used_percentage: 46, context_window_size: 1000000 },
      rate_limits: {
        five_hour: { used_percentage: 12, resets_at: 1786000000 },
        seven_day: { used_percentage: 63, resets_at: 1786200000 },
      },
    });

    expect(response.status).toBe(204);
    expect(metrics).toEqual([
      {
        entityId: 'sess-01',
        reported: {
          model: 'Opus 4.5',
          contextPct: 46,
          contextWindow: 1000000,
          fiveHourPct: 12,
          fiveHourResetsAt: 1786000000,
          sevenDayPct: 63,
          sevenDayResetsAt: 1786200000,
        },
      },
    ]);
  });

  it('rejects a request with the wrong token, exactly as the hook path does', async () => {
    const response = await post(
      {},
      { [HOOK_HEADER_TOKEN]: 'not-the-token', [HOOK_HEADER_SESSION]: 'sess-01' },
    );

    expect(response.status).toBe(403);
    expect(metrics).toEqual([]);
  });

  it('rejects a request naming no session', async () => {
    const response = await post({}, { [HOOK_HEADER_TOKEN]: receiver.token });

    expect(response.status).toBe(400);
    expect(metrics).toEqual([]);
  });

  it('refuses a session the app does not have', async () => {
    const response = await post(
      {},
      { [HOOK_HEADER_TOKEN]: receiver.token, [HOOK_HEADER_SESSION]: 'sess-gone' },
    );

    expect(response.status).toBe(404);
    expect(metrics).toEqual([]);
  });

  it('answers 400 for a body that is not an object', async () => {
    expect((await post('{ not json')).status).toBe(400);
    expect(metrics).toEqual([]);
  });

  /**
   * A status line payload is a fixed set of scalars. Anything approaching the
   * cap is not the document this endpoint is for — answered 204 rather than 413
   * for the reason the hook path drains rather than refuses: the reply is
   * visible in the user's terminal.
   */
  it('drops an oversized body without acting on it, and still answers 204', async () => {
    const response = await post({ padding: 'x'.repeat(32 * 1024) });

    expect(response.status).toBe(204);
    expect(metrics).toEqual([]);
  });

  it('answers 404 on the metrics path for a method other than POST', async () => {
    expect((await fetch(url, { method: 'GET' })).status).toBe(404);
  });
});
