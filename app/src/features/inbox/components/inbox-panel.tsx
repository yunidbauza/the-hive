import { NotificationCard } from '@features/inbox/components/notification-card';
import { useNotifs } from '@stores/hive-store';

/**
 * The inbox — everything agents need from the user, newest first.
 *
 * Keyed by content *and* position, like the feed panel. Content alone is not
 * unique: the simulation stamps what it pushes as `now`, so two notifications
 * with the same title in one demo run would collide on key. Position alone is
 * stable but says nothing about identity. Together they are unique for any list
 * the store can hold.
 *
 * The index is passed down as a prop besides, because `markRead` addresses a
 * notification by its position in the store's array.
 */
export function InboxPanel() {
  const notifs = useNotifs();

  return (
    <div data-panel="inbox" className="flex flex-col gap-2">
      {notifs.map((notif, index) => (
        <NotificationCard
          key={`${notif.title}-${notif.time}-${index}`}
          notif={notif}
          index={index}
        />
      ))}
    </div>
  );
}
