import { cn } from '@/lib/utils';
import type { Notification, Tone } from '@/types/notification';

import { Icon } from '@components/ui/icon';
import { useMarkRead } from '@stores/hive-store';
import { useOpenTab } from '@stores/ui-store';

const TONE_TEXT: Record<Tone, string> = {
  amber: 'text-amber',
  green: 'text-green',
  brand: 'text-brand',
  red: 'text-red',
};

interface NotificationCardProps {
  notif: Notification;
  /** Position in `notifs` — how `markRead` identifies this card. */
  index: number;
}

/**
 * One thing an agent needs from the user.
 *
 * Clicking does two things at once, and both matter: it opens the terminal that
 * is blocked, and it marks *this* card read. Marking read without navigating
 * would lose the thread; navigating without marking read would leave the badge
 * lying about how much is still waiting.
 *
 * The unread state is carried by fill *and* by a visually hidden word. Colour
 * alone would put the count's meaning out of reach of a screen reader, and the
 * count is the whole point of the red badge on the tab.
 */
export function NotificationCard({ notif, index }: NotificationCardProps) {
  const openTab = useOpenTab();
  const markRead = useMarkRead();

  return (
    <button
      type="button"
      onClick={() => {
        openTab(notif.target);
        markRead(index);
      }}
      className={cn(
        'flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left hover:bg-hover',
        notif.unread ? 'border-border bg-chip' : 'border-border-soft',
      )}
    >
      <Icon
        name={notif.icon}
        size={16}
        className={cn('mt-px shrink-0', TONE_TEXT[notif.tone])}
      />

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[12.5px] font-semibold text-ink">
          {notif.title}
        </span>
        <span className="text-[11.5px] leading-[1.4] text-muted">
          {notif.sub}
        </span>
        {notif.unread ? <span className="sr-only">unread</span> : null}
      </span>

      <span className="shrink-0 font-mono text-[10px] text-subtle">
        {notif.time}
      </span>
    </button>
  );
}
