import { useEffect } from 'react';

import { useHydrateNotifs, usePushNotif } from '@stores/hive-store';

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
 * Read-state is **not** mirrored back here. `markRead` writes through to main
 * inside the store action, so the hub stays the one place that knows what has
 * been seen; a second copy in the renderer is how a badge and a list start
 * disagreeing.
 */
export function useNotificationStream(): void {
  const pushNotif = usePushNotif();
  const hydrate = useHydrateNotifs();

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
    };
  }, [hydrate, pushNotif]);
}
