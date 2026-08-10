import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  createNotificationHub,
  type NotificationHub,
} from '../../../../electron/main/notifications/hub';
import {
  NOTIFICATION_CAP,
  type HiveNotification,
  type NotificationAction,
  type NotificationPrefs,
} from '../../../../electron/shared/notification-contract';

type PresentOptions = { title: string; body: string; onClick: () => void };

let prefs: NotificationPrefs;
let present: Mock<(options: PresentOptions) => void>;
let broadcast: Mock<(notification: HiveNotification) => void>;
let activate: Mock<(action: NotificationAction) => void>;
let announceRead: Mock<(id: string | null) => void>;

let now: number;
let hub: NotificationHub;

beforeEach(() => {
  prefs = {};
  present = vi.fn();
  broadcast = vi.fn();
  activate = vi.fn();
  announceRead = vi.fn();
  now = 1_700_000_000_000;

  hub = createNotificationHub({
    prefs: () => prefs,
    present: (options) => present(options),
    broadcast: (notification) => broadcast(notification),
    activate: (action) => activate(action),
    announceRead: (id) => announceRead(id),
    now: () => now,
  });
});

const raise = (over: Partial<Parameters<NotificationHub['raise']>[0]> = {}) =>
  hub.raise({ kind: 'session.waiting', title: 'blocked', ...over });

describe('delivery', () => {
  /** `both` is the default for a blocking kind, so this is the unconfigured path. */
  it('broadcasts and presents when the kind says both', () => {
    raise();

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledTimes(1);
  });

  it('broadcasts without presenting when the kind says inbox', () => {
    prefs = { 'session.waiting': 'inbox' };
    raise();

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(present).not.toHaveBeenCalled();
  });

  it('does neither when the kind is off', () => {
    prefs = { 'session.waiting': 'off' };

    expect(raise()).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
    expect(present).not.toHaveBeenCalled();
  });

  /**
   * The preference is read per event, never captured — otherwise a save made
   * while the app runs would not take effect until the next launch.
   */
  it('reads the preference at the moment of the event', () => {
    raise();
    prefs = { 'session.waiting': 'off' };
    raise({ id: 'second' });

    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});

describe('identity', () => {
  it('raises a given id exactly once', () => {
    expect(raise({ id: 'pr-219-approved' })).not.toBeNull();
    expect(raise({ id: 'pr-219-approved' })).toBeNull();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  /** Two idle events are two events, not a repeat — so an absent id is unique. */
  it('mints a distinct id when a producer brings none', () => {
    const first = raise();
    const second = raise();

    expect(first?.id).not.toBe(second?.id);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  /**
   * Dedup has to outlive eviction: a poller can push a transition out of the
   * buffer and then see it again, and that is still not news.
   */
  it('still refuses a duplicate after the buffer has evicted it', () => {
    raise({ id: 'first' });
    for (let i = 0; i < NOTIFICATION_CAP + 5; i += 1) raise({ id: `fill-${i}` });

    expect(hub.list().some((n) => n.id === 'first')).toBe(false);
    expect(raise({ id: 'first' })).toBeNull();
  });
});

describe('the buffer', () => {
  it('holds the newest first', () => {
    raise({ id: 'a', title: 'first' });
    raise({ id: 'b', title: 'second' });

    expect(hub.list().map((n) => n.title)).toEqual(['second', 'first']);
  });

  it('caps at NOTIFICATION_CAP', () => {
    for (let i = 0; i < NOTIFICATION_CAP + 10; i += 1) raise({ id: `n${i}` });
    expect(hub.list()).toHaveLength(NOTIFICATION_CAP);
  });

  it('marks one read by id, and all of them for null', () => {
    raise({ id: 'a' });
    raise({ id: 'b' });

    hub.markRead('a');
    expect(hub.list().find((n) => n.id === 'a')?.unread).toBe(false);
    expect(hub.list().find((n) => n.id === 'b')?.unread).toBe(true);

    hub.markRead(null);
    expect(hub.list().every((n) => !n.unread)).toBe(true);
  });

  it('stamps createdAt from the clock, and defaults the rest', () => {
    const raised = raise({ id: 'a' }) as HiveNotification;

    expect(raised.createdAt).toBe(now);
    expect(raised.body).toBe('');
    expect(raised.action).toEqual({ type: 'none' });
    expect(raised.unread).toBe(true);
  });
});

describe('presentation', () => {
  it('marks read and activates when the toast is clicked', () => {
    raise({ id: 'a', action: { type: 'session', entityId: 'lead-form' } });

    const { onClick } = present.mock.calls[0][0];
    onClick();

    expect(activate).toHaveBeenCalledWith({
      type: 'session',
      entityId: 'lead-form',
    });
    expect(hub.list()[0].unread).toBe(false);
  });
});

describe('read-state reaches the renderer', () => {
  /**
   * The regression: main marked the toast read in its own buffer and told
   * nobody, so the inbox row stayed filled and the badge went on counting a
   * notification the user had already dealt with — until a reload silently
   * corrected it.
   */
  it('announces a toast click, which the renderer cannot otherwise observe', () => {
    raise({ id: 'a' });
    announceRead.mockClear();

    present.mock.calls[0][0].onClick();

    expect(announceRead).toHaveBeenCalledWith('a');
  });

  it('announces a mark-all', () => {
    raise({ id: 'a' });
    announceRead.mockClear();

    hub.markRead(null);

    expect(announceRead).toHaveBeenCalledWith(null);
  });
});

describe('robustness', () => {
  /**
   * The regression: `raise` used to reach its own `markRead` through `this`, so
   * a destructured call bound it to `undefined`.
   *
   * The raise itself still looked fine — `this` is only dereferenced in the
   * click handler — so the assertions that matter are the last two. Clicking
   * the toast threw a TypeError inside an Electron event handler in main, well
   * after `raise`'s try/catch had unwound.
   */
  it('works when raise is called detached from the hub', () => {
    const { raise: detached } = hub;

    const raised = detached({
      kind: 'session.waiting',
      title: 'blocked',
      id: 'detached',
    });

    expect(raised).not.toBeNull();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledTimes(1);

    // And the toast's click still marks it read.
    present.mock.calls[0][0].onClick();
    expect(hub.list()[0].unread).toBe(false);
  });

  /**
   * The hub sits inside the broadcast every session's output depends on. A
   * notification that failed must cost a notification, never a `pty:data`.
   */
  it('never throws, whatever a collaborator does', () => {
    hub = createNotificationHub({
      prefs: () => {
        throw new Error('config exploded');
      },
      present: (options) => present(options),
      broadcast: (notification) => broadcast(notification),
      activate: (action) => activate(action),
      announceRead: (id) => announceRead(id),
      now: () => now,
    });

    expect(() => raise()).not.toThrow();
    expect(raise()).toBeNull();
  });

  it('drops a kind it does not know rather than inventing a delivery', () => {
    expect(
      hub.raise({
        // A kind from a newer build, arriving through an untyped edge.
        kind: 'slack.mention' as never,
        title: 'mention',
      }),
    ).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
