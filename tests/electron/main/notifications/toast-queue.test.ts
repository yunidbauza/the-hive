// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  NotificationKind,
  ToastPayload,
} from '../../../../electron/shared/notification-contract';
import {
  createToastQueue,
  TOAST_QUEUE_KINDS,
  type ToastQueue,
} from '../../../../electron/main/notifications/toast-queue';

/**
 * Toasts held while nobody was looking (HIVE-145).
 *
 * Not a notification queue — no row is ever lost by not queueing, because the
 * hub's buffer outlives every surface and the attach snapshot carries it. What
 * is held is the interruption, and the whole design question is how much of it
 * is still worth raising when somebody finally arrives.
 */

const toast = (over: Partial<ToastPayload> = {}): ToastPayload => ({
  id: 'n1',
  kind: 'session.blocked',
  title: 'hero is blocked',
  body: 'waiting on you',
  action: { type: 'session', entityId: 'hero' },
  ...over,
});

let clock: number;
let queue: ToastQueue;

beforeEach(() => {
  clock = 1_000_000;
  queue = createToastQueue({ now: () => clock, cap: 3, ttlMs: 1_000 });
});

describe('createToastQueue', () => {
  it('holds a kind a person must answer', () => {
    queue.push(toast());

    expect(queue.flush()).toEqual([toast()]);
  });

  it('empties on flush, so an interruption is raised once', () => {
    queue.push(toast());
    queue.flush();

    expect(queue.flush()).toEqual([]);
  });

  describe('the kinds it will not hold', () => {
    it.each(['pr.merged', 'agent.done', 'agent.failed', 'app.update_ready'] as NotificationKind[])(
      'drops %s',
      (kind) => {
        queue.push(toast({ kind, action: { type: 'none' } }));

        expect(queue.size()).toBe(0);
      },
    );

    it('holds every kind it says it holds', () => {
      for (const [index, kind] of TOAST_QUEUE_KINDS.entries()) {
        queue.push(toast({ id: `n${String(index)}`, kind, action: { type: 'none' } }));
      }

      expect(queue.size()).toBe(Math.min(TOAST_QUEUE_KINDS.length, 3));
    });

    /**
     * A failed agent run matters a great deal and is deliberately absent:
     * nothing is blocked on the user reading it in the next few seconds, and
     * the inbox row says it just as well. The property is "stopped and waiting
     * for a human", not "important".
     */
    it('does not hold agent.failed, which is a record rather than a question', () => {
      queue.push(toast({ kind: 'agent.failed', action: { type: 'agent', name: 'scout' } }));

      expect(queue.flush()).toEqual([]);
    });
  });

  describe('the bounds', () => {
    it('drops the oldest past the cap', () => {
      for (let i = 0; i < 5; i += 1) {
        queue.push(toast({ id: `n${String(i)}`, action: { type: 'session', entityId: `s${String(i)}` } }));
      }

      expect(queue.flush().map((held) => held.id)).toEqual(['n2', 'n3', 'n4']);
    });

    it('drops an entry older than the TTL at flush', () => {
      queue.push(toast({ id: 'stale' }));
      clock += 1_001;
      queue.push(toast({ id: 'fresh', action: { type: 'session', entityId: 'other' } }));

      expect(queue.flush().map((held) => held.id)).toEqual(['fresh']);
    });

    it('keeps an entry exactly at the TTL boundary', () => {
      queue.push(toast());
      clock += 1_000;

      expect(queue.flush()).toHaveLength(1);
    });

    it('coalesces to the newest per session', () => {
      queue.push(toast({ id: 'first', body: 'older' }));
      queue.push(toast({ id: 'second', body: 'newer' }));

      /*
        One busy session asking four times is one thing to look at. The newest
        wins because it is the one whose words are still true.
      */
      expect(queue.flush()).toEqual([toast({ id: 'second', body: 'newer' })]);
    });

    it('coalesces an ask by its thread', () => {
      queue.push(toast({ id: 'a', kind: 'agent.ask', action: { type: 'ask', thread: 't1' } }));
      queue.push(toast({ id: 'b', kind: 'agent.ask', action: { type: 'ask', thread: 't1' } }));

      expect(queue.flush().map((held) => held.id)).toEqual(['b']);
    });

    it('keeps two different sessions apart', () => {
      queue.push(toast({ id: 'a', action: { type: 'session', entityId: 'one' } }));
      queue.push(toast({ id: 'b', action: { type: 'session', entityId: 'two' } }));

      expect(queue.flush()).toHaveLength(2);
    });

    it('coalesces nothing when the action names no subject', () => {
      queue.push(toast({ id: 'a', action: { type: 'none' } }));
      queue.push(toast({ id: 'b', action: { type: 'none' } }));

      expect(queue.flush()).toHaveLength(2);
    });

    it('a re-pushed subject becomes the newest, not the oldest', () => {
      queue.push(toast({ id: 'a', action: { type: 'session', entityId: 'one' } }));
      queue.push(toast({ id: 'b', action: { type: 'session', entityId: 'two' } }));
      queue.push(toast({ id: 'a2', action: { type: 'session', entityId: 'one' } }));
      queue.push(toast({ id: 'c', action: { type: 'session', entityId: 'three' } }));
      queue.push(toast({ id: 'd', action: { type: 'session', entityId: 'four' } }));

      // The cap is three; `two` was the genuinely oldest by then.
      expect(queue.flush().map((held) => held.id)).toEqual(['a2', 'c', 'd']);
    });
  });

  it('clears without raising anything', () => {
    queue.push(toast());
    queue.clear();

    expect(queue.flush()).toEqual([]);
  });
});
