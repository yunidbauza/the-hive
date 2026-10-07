import { useEffect } from 'react';

import {
  rises,
  useApplyDismiss,
  useApplyRead,
  useHydrateNotifs,
  usePushNotif,
} from '@stores/hive-store';
import { useInboxActions } from '@stores/ui-store';

/** The keyboard is in a terminal: the test `use-app-chords.ts` uses, on the focused element. */
const inTerminal = (): boolean => document.activeElement?.closest('[data-terminal-id]') != null;

/**
 * Keep the inbox in step with the hub in main (HIVE-75).
 *
 * Two halves of one subscription, and both are needed.
 *
 * **Hydrate**, because the hub outlives the window. A devtools reload, or a
 * window closed and re-opened on macOS, would otherwise present an empty inbox
 * and a zero badge while main still held four blocked sessions — the app
 * forgetting something it had not actually forgotten.
 *
 * **Subscribe**, because the renderer cannot know when a session blocks. Push
 * rather than poll: a one-second timer running for the life of the app to learn
 * nothing almost every time is a poor trade against one channel.
 *
 * Mounted once, at the composition root, like `useSessionStatus` and
 * `useNotificationActivate`. A per-card subscription would mean one listener
 * per row on a channel that broadcasts to all of them.
 *
 * Read-state flows **both** ways, and it has to.
 *
 * `markRead` writes through to main inside the store action, so the hub stays
 * the one place that decides what has been seen. But main can decide it on its
 * own — clicking a **desktop toast** is the user attending to a notification,
 * and the renderer has no way to observe that. Without the `onRead`
 * subscription below, that click left the row filled and the unread badge
 * counting a notification already dealt with, until the next reload silently
 * corrected it: exactly the badge-and-list disagreement this comment used to
 * claim was impossible.
 *
 * Dismissal is the same story one gesture further along (HIVE-81): clicking
 * the **desktop toast** now dismisses rather than merely marks read, so the
 * `onDismissed` subscription below is what takes the row out of the inbox
 * without the user having to see it there until the next reload.
 *
 * Live arrivals rise (HIVE-198). A Summons row that arrives on the channel
 * joins the arrival queue, as a card over the pill, or as a single pulse of
 * the pill when the keyboard is in a terminal. The boot and reattach
 * snapshots hydrate and never reach `onNew`, so nothing old ever rises.
 */
export function useNotificationStream(): void {
  const pushNotif = usePushNotif();
  const hydrate = useHydrateNotifs();
  const applyRead = useApplyRead();
  const applyDismiss = useApplyDismiss();
  const { pushArrival } = useInboxActions();

  useEffect(() => {
    // No bridge is the browser demo, where nothing produces notifications.
    const bridge = window.hive;
    if (!bridge) return;

    let live = true;

    /**
     * Subscribe *before* hydrating, not after.
     *
     * The other order has a hole: a notification raised between the `list()`
     * call and the subscription lands in neither, and is lost until something
     * else forces a re-read. Subscribing first can only ever duplicate — and
     * the store dedups by id, so a duplicate costs nothing.
     */
    const unsubscribe = bridge.notifications.onNew((notification) => {
      pushNotif(notification);
      // What is drawn is filtered again at render by `useSummons(onStage)`, so
      // the on-stage session and an answered ask never show though pushed here.
      // News only pulses the pill, unless it is the one Echo that rises (HIVE-231).
      pushArrival(notification.id, rises(notification) ? inTerminal() : true);
    });

    const unsubscribeRead = bridge.notifications.onRead(({ id, unread }) => {
      /**
       * Split at the boundary, because the wire type is wider than the action.
       *
       * `NotificationReadEvent` carries `id: string | null` and a free
       * `unread`, which spells a combination the store refuses to accept:
       * `null` means *every row*, and un-reading the whole inbox at once is
       * something no producer does and nothing would want. `markRead(null)` in
       * the hub is the only thing that sends a null id, and it only ever marks
       * read. This is that fact stated where the two types meet.
       */
      if (id === null) {
        applyRead(null, false);
        return;
      }
      applyRead(id, unread);
    });

    const unsubscribeDismissed = bridge.notifications.onDismissed(({ id }) => {
      applyDismiss(id);
    });

    void bridge.notifications
      .list()
      .then((notifications) => {
        if (live) hydrate(notifications);
      })
      .catch(() => {
        // A failed hydration is an inbox that fills from the next event
        // onwards, which is strictly better than a render that throws.
      });

    return () => {
      live = false;
      unsubscribe();
      unsubscribeRead();
      unsubscribeDismissed();
    };
  }, [applyDismiss, applyRead, hydrate, pushArrival, pushNotif]);
}
