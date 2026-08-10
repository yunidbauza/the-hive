import {
  NOTIFICATION_CAP,
  NOTIFICATION_KIND_SPECS,
  type HiveNotification,
  type NotificationAction,
  type NotificationKind,
  type NotificationPrefs,
} from '@shared/notification-contract';

/**
 * One owner for every notification the app raises (HIVE-75).
 *
 * ## Why main and not the renderer
 *
 * Three reasons, in descending order of how much they hurt to get wrong.
 *
 * 1. **A closed window must still notify.** A renderer-side bus stops existing
 *    the moment the window is hidden, which is precisely the case the feature
 *    exists for.
 * 2. **The sources are already here.** The hook receiver, `gh`, and later a
 *    Slack socket are Node-side by nature. A renderer bus would mean every one
 *    of them crossing IPC to reach it, then crossing back to be presented.
 * 3. **One decision point.** Before this, `notifications/index.ts` raised OS
 *    notifications and the inbox was a fixture — two systems that could not
 *    agree because they never spoke. An inbox row and a desktop toast are two
 *    *deliveries* of one event, and this is where that becomes true.
 *
 * ## What it owns
 *
 * The prefs lookup, dedup, and the ring buffer with its read-state. The buffer
 * is the reason a window reload no longer empties the inbox: the renderer
 * hydrates from here on mount rather than being the only place the list lived.
 *
 * ## What it deliberately does not own
 *
 * Persistence across launches. The buffer dies with the process, and that is a
 * decision rather than an omission — a notification is about something that is
 * happening, and a queue of yesterday's approvals restored at breakfast is a
 * backlog wearing an inbox's clothes. HIVE-74 records it as a later question
 * that needs a reason first.
 */

/** Show one notification. The real one wraps Electron's `Notification`. */
export type NotificationPresenter = (options: {
  title: string;
  body: string;
  onClick: () => void;
}) => void;

/** What a producer hands in. Everything else the hub decides. */
export interface NotificationInput {
  kind: NotificationKind;
  title: string;
  body?: string;
  /**
   * The dedup key, minted from what the event identifies.
   *
   * Optional because not every producer has one — a session going idle twice is
   * two events, not a repeat. A producer that *can* re-deliver must pass one:
   * see the PR poller, which keys on the PR and the transition it observed.
   */
  id?: string;
  action?: NotificationAction;
  /** Overridable for tests; defaults to the hub's clock. */
  createdAt?: number;
}

export interface NotificationHubOptions {
  /**
   * Read at the moment of the event, never captured.
   *
   * A snapshot taken at boot would ignore every save the user makes afterwards,
   * and the settings section writes through main's config cache. This is the
   * rule `createNotifier` already stated for the presenter; the hub inherits it
   * because it is now the thing that reads them.
   */
  prefs: () => NotificationPrefs;
  present: NotificationPresenter;
  /** Push the notification at the renderer. */
  broadcast: (notification: HiveNotification) => void;
  /** Open whatever this notification is about. Main focuses the window itself. */
  activate: (action: NotificationAction) => void;
  /**
   * Tell the renderer that read-state moved.
   *
   * Announced from **every** path rather than only the toast, so the hub stays
   * the single source of truth. A renderer-initiated `markRead` echoes back,
   * which is harmless: applying it is idempotent and the renderer does not
   * write it back again.
   */
  announceRead: (id: string | null) => void;
  now: () => number;
}

export interface NotificationHub {
  /**
   * Route one event. Answers the notification raised, or `null` if it was
   * dropped — because the kind is switched off, or because it is a duplicate.
   */
  raise(input: NotificationInput): HiveNotification | null;
  /** The buffer, newest first. What a mounting renderer hydrates from. */
  list(): HiveNotification[];
  /** Mark one read, or every one when `id` is null. */
  markRead(id: string | null): void;
  /** Drop everything. Used by tests and by a config reset. */
  clear(): void;
}

