// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HOOK_HEADER_SESSION,
  HOOK_HEADER_TOKEN,
  type HookStatusEvent,
} from '../../../../electron/shared/hook-contract';
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
  let cleared: string[];
  let url: string;

  beforeEach(async () => {
    events = [];
    cleared = [];
    receiver = createReceiver({
      onCleared: (entityId) => cleared.push(entityId),
      onEvent: (event) => events.push(event),
      // Every session exists except the one explicitly named as gone.
      knowsSession: (entityId) => entityId !== 'sess-gone',
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

  it.each([
    ['SessionStart', 'idle'],
    ['UserPromptSubmit', 'working'],
    ['PermissionRequest', 'waiting'],
    ['Elicitation', 'waiting'],
    ['Stop', 'idle'],
  ])('maps %s to %s', async (event, status) => {
    const response = await post({ hook_event_name: event, session_id: 'uuid' });
    expect(response.status).toBe(204);
    expect(events).toEqual([{ entityId: 'sess-01', event, status }]);
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
     */
    const response = await post({ hook_event_name: 'PostToolUse' });
    expect(response.status).toBe(204);
    expect(events).toEqual([]);
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
      knowsSession: () => true,
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
      knowsSession: () => true,
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
    const a = createReceiver({ onEvent: () => {}, onCleared: () => {}, knowsSession: () => true });
    const b = createReceiver({ onEvent: () => {}, onCleared: () => {}, knowsSession: () => true });
    expect(a.token).not.toBe(b.token);
    expect(a.token).toHaveLength(36);
  });

  it('has no url before it starts', () => {
    const receiver = createReceiver({ onEvent: () => {}, onCleared: () => {}, knowsSession: () => true });
    expect(receiver.url).toBeNull();
  });
});
