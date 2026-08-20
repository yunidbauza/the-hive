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
  announceRead: (id: string | null, unread: boolean) => void;
  /**
   * How many are still unread, after every change to the buffer.
   *
   * Pushed rather than offered as a getter, because the consumer is the **dock
   * badge** and a badge is only ever wrong in one direction: nobody notices a
   * count that was never set, everybody notices one that is stale. A getter puts
   * the obligation to re-read on four call sites that have no reason to know a
   * badge exists; this puts it on the one place the number changes.
   *
   * It matters more than it looks. On this machine — measured — macOS refuses
   * Electron's notifications outright, so the dock badge is not decoration
   * beside the toast, it is the only thing the user sees from outside the app.
   */
  announceUnread: (count: number) => void;
  now: () => number;
  /**
   * Is the user already looking at what this notification is about (HIVE-81)?
   *
   * Read at the moment of the event, never captured — the same rule `prefs` and
   * `now` state, and for a sharper reason: the answer changes on every tab
   * switch and every window blur.
   *
   * Takes the **action**, so the hub needs no idea which kinds are about a
   * session. A `session` action names a terminal and can be compared; every
   * other action type has no foreground to compare against and answers `false`
   * by construction. That is what keeps `pr.*`, `clone.done` and `app.update_*`
   * out of the gate without a list to maintain.
   *
   * Optional: a hub built without it — every existing test, and the browser
   * target's absence of one — behaves exactly as it did before.
   */
  isForeground?: (action: NotificationAction) => boolean;
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
  /**
   * Un-read a row and show it now — the foreground gate's other half
   * (HIVE-81). No-op for an id the buffer no longer holds, or one that is
   * already unread.
   */
  promote(id: string): void;
  /**
   * Drop one notification from the buffer for good (HIVE-93).
   *
   * `list()` is what a mounting renderer hydrates from, so this is what makes a
   * dismissal outlive a reload rather than reappearing with the next hydration.
   *
   * The id stays in the dedup set on purpose — a dismissed notification must not
   * be raised again by the very next event that would have been a duplicate.
   */
  dismiss(id: string): void;
  /**
   * Carry out an action, exactly as clicking the desktop toast would.
   *
   * Exposed so a clicked *inbox row* reaches the same router. Before this the
   * router was reachable only from inside `raise`, so the row could act on the
   * one action type the renderer could handle by itself and silently ignored
   * the rest — which is how a `url` notification came to be documented as
   * "deliberately not opened from here".
   *
   * It does not mark anything read: the row already did that with the id it
   * holds, and the toast path marks read before calling this. Doing it here as
   * well would need an id this signature has no reason to take.
   */
  activate(action: NotificationAction): void;
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
  const {
    prefs,
    present,
    broadcast,
    activate,
    announceRead,
    announceUnread,
    now,
    isForeground,
  } = options;

  let buffer: HiveNotification[] = [];
  const seen = new Set<string>();

  /**
   * Counted from the buffer rather than kept as a tally.
   *
   * The codebase's own rule — derived values are computed, never stored — and
   * the reason it applies here is `NOTIFICATION_CAP`: a counter incremented on
   * raise and decremented on read would have to also notice an *eviction*, and
   * an unread row falling off the end of a fifty-deep buffer is exactly the
   * event a hand-maintained tally forgets. Fifty entries is nothing to walk.
   */
  const announce = (): void => {
    announceUnread(buffer.reduce((n, entry) => n + (entry.unread ? 1 : 0), 0));
  };

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
    announceRead(id, false);
    buffer =
      id === null
        ? buffer.map((entry) => ({ ...entry, unread: false }))
        : buffer.map((entry) =>
            entry.id === id ? { ...entry, unread: false } : entry,
          );
    /**
     * After the buffer, never before.
     *
     * `announceRead` above may go first — the renderer applies read state from
     * the id and never asks this side for a count — but the badge is a
     * *derivation of the buffer*, so announcing it before the map runs would
     * publish the count from before the read every single time.
     */
    announce();
  };

  /**
   * Un-read a row and show it now — the foreground gate's other half (HIVE-81).
   *
   * A session that blocked while the user was watching it had its notification
   * downgraded to a silent, already-read row. If the user then walks away while
   * it is *still* blocked, that decision has expired: the reason not to
   * interrupt was that they could see it, and they cannot see it any more.
   *
   * A promotion rather than a second `raise`, because the row already exists.
   * Raising again would mint a new id (or be swallowed by `seen`, with the same
   * id) and leave the inbox holding the same question twice.
   *
   * Re-reads `prefs` rather than trusting the delivery computed at raise time:
   * the user may have turned this kind down to `inbox` in between, and a
   * promotion is a fresh decision to interrupt.
   */
  const promote = (id: string): void => {
    const entry = buffer.find((notification) => notification.id === id);
    // Dismissed, or evicted by the cap. Nothing to promote and nothing wrong.
    if (entry === undefined) return;
    // Already unread: it was never gated, or this ran twice.
    if (entry.unread) return;

    buffer = buffer.map((notification) =>
      notification.id === id ? { ...notification, unread: true } : notification,
    );
    announceRead(id, true);
    announce();

    const spec = NOTIFICATION_KIND_SPECS[entry.kind];
    if (spec === undefined) return;
    const delivery = prefs()[entry.kind] ?? spec.defaultDelivery;
    if (delivery !== 'both') return;

    present({
      title: entry.title,
      body: entry.body,
      onClick: () => {
        markRead(id);
        activate(entry.action);
      },
    });
  };

  /**
   * Removed from the buffer, but **not** from `seen`.
   *
   * Forgetting it there would let the next duplicate event re-raise the very
   * notification the user just dismissed, which is the one outcome that would
   * make the gesture feel broken.
   *
   * `announce()` afterwards because the badge is a derivation of the buffer: a
   * dismissed row that was still unread has to stop being counted, and nothing
   * else recomputes that.
   */
  const dismiss = (id: string): void => {
    const before = buffer.length;
    buffer = buffer.filter((entry) => entry.id !== id);
    // An unknown id is a no-op rather than an error: the renderer may be acting
    // on a row from a buffer that has since been trimmed by the cap.
    if (buffer.length !== before) announce();
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

        /**
         * The gate: **downgrade, never drop** (HIVE-81).
         *
         * The user is watching this session's terminal in a focused window, so
         * the app has already told them — a toast, a dock bounce and a bump to
         * the unread badge about a question they are reading on screen is the
         * app talking over itself.
         *
         * What it does *not* do is suppress. The row is kept and raised
         * already-read, which matters more than it looks: on this machine macOS
         * refuses Electron's toasts outright, so the inbox and the badge are the
         * only delivery there is. Dropping the row would make the app silent on
         * the exact system this feature was written for.
         *
         * Note the position — **after** `remember(id)`, deliberately. A
         * foreground row is a row that happened, so a genuine duplicate of it
         * must still dedup. This is the argument for keeping the row rather than
         * dropping it stated a second way.
         */
        const foreground = isForeground?.(input.action ?? { type: 'none' }) ?? false;

        const notification: HiveNotification = {
          id,
          kind: input.kind,
          title: input.title,
          body: input.body ?? '',
          createdAt,
          unread: !foreground,
          action: input.action ?? { type: 'none' },
        };

        buffer = [notification, ...buffer].slice(0, NOTIFICATION_CAP);
        announce();
        broadcast(notification);

        if (delivery === 'both' && !foreground) {
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

    promote,

    dismiss,

    activate,

    clear() {
      buffer = [];
      seen.clear();
      announce();
    },
  };
}
