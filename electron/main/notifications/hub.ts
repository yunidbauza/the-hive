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
  /**
   * The predicate alone when {@link subject} is set — see
   * `HiveNotification.title`. Producers no longer paste a name in front of it.
   */
  title: string;
  /** The terminal this row is about, for producers that are about a session. */
  subject?: string;
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
  /**
   * A validated place to send the reader beyond `action` — see
   * `HiveNotification.link` (HIVE-123). Carried straight through; the hub does
   * no validation of its own, because a producer that sets it has already done
   * that work (`notify.ts`'s `slackLinkFor`).
   */
  link?: { href: string; label: string };
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
   * Tell the renderer that a notification left the buffer (HIVE-81).
   *
   * Called from `dismiss` whenever a row was actually removed. The mirror of
   * `announceRead`, for the same reason: main can dismiss on its own — a
   * clicked desktop toast — and the renderer has no way to observe that
   * without being told.
   *
   * `null` means the whole buffer went — `clearInbox`, the Inbox's Clear all.
   * One event rather than one per row, because the renderer's handler is a
   * filter over its own list and N of them would be N re-renders of a list
   * about to be empty either way.
   */
  announceDismissed: (id: string | null) => void;
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
  /**
   * What to call a notification's `subject` in a **desktop toast** (HIVE-110).
   *
   * Read at the moment of presentation, never captured, for the same reason
   * `prefs` and `isForeground` are: a session renames itself while its rows sit
   * in the buffer, and a promoted row is presented long after it was raised.
   *
   * Only the toast needs it. The inbox row carries `subject` and the renderer
   * resolves the name from its own store, which is the authority — see
   * `HiveNotification.subject`. This exists because an OS notification is a
   * moment rather than a record and has to say something at that instant.
   *
   * Optional: a hub built without it — every existing test, and the browser
   * target's absence of one — falls back to the terminal id, which is what the
   * rail itself shows for a session nothing has named.
   */
  subjectName?: (terminalId: string) => string;
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
   * (HIVE-81). No-op — and reported as success — for an id the buffer no
   * longer holds, or one that is already unread.
   *
   * Answers `false` only when the promotion **did not happen at all** —
   * typically `prefs` or `present` throwing — leaving the row exactly as gated.
   * The caller, `reevaluateForeground`, treats that as "try again": it keeps
   * the pending entry instead of dropping it, so the next focus change gets
   * another chance rather than the session going silently un-rearmed. A throw
   * after the toast is on screen answers `true`, because a retry would show it
   * twice; see the implementation for the phase boundary that makes both true.
   */
  promote(id: string): boolean;
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
   * Drop **every** notification from the buffer — the Inbox's Clear all.
   *
   * Its own method rather than `dismiss(null)`, for the reason recorded on
   * `CH.notificationsClear`: the id guard on `dismiss` exists to stop a lost
   * argument from emptying the inbox, and widening it would trade that
   * guarantee for one fewer function.
   *
   * **Not {@link NotificationHub.clear}**, which is a *reset* — it wipes the
   * dedup set too, so everything the hub has ever seen becomes raisable again.
   * That is right for a config reload and wrong for a user gesture: clearing
   * the inbox must not re-arm fifty notifications to be raised by the next
   * duplicate event. Every id stays remembered here, exactly as a single
   * dismissal leaves its own behind.
   */
  clearInbox(): void;
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