/**
 * How many ids the dedup set remembers.
 *
 * Wider than the buffer on purpose. Dedup has to outlive *eviction*: a PR
 * poller running every minute for an hour can push a transition out of a
 * fifty-row buffer and then see it again, and a set sized to the buffer would
 * call that new.
 */
const SEEN_CAP = 500;

let counter = 0;

/**
 * An id for a producer that did not bring one.
 *
 * A counter rather than a uuid because it is never persisted, never crosses a
 * restart, and only has to be unique within one process's buffer — and because
 * a monotonic id makes a test's expectations legible.
 */
function mintId(kind: NotificationKind, at: number): string {
  counter += 1;
  return `${kind}:${at}:${counter}`;
}

export function createNotificationHub(
  options: NotificationHubOptions,
): NotificationHub {
  const { prefs, present, broadcast, activate, announceRead, now } = options;

  let buffer: HiveNotification[] = [];
  const seen = new Set<string>();

  /**
   * A free function, deliberately, rather than a method reached through `this`.
   *
   * The toast's `onClick` has to mark its notification read, and reaching that
   * through `this` binds to however `raise` was *invoked* — so a caller who
   * destructured (`const { raise } = hub`) would make `this` undefined.
   *
   * The damage lands **after** `raise` has returned, which is what makes it
   * nasty. `this` is only dereferenced inside the click handler, so the
   * notification is raised and shown perfectly; `raise`'s own `try` is long
   * since unwound. Clicking the toast then throws a TypeError inside an
   * Electron event handler in main — an uncaught exception on the main process,
   * from a call style that looks entirely reasonable — and the session the user
   * was trying to reach never opens.
   */
  const markRead = (id: string | null): void => {
    announceRead(id);
    buffer =
      id === null
        ? buffer.map((entry) => ({ ...entry, unread: false }))
        : buffer.map((entry) =>
            entry.id === id ? { ...entry, unread: false } : entry,
          );
  };

  const remember = (id: string): void => {
    seen.add(id);
    if (seen.size <= SEEN_CAP) return;
    // Insertion-ordered, so the first key is the oldest. Trimming one per add
    // keeps the set at its bound without ever walking it.
    const oldest = seen.values().next();
    if (!oldest.done) seen.delete(oldest.value);
  };

  return {
    raise(input) {
      /**
       * Nothing here may throw.
       *
       * The hub is reached from inside the broadcast every session's output
       * depends on — `send()` in `ipc/index.ts` taps it before it fans a
       * `pty:data` out to the renderer. A notification that failed must cost a
       * missing notification, never a missing chunk of terminal output. This is
       * the argument `observe()` made for itself, and it now has to hold one
       * layer further in.
       */
      try {
        const spec = NOTIFICATION_KIND_SPECS[input.kind];
        // A kind main does not know cannot be routed, and inventing a default
        // delivery for it would be a switch the settings pane cannot show.
        if (spec === undefined) return null;

        const delivery = prefs()[input.kind] ?? spec.defaultDelivery;
        if (delivery === 'off') return null;

        const createdAt = input.createdAt ?? now();
        const id = input.id ?? mintId(input.kind, createdAt);

        if (seen.has(id)) return null;
        remember(id);

        const notification: HiveNotification = {
          id,
          kind: input.kind,
          title: input.title,
          body: input.body ?? '',
          createdAt,
          unread: true,
          action: input.action ?? { type: 'none' },
        };

        buffer = [notification, ...buffer].slice(0, NOTIFICATION_CAP);
        broadcast(notification);

        if (delivery === 'both') {
          present({
            title: notification.title,
            body: notification.body,
            /**
             * Marked read here as well as activated.
             *
             * Clicking a desktop toast is the user attending to it just as much
             * as clicking the row is. Leaving it unread would make the badge
             * lie about how much is still waiting, which is the whole reason
             * the count exists.
             */
            onClick: () => {
              markRead(id);
              activate(notification.action);
            },
          });
        }

        return notification;
      } catch (cause) {
        console.error('[hive] notification failed:', cause);
        return null;
      }
    },

    list() {
      return buffer;
    },

    markRead,

    clear() {
      buffer = [];
      seen.clear();
    },
  };
}
