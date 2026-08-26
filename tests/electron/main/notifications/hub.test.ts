import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  createNotificationHub,
  type NotificationHub,
  type NotificationHubOptions,
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
let announceRead: Mock<(id: string | null, unread: boolean) => void>;
let announceUnread: Mock<(count: number) => void>;
let announceDismissed: Mock<(id: string | null) => void>;

let now: number;
let hub: NotificationHub;

beforeEach(() => {
  prefs = {};
  present = vi.fn();
  broadcast = vi.fn();
  activate = vi.fn();
  announceRead = vi.fn();
  announceUnread = vi.fn();
  announceDismissed = vi.fn();
  now = 1_700_000_000_000;

  hub = createNotificationHub({
    prefs: () => prefs,
    present: (options) => present(options),
    broadcast: (notification) => broadcast(notification),
    activate: (action) => activate(action),
    announceRead: (id, unread) => announceRead(id, unread),
    announceUnread: (count) => announceUnread(count),
    announceDismissed: (id) => announceDismissed(id),
    now: () => now,
  });
});

/**
 * A hub built from the shared collaborators above, with room to override or
 * add options per test — chiefly `present`, `announceUnread` and, for
 * HIVE-81, `isForeground`.
 */
const makeHub = (overrides: Partial<NotificationHubOptions> = {}): NotificationHub =>
  createNotificationHub({
    prefs: () => prefs,
    present: (options) => present(options),
    broadcast: (notification) => broadcast(notification),
    activate: (action) => activate(action),
    announceRead: (id, unread) => announceRead(id, unread),
    announceUnread: (count) => announceUnread(count),
    announceDismissed: (id) => announceDismissed(id),
    now: () => now,
    ...overrides,
  });

/** The most recent count pushed at the dock badge. */
const lastUnread = (): number | undefined =>
  announceUnread.mock.calls.at(-1)?.[0];

const raise = (over: Partial<Parameters<NotificationHub['raise']>[0]> = {}) =>
  hub.raise({ kind: 'session.blocked', title: 'blocked', ...over });