/**
 * What a new notification **replaces**, rather than what it repeats.
 *
 * ## Why `seen` was never going to cover this
 *
 * The dedup set answers "have I said this exact thing before", and it is right
 * to: a PR poller that observes one transition twice must say it once. But a
 * session going idle at 14:02 and again at 14:38 is genuinely *two events*, so
 * `NotificationInput.id` documents itself as optional for exactly that case and
 * the producer mints nothing. Both rows are therefore new, both are kept, and
 * the inbox grows a column of "sess-0z is yours again" that says the same thing
 * three times with three different ages.
 *
 * The second and third rows are not wrong — they are *stale*. Only the newest
 * is true, because "your turn again" describes a state the next one overwrote.
 * So this is not dedup at all: it is a **supersede**, and it has to remove the
 * older row rather than refuse the newer one. Refusing the newer would freeze
 * the inbox at the first time the session went idle and let the timestamp rot.
 *
 * ## Why the key comes off the action
 *
 * The same reason `isForeground` takes one: the hub then needs no idea which
 * kinds are about a session, and no list to keep in step with the registry. A
 * `session` action names a terminal and can be compared; every other action
 * type has no session to collapse against and answers `null` by construction,
 * which is what keeps `pr.*`, `clone.done` and `app.update_*` out of this
 * without a special case. Those kinds all key their own ids off the event
 * anyway, so `seen` is already the right instrument for them.
 *
 * Kind is part of the key, never dropped. "Blocked on you" and "yours again"
 * are different facts about one session and both may be true to a reader; only
 * a repeat of the *same* fact is stale.
 */
