import { NotificationCard } from '@features/inbox/components/notification-card';
import { useNotifs } from '@stores/hive-store';

/**
 * The inbox — everything agents need from the user, newest first.
 *
 * Keyed by content rather than index: the simulation prepends, and an index key
 * would make React reuse the top card's DOM for a different notification,
 * briefly showing stale text under a new title.
 *
 * The index is still passed down, because `markRead` addresses a notification
 * by position in the store's array.
 */
export function InboxPanel() {
  const notifs = useNotifs();

  return (
    <div
      data-panel="inbox"
      data-testid="inbox-panel"
      className="flex flex-col gap-2"
    >
      {notifs.map((notif, index) => (
        <NotificationCard
          key={`${notif.title}-${notif.time}`}
          notif={notif}
          index={index}
        />
      ))}
    </div>
  );
}