describe('delivery', () => {
  /** `both` is the default for a blocking kind, so this is the unconfigured path. */
  it('broadcasts and presents when the kind says both', () => {
    raise();

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledTimes(1);
  });

  it('broadcasts without presenting when the kind says inbox', () => {
    prefs = { 'session.blocked': 'inbox' };
    raise();

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(present).not.toHaveBeenCalled();
  });

  it('does neither when the kind is off', () => {
    prefs = { 'session.blocked': 'off' };

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
    prefs = { 'session.blocked': 'off' };
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

  /**
   * Dismissal (HIVE-93) — the half that has to happen in main.
   *
   * `list()` is what a mounting renderer hydrates from, so this is the assertion
   * that makes a dismissal outlive a reload. Dropping the row in the renderer
   * alone would look right until the next hydration handed it straight back.
   */
  describe('dismiss', () => {
    it('takes the row out of list() for good, leaving the others', () => {
      raise({ id: 'a' });
      raise({ id: 'b' });

      hub.dismiss('a');

      expect(hub.list().map((n) => n.id)).toEqual(['b']);
    });

    it('stops counting a dismissed row that was still unread', () => {
      raise({ id: 'a' });
      raise({ id: 'b' });
      expect(lastUnread()).toBe(2);

      hub.dismiss('a');

      // The badge is a derivation of the buffer, so nothing else recomputes it.
      expect(lastUnread()).toBe(1);
    });

    it('does not re-raise a dismissed notification on a duplicate event', () => {
      /**
       * The id stays in the dedup set on purpose. Forgetting it there would let
       * the very next duplicate event resurrect the row the user just dismissed,
       * which is the one outcome that would make the gesture feel broken.
       */
      raise({ id: 'a' });
      hub.dismiss('a');

      expect(raise({ id: 'a' })).toBeNull();
      expect(hub.list()).toEqual([]);
    });

    it('is a no-op for an id it does not hold', () => {
      // Reachable: the renderer may act on a row the cap has since trimmed.
      raise({ id: 'a' });
      announceUnread.mockClear();

      hub.dismiss('nope');

      expect(hub.list().map((n) => n.id)).toEqual(['a']);
      // No spurious badge announcement for a buffer that did not change.
      expect(announceUnread).not.toHaveBeenCalled();
    });
  });

  /**
   * The Inbox's Clear all, and a separate verb from `dismiss` on purpose: the
   * id guard on that one exists so a caller who loses an argument cannot empty
   * the inbox, and widening it to accept `null` would have traded that
   * guarantee away. See `CH.notificationsClear`.
   */
  describe('clear', () => {
    it('empties list() and zeroes the badge', () => {
      raise({ id: 'a' });
      raise({ id: 'b' });
      raise({ id: 'c' });
      expect(lastUnread()).toBe(3);

      hub.clearInbox();

      expect(hub.list()).toEqual([]);
      expect(lastUnread()).toBe(0);
    });

    it('announces once, with a null id, rather than once per row', () => {
      raise({ id: 'a' });
      raise({ id: 'b' });
      announceDismissed.mockClear();

      hub.clearInbox();

      // N events would be N re-renders of a list that is about to be empty.
      expect(announceDismissed).toHaveBeenCalledTimes(1);
      expect(announceDismissed).toHaveBeenCalledWith(null);
    });

    it('keeps every id in the dedup set', () => {
      raise({ id: 'a' });
      raise({ id: 'b' });

      hub.clearInbox();

      // Clearing the inbox must not re-arm every notification in it to be
      // raised again by the next duplicate event — the same rule as `dismiss`.
      expect(raise({ id: 'a' })).toBeNull();
      expect(raise({ id: 'b' })).toBeNull();
      expect(hub.list()).toEqual([]);
    });

    it('says nothing when the buffer is already empty', () => {
      announceDismissed.mockClear();
      announceUnread.mockClear();

      hub.clearInbox();

      // A double-click on Clear all must not push a second event at every
      // window.
      expect(announceDismissed).not.toHaveBeenCalled();
      expect(announceUnread).not.toHaveBeenCalled();
    });
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
  /**
   * HIVE-81: clicking the desktop toast now dismisses, not merely marks
   * read. The user was in another application, chose this notification over
   * what they were doing, and it took them straight to the session — there
   * is nothing left for the row to tell them.
   */
  it('drops the row when the desktop toast is clicked', () => {
    const present = vi.fn();
    const announceDismissed = vi.fn();
    const hub = makeHub({ present, announceDismissed });

    const raised = hub.raise({
      kind: 'session.blocked',
      title: 't',
      action: { type: 'session', entityId: 'term-9' },
    })!;
    const { onClick } = present.mock.calls[0][0];
    onClick();

    expect(hub.list()).toHaveLength(0);
    expect(announceDismissed).toHaveBeenCalledWith(raised.id);
  });

  it('still carries out the action', () => {
    raise({ id: 'a', action: { type: 'session', entityId: 'lead-form' } });

    const { onClick } = present.mock.calls[0][0];
    onClick();

    expect(activate).toHaveBeenCalledWith({
      type: 'session',
      entityId: 'lead-form',
    });
  });

  it('keeps the dismissed id in the dedup set', () => {
    raise({ id: 'a', action: { type: 'session', entityId: 'lead-form' } });

    const { onClick } = present.mock.calls[0][0];
    onClick();

    // The very next duplicate event must not resurrect what the user just
    // dealt with.
    expect(raise({ id: 'a' })).toBeNull();
  });
});

describe('read-state reaches the renderer', () => {
  /**
   * HIVE-81: the regression this used to guard against was main marking the
   * toast read in its own buffer and telling nobody. Clicking the toast now
   * dismisses rather than merely marks read, so what the renderer cannot
   * otherwise observe is the dismissal itself.
   */
  it('announces a toast click, which the renderer cannot otherwise observe', () => {
    raise({ id: 'a' });
    announceDismissed.mockClear();

    present.mock.calls[0][0].onClick();

    expect(announceDismissed).toHaveBeenCalledWith('a');
  });

  it('announces a mark-all', () => {
    raise({ id: 'a' });
    announceRead.mockClear();

    hub.markRead(null);

    expect(announceRead).toHaveBeenCalledWith(null, false);
  });
});

/**
 * The dock badge.
 *
 * Not decoration beside the toast — measured on macOS 15 / Electron 43.2.0, the
 * OS refuses this app's notifications outright, so the badge is the only thing
 * a user sees from outside the window. A count that lags is therefore the whole
 * signal being wrong, not a cosmetic slip.
 */
describe('the unread count', () => {
  it('announces the new count as each notification is raised', () => {
    raise({ id: 'a' });
    expect(lastUnread()).toBe(1);

    raise({ id: 'b' });
    expect(lastUnread()).toBe(2);
  });

  it('announces nothing for a notification that was dropped', () => {
    raise({ id: 'a' });
    announceUnread.mockClear();

    // A duplicate id, and then a kind switched off.
    raise({ id: 'a' });
    prefs = { 'session.blocked': 'off' };
    raise({ id: 'c' });

    expect(announceUnread).not.toHaveBeenCalled();
  });

  it('counts down as rows are read, one at a time and all at once', () => {
    raise({ id: 'a' });
    raise({ id: 'b' });

    hub.markRead('a');
    expect(lastUnread()).toBe(1);

    hub.markRead(null);
    expect(lastUnread()).toBe(0);
  });

  /**
   * The reason the count is derived from the buffer rather than tallied. An
   * unread row falling off the end of the cap is exactly the transition a
   * hand-maintained counter forgets.
   */
  it('never exceeds the cap, however many are raised', () => {
    for (let i = 0; i < NOTIFICATION_CAP + 10; i += 1) raise({ id: `n${i}` });
    expect(lastUnread()).toBe(NOTIFICATION_CAP);
  });

  it('announces zero when the buffer is cleared', () => {
    raise({ id: 'a' });
    hub.clear();

    expect(lastUnread()).toBe(0);
  });

  /** A toast click is a read, and the badge has to hear about it too. */
  it('counts down when a toast is clicked', () => {
    raise({ id: 'a' });
    announceUnread.mockClear();

    present.mock.calls[0][0].onClick();

    expect(lastUnread()).toBe(0);
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
      kind: 'session.blocked',
      title: 'blocked',
      id: 'detached',
    });

    expect(raised).not.toBeNull();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledTimes(1);

    // And the toast's click still dismisses it.
    present.mock.calls[0][0].onClick();
    expect(hub.list()).toHaveLength(0);
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
      announceRead: (id, unread) => announceRead(id, unread),
      announceUnread: (count) => announceUnread(count),
      announceDismissed: (id) => announceDismissed(id),
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

describe('the foreground gate', () => {
  it('raises an already-read row and presents nothing', () => {
    const present = vi.fn();
    const hub = makeHub({ present, isForeground: () => true });

    const raised = hub.raise({
      kind: 'session.blocked',
      title: 'sess-03 needs approval',
      action: { type: 'session', entityId: 'term-3' },
    });

    expect(raised?.unread).toBe(false);
    expect(present).not.toHaveBeenCalled();
    expect(hub.list()).toHaveLength(1);
  });

  it('leaves the unread count untouched', () => {
    const announceUnread = vi.fn();
    const hub = makeHub({ announceUnread, isForeground: () => true });
    hub.raise({ kind: 'session.blocked', title: 't', action: { type: 'session', entityId: 'term-3' } });
    expect(announceUnread).toHaveBeenLastCalledWith(0);
  });

  it('raises normally for a background session', () => {
    const present = vi.fn();
    const hub = makeHub({ present, isForeground: () => false });
    const raised = hub.raise({ kind: 'session.blocked', title: 't', action: { type: 'session', entityId: 'term-9' } });
    expect(raised?.unread).toBe(true);
    expect(present).toHaveBeenCalled();
  });

  it('remembers a foreground-raised id, so a duplicate still dedups', () => {
    const hub = makeHub({ isForeground: () => true });
    const input = { kind: 'session.blocked' as const, id: 'fixed', title: 't', action: { type: 'session' as const, entityId: 'term-3' } };
    expect(hub.raise(input)).not.toBeNull();
    expect(hub.raise(input)).toBeNull();
  });

  it('does not gate a non-session kind', () => {
    // clone.done: defaultDelivery 'both' and an action that is never
    // `session`, so this exercises the gate itself rather than an unrelated
    // delivery default. (`pr.merged`, named in the brief's example, defaults
    // to `inbox` and would never call `present` regardless of the gate.)
    //
    // The predicate below checks `action.type` itself — the "answers false by
    // construction" shape the real predicate in `ipc/index.ts` has (Step 5:
    // `action.type === 'session' && isForeground(action.entityId)`). A fake
    // that ignored the action entirely, always answering `true`, would gate
    // every kind and could never demonstrate this test's claim.
    const present = vi.fn();
    const hub = makeHub({ present, isForeground: (action) => action.type === 'session' });
    hub.raise({ kind: 'clone.done', title: 't', action: { type: 'url', url: 'https://example.test' } });
    expect(present).toHaveBeenCalled();
  });
});

describe('promote', () => {
  it('marks the row unread and presents it', () => {
    const present = vi.fn();
    const announceRead = vi.fn();
    let foreground = true;
    const hub = makeHub({ present, announceRead, isForeground: () => foreground });

    const raised = hub.raise({ kind: 'session.blocked', title: 't', action: { type: 'session', entityId: 'term-3' } })!;
    present.mockClear();

    foreground = false;
    expect(hub.promote(raised.id)).toBe(true);

    expect(hub.list()[0].unread).toBe(true);
    expect(present).toHaveBeenCalled();
    expect(announceRead).toHaveBeenLastCalledWith(raised.id, true);
  });

  it('is a no-op for an unknown or dismissed id', () => {
    const present = vi.fn();
    const announceRead = vi.fn();
    const hub = makeHub({ present, announceRead, isForeground: () => false });

    const raised = hub.raise({ kind: 'session.blocked', title: 't', action: { type: 'session', entityId: 'term-3' } })!;
    hub.dismiss(raised.id);
    present.mockClear();
    announceRead.mockClear();

    // Nothing to promote and nothing wrong — the caller has nothing to retry.
    expect(hub.promote(raised.id)).toBe(true);

    expect(present).not.toHaveBeenCalled();
    expect(announceRead).not.toHaveBeenCalled();
  });

  it('is a no-op for a row that is already unread', () => {
    const present = vi.fn();
    const announceRead = vi.fn();
    // Never gated — raised straight to unread, same as any background session.
    const hub = makeHub({ present, announceRead, isForeground: () => false });

    const raised = hub.raise({ kind: 'session.blocked', title: 't', action: { type: 'session', entityId: 'term-3' } })!;
    present.mockClear();
    announceRead.mockClear();

    expect(hub.promote(raised.id)).toBe(true);

    expect(hub.list()[0].unread).toBe(true);
    expect(present).not.toHaveBeenCalled();
    expect(announceRead).not.toHaveBeenCalled();
  });

  it('presents nothing when the kind is set to inbox only', () => {
    const present = vi.fn();
    const announceRead = vi.fn();
    let foreground = true;
    const hub = makeHub({ present, announceRead, isForeground: () => foreground });

    const raised = hub.raise({ kind: 'session.blocked', title: 't', action: { type: 'session', entityId: 'term-3' } })!;
    present.mockClear();

    // The user turned the kind down to `inbox` between the raise and the
    // promotion — `promote` re-reads `prefs()` rather than trusting delivery
    // computed at raise time, so it must honour the new setting.
    prefs = { 'session.blocked': 'inbox' };
    foreground = false;
    expect(hub.promote(raised.id)).toBe(true);

    expect(hub.list()[0].unread).toBe(true);
    expect(announceRead).toHaveBeenLastCalledWith(raised.id, true);
    expect(present).not.toHaveBeenCalled();
  });

  /**
   * The regression a code review caught: `promote` had no guard of its own,
   * unlike `raise`, and it calls `prefs()` — proven throwable by
   * `robustness > never throws, whatever a collaborator does` above.
   * Uncaught, that would have propagated up through `reevaluateForeground`
   * and been swallowed two layers further up by `notifyForegroundChange`'s
   * own try/catch, silently — with the caller having no way to know the
   * promotion never actually happened.
   */
  it('reports failure without throwing when a collaborator explodes, and can be retried', () => {
    const present = vi.fn();
    const announceRead = vi.fn();
    let throwing = false;
    const hub = makeHub({
      present,
      announceRead,
      prefs: () => {
        if (throwing) throw new Error('config exploded');
        return prefs;
      },
      isForeground: () => true,
    });

    const raised = hub.raise({ kind: 'session.blocked', title: 't', action: { type: 'session', entityId: 'term-3' } })!;
    present.mockClear();

    throwing = true;
    let result: boolean | undefined;
    expect(() => {
      result = hub.promote(raised.id);
    }).not.toThrow();
    expect(result).toBe(false);

    // A second attempt, once the collaborator behaves again, still succeeds —
    // nothing about the failed attempt left the row unpromotable.
    throwing = false;
    expect(hub.promote(raised.id)).toBe(true);
  });

  /**
   * The retry has to actually deliver — the review finding this file missed.
   *
   * Asserting only that the retry answers `true` let a broken contract pass:
   * the buffer was flipped to `unread` *before* the throwing collaborator ran,
   * so the retry hit `if (entry.unread) return true` and reported success
   * without ever presenting. The re-arm's whole purpose is the toast, and it
   * was the one thing lost. The retry is only a retry if the toast arrives.
   */
  it('presents the toast on the successful retry, not just a truthy answer', () => {
    const present = vi.fn();
    let throwing = false;
    const hub = makeHub({
      present,
      prefs: () => {
        if (throwing) throw new Error('config exploded');
        return prefs;
      },
      isForeground: () => true,
    });

    const raised = hub.raise({ kind: 'session.blocked', title: 't', action: { type: 'session', entityId: 'term-3' } })!;
    present.mockClear();

    throwing = true;
    expect(hub.promote(raised.id)).toBe(false);
    // Nothing moved: a failed promotion must leave the row exactly as gated, or
    // the retry has nothing left to do.
    expect(hub.list()[0].unread).toBe(false);
    expect(present).not.toHaveBeenCalled();

    throwing = false;
    expect(hub.promote(raised.id)).toBe(true);

    expect(present).toHaveBeenCalledTimes(1);
    expect(hub.list()[0].unread).toBe(true);
  });

  /**
   * `off` means do not raise (HIVE-81 review, finding 7).
   *
   * The badge and the inbox row are deliveries too — on a machine where the OS
   * refuses toasts they are the *only* ones. Moving read-state before reading
   * `prefs` meant a kind the user had switched off since the gated raise still
   * got its row promoted and its badge bumped, silently contradicting the
   * setting.
   */
  it('raises nothing at all when the kind has been switched off since the raise', () => {
    const present = vi.fn();
    const announceRead = vi.fn();
    const announceUnread = vi.fn();
    let foreground = true;
    const hub = makeHub({
      present,
      announceRead,
      announceUnread,
      isForeground: () => foreground,
    });

    const raised = hub.raise({ kind: 'session.blocked', title: 't', action: { type: 'session', entityId: 'term-3' } })!;
    present.mockClear();
    announceRead.mockClear();
    announceUnread.mockClear();

    prefs = { 'session.blocked': 'off' };
    foreground = false;
    expect(hub.promote(raised.id)).toBe(true);

    expect(hub.list()[0].unread).toBe(false);
    expect(present).not.toHaveBeenCalled();
    expect(announceRead).not.toHaveBeenCalled();
    expect(announceUnread).not.toHaveBeenCalled();
  });

  /**
   * The phase boundary, from the other side.
   *
   * Once the toast is on screen the promotion has happened as far as the user
   * is concerned, so a throw in the bookkeeping that follows must not report
   * failure — a retry would present a second toast about the same question.
   */
  it('reports success when the toast landed but the announcement threw', () => {
    const present = vi.fn();
    let throwing = false;
    const hub = makeHub({
      present,
      announceRead: () => {
        if (throwing) throw new Error('renderer gone');
      },
      isForeground: () => true,
    });

    const raised = hub.raise({ kind: 'session.blocked', title: 't', action: { type: 'session', entityId: 'term-3' } })!;
    present.mockClear();

    throwing = true;
    expect(hub.promote(raised.id)).toBe(true);

    expect(present).toHaveBeenCalledTimes(1);
  });

  /**
   * HIVE-81: `promote` presents its own toast, with its own `onClick`. A
   * re-armed notification that behaved differently from a fresh one on click
   * — marking read instead of dismissing — is exactly the split nobody would
   * notice until it bit them.
   */
  it('dismisses, not merely marks read, when the re-armed toast is clicked', () => {
    const present = vi.fn();
    const announceDismissed = vi.fn();
    let foreground = true;
    const hub = makeHub({ present, announceDismissed, isForeground: () => foreground });

    const raised = hub.raise({ kind: 'session.blocked', title: 't', action: { type: 'session', entityId: 'term-3' } })!;
    present.mockClear();

    foreground = false;
    hub.promote(raised.id);

    present.mock.calls[0][0].onClick();

    expect(hub.list()).toHaveLength(0);
    expect(announceDismissed).toHaveBeenCalledWith(raised.id);
  });
});
