import { EmptyState } from '@components/ui/empty-state';
import { NotificationCard } from '@features/inbox/components/notification-card';
import { useNotifs } from '@stores/hive-store';

/**
 * The inbox — everything that wants the user, newest first.
 *
 * **Keyed by id** (HIVE-75). It used to be keyed by content *and* position,
 * because the shape it rendered had no identity of its own and content alone
 * could collide. Every notification carries a stable id now, minted by whatever
 * produced it, so the key is simply the identity — which is also what makes
 * React reuse the right card when one lands on top.
 *
 * ## Empty until something happens
 *
 * This panel used to open onto five seeded rows. They were the last fixture in
 * the app, they named sessions that no longer existed, and clicking one
 * dismissed a row and opened nothing. They are gone.
 *
 * An empty inbox is the correct state for a freshly launched app: nothing has
 * asked for the user yet. The copy says that rather than apologising for it.
 */
export function InboxPanel() {
  const notifs = useNotifs();

  if (notifs.length === 0) {
    return (
      <div data-panel="inbox" className="flex flex-col gap-[var(--cc-list-gap-sm)]">
        <EmptyState
          phrase="empty.inbox"
          action="Sessions and pull requests will show up here."
        >
          Nothing needs you.
        </EmptyState>
      </div>
    );
  }

  return (
    <div data-panel="inbox" className="flex flex-col gap-[var(--cc-list-gap-sm)]">
      {notifs.map((notif) => (
        <NotificationCard key={notif.id} notif={notif} />
      ))}
    </div>
  );
}
