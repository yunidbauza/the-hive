import { FeedRow } from '@features/activity-feed/components/feed-row';
import { useFeed } from '@stores/hive-store';

/**
 * What the orchestrator did while the user was not looking.
 *
 * The store caps the feed at 24 and drops the oldest, so this renders whatever
 * it is given without a slice of its own — a second cap here would be a second
 * place to get the number wrong.
 *
 * Keyed by time, text, and position together: the fake clock makes timestamps
 * unique in practice, but a scripted run that pushes two events in one minute
 * would collide on time alone.
 */
export function ActivityFeedPanel() {
  const feed = useFeed();

  return (
    <div data-panel="activity" className="flex flex-col gap-[var(--cc-list-gap)]">
      {feed.map((item, index) => (
        <FeedRow key={`${item.time}-${item.txt}-${index}`} item={item} />
      ))}
    </div>
  );
}