function supersedeKey(
  kind: NotificationKind,
  action: NotificationAction,
): string | null {
  // NUL rather than ':' — a kind contains dots and an entity id is arbitrary,
  // so a printable separator is one collision away from merging two sessions.
  return action.type === 'session' ? `${kind}\u0000${action.entityId}` : null;
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
    announceDismissed,
    announceUnread,
    now,
    isForeground,
    subjectName,
  } = options;

  let buffer: HiveNotification[] = [];
  const seen = new Set<string>();

  /**
   * What a **toast** calls this notification (HIVE-110).
   *
   * The one place a name is pasted onto a title, and it happens at the moment
   * of presentation rather than at the moment of raising — which is the whole
   * point. A row raised while a session was still unnamed, promoted twenty
   * minutes later when it has titled itself, toasts under the name the user can
   * actually see on the rail.
   *
   * A row with no `subject` is about no session and keeps its title verbatim,
   * which is every `pr.*`, `clone.done` and `app.update_*`.
   */
  const toastTitle = (notification: HiveNotification): string => {
    const { subject, title } = notification;
    if (subject === undefined) return title;
    /*
      `||`, not `??`. `createSessionNames.get` never answers `''` — it refuses to
      store one — but `subjectName` is an option and takes any function, and an
      empty answer would present as `" is yours again"`, a toast with a leading
      space and no subject at all. The terminal id is the same fallback the
      registry itself uses, so the invariant is local to this line rather than
      borrowed from another module.
    */
    return `${subjectName?.(subject) || subject} ${title}`;
  };

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
   * The toast's `onClick` has to dismiss its notification, and reaching that
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
   *
   * Wrapped the way `raise` wraps itself, and for the caller it matters even
   * more here: `reevaluateForeground` is the only thing that ever calls this,
   * and it drives the promotion from a pending map it deletes from on success.
   * A throw that escaped uncaught would still be swallowed one layer up (by
   * `notifyForegroundChange`'s own try/catch), but by then the entry would
   * already be gone — a still-blocked session that silently never gets
   * re-armed, on this or any later focus change. Reporting `false` instead
   * lets the caller keep the entry and try again next time.
   *
   * ## Why the buffer moves last
   *
   * The retry contract above is only true if a failed attempt leaves the row
   * exactly as it found it. It did not: the flip to `unread` came first, so
   * every realistic thrower — `prefs`, `present` — ran on a row that was
   * already unread, and the retry the caller dutifully made hit
   * `if (entry.unread) return true` and reported success without presenting
   * anything. The toast, which is the entire purpose of the re-arm, was the one
   * delivery lost, and the code called that a success.
   *
   * So the work is split at the **presentation**, which is the only step that
   * cannot be undone or repeated safely:
   *
   * 1. *Decide* — `spec`, `prefs`, delivery. Everything here may throw, and a
   *    throw costs nothing because nothing has moved. This is also where `off`
   *    is honoured, and it has to be before the buffer: a badge and an inbox row
   *    are deliveries too, and on a machine where the OS refuses toasts they are
   *    the only ones. Raising them for a kind the user switched off would
   *    contradict the setting in the one place it still shows.
   * 2. *Present* — the toast. Still ahead of the buffer, so a refusal here is
   *    also a clean retry.
   * 3. *Record* — flip to unread, announce the read, announce the count. Past
   *    the point of no return: the toast is on screen, so a throw in this
   *    bookkeeping is logged and reported as **success**. Answering `false`
   *    would earn a retry, and a retry would present a second toast about the
   *    same question.
   *
   * The alternative considered was a separate `presented` flag on the buffer
   * entry, tracked apart from `unread`. It solves the same problem by
   * remembering more; this one solves it by doing things in an order that needs
   * nothing remembered, and `HiveNotification` stays the shape the renderer
   * hydrates from.
   */
  const promote = (id: string): boolean => {
    try {
      const entry = buffer.find((notification) => notification.id === id);
      // Dismissed, or evicted by the cap. Nothing to promote and nothing
      // wrong — the caller has nothing to retry either.
      if (entry === undefined) return true;
      // Already unread: it was never gated, or this ran twice. Also nothing
      // to retry.
      if (entry.unread) return true;

      const spec = NOTIFICATION_KIND_SPECS[entry.kind];
      if (spec === undefined) return true;
      const delivery = prefs()[entry.kind] ?? spec.defaultDelivery;
      // `off` means do not raise — not "raise it quietly".
      if (delivery === 'off') return true;

      if (delivery === 'both') {
        present({
          title: toastTitle(entry),
          body: entry.body,
          onClick: () => {
            /**
             * Dismissed, not merely marked read (HIVE-81).
             *
             * Clicking a desktop toast is a stronger gesture than opening the
             * inbox and reading a row. The user was in another application,
             * chose this notification over what they were doing, and it took
             * them straight to the session — there is nothing left for the row
             * to tell them. Leaving it behind turns the inbox into a list of
             * things already dealt with, which is the state that makes people
             * stop reading it.
             *
             * The id stays in `seen`, so the very next duplicate event cannot
             * re-raise what the user just dealt with.
             *
             * No `ask`-shaped exception here, unlike `raise`'s own toast
             * handler (HIVE-118 whole-branch review, finding 1). This path
             * fires from `reevaluateForeground`, which only ever promotes an
             * entry out of `pendingForeground` — and that map is filled
             * exclusively by `sessionEvent` in `notifications/index.ts`,
             * which mints only `session.blocked`, `session.input_needed` and
             * `session.idle`. An `agent.ask` is raised straight through
             * `hub.raise` and never gated in the first place, because
             * `isForeground` answers `false` for every action that is not
             * `session` — so it can never reach this handler. If that ever
             * changes, this needs the same guard `raise` got.
             */
            dismiss(id);
            activate(entry.action);
          },
        });
      }
    } catch (cause) {
      console.error('[hive] notification failed:', cause);
      return false;
    }

    // Step 3. Nothing above this line has touched the buffer, and nothing
    // below it may be retried.
    try {
      buffer = buffer.map((notification) =>
        notification.id === id ? { ...notification, unread: true } : notification,
      );
      announceRead(id, true);
      announce();
    } catch (cause) {
      console.error('[hive] notification failed:', cause);
    }

    return true;
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
    if (buffer.length !== before) {
      announceDismissed(id);
      announce();
    }
  };

  /**
   * The bulk gesture. Same two follow-ups as `dismiss`, once.
   *
   * `announceDismissed(null)` rather than one call per row: the renderer's
   * handler is a filter over its own list, so N events would be N re-renders of
   * a list that is about to be empty either way.
   *
   * An already-empty buffer announces nothing, so a double-click on Clear all
   * does not push a second event at every window.
   */
  const clearInbox = (): void => {
    if (buffer.length === 0) return;
    buffer = [];
    announceDismissed(null);
    announce();
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
          /*
            Spread rather than assigned, so a producer that is about no session
            leaves the key off entirely instead of carrying an explicit
            `undefined` across IPC. `exactOptionalPropertyTypes` is what makes
            that a compile error rather than a style note.
          */
          ...(input.subject === undefined ? {} : { subject: input.subject }),
          body: input.body ?? '',
          createdAt,
          unread: !foreground,
          action: input.action ?? { type: 'none' },
          ...(input.link === undefined ? {} : { link: input.link }),
        };

        /**
         * The newer row replaces the older one about the same session.
         * See {@link supersedeKey} for why this is not dedup.
         *
         * Position matters twice over. It is **after** the `off` and `seen`
         * gates, so a kind the user switched off and an event already seen both
         * leave the inbox exactly as they found it — a notification that was
         * never raised must not silently delete the one already sitting there.
         * And it is **after** the foreground gate, because a gated row is still
         * a row: the user watching a session does not make the older "yours
         * again" any less stale.
         *
         * Read-state is deliberately not inherited. The superseded row may have
         * been read; this is a *new* event about the same session, and carrying
         * the old `unread: false` across would let a fact the user has never
         * seen arrive pre-dismissed.
         */
        const key = supersedeKey(notification.kind, notification.action);
        const superseded =
          key === null
            ? []
            : buffer.filter(
                (entry) => supersedeKey(entry.kind, entry.action) === key,
              );

        buffer = [
          notification,
          ...buffer.filter((entry) => !superseded.includes(entry)),
        ].slice(0, NOTIFICATION_CAP);

        /**
         * Counted once, from the settled buffer. A supersede is a removal and
         * an insert, and announcing between them would publish a count that was
         * true at neither moment.
         */
        announce();

        /**
         * Dismissals before the new row, so the renderer never holds both.
         *
         * `announceDismissed` is the only way the renderer learns a row left
         * the buffer — its list is its own, hydrated once and then driven by
         * these events. Without this the inbox would keep showing all three
         * rows until the next reload, which is the exact bug being fixed.
         *
         * `seen` keeps every superseded id, exactly as `dismiss` does: the row
         * is gone because something newer replaced it, not because it never
         * happened, and a re-delivery of it is still a duplicate.
         */
        for (const stale of superseded) announceDismissed(stale.id);

        broadcast(notification);

        if (delivery === 'both' && !foreground) {
          present({
            title: toastTitle(notification),
            body: notification.body,
            /**
             * Dismissed, not merely marked read (HIVE-81) — with one
             * exception, `ask` (HIVE-118 whole-branch review, finding 1).
             *
             * For every other kind, clicking a desktop toast is a stronger
             * gesture than opening the inbox and reading a row: the user was
             * in another application, chose this notification over what they
             * were doing, and it took them straight to the thing — there is
             * nothing left for the row to tell them. Leaving it behind turns
             * the inbox into a list of things already dealt with, which is the
             * state that makes people stop reading it.
             *
             * An `ask` breaks that premise. The click does not take the user
             * to the answer — a toast has room for a title, a body and one
             * click, none of which can hold the options an ask offers — it
             * takes them to the *row*, which is the control. Dismissing on
             * click would delete the very thing the click was supposed to
             * reveal: the ledger entry stays an open ask, the agent stays
             * blocked waiting for a reply, and nothing can ever bring the row
             * back, because `seen` keeps its id forever. Marking it read would
             * be nearly as wrong — an unanswered ask still needs the user, and
             * a read badge that undercounts what is actually pending is a
             * badge that lies in the one direction nobody notices until the
             * agent has been stuck for a day. So an `ask` toast only
             * activates: it focuses the app and leaves the row exactly as it
             * was, unread and present, for the user to actually answer.
             *
             * The id stays in `seen` regardless, so the very next duplicate
             * event cannot re-raise what is already sitting in the inbox.
             */
            onClick: () => {
              if (notification.action.type !== 'ask') dismiss(id);
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

    clearInbox,

    activate,

    clear() {
      buffer = [];
      seen.clear();
      announce();
    },
  };
}
