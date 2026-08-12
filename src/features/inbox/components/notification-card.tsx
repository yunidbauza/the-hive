import { cn } from '@/lib/utils';
import {
  NOTIFICATION_KIND_SPECS,
  type HiveNotification,
  type Tone,
} from '@/types/notification';

import { Icon } from '@components/ui/icon';
import { useRelativeTime } from '@hooks/use-relative-time';
import { useMarkRead, useOpenEntity } from '@stores/hive-store';

const TONE_TEXT: Record<Tone, string> = {
  amber: 'text-amber',
  green: 'text-green',
  brand: 'text-brand',
  red: 'text-red',
};

interface NotificationCardProps {
  notif: HiveNotification;
}

/**
 * One thing that wants the user's attention.
 *
 * Clicking does two things at once, and both matter: it goes where the
 * notification points, and it marks *this* card read. Marking read without
 * navigating would lose the thread; navigating without marking read would leave
 * the badge lying about how much is still waiting.
 *
 * The unread state is carried by fill *and* by a visually hidden word. Colour
 * alone would put the count's meaning out of reach of a screen reader, and the
 * count is the whole point of the red badge on the tab.
 *
 * ## What HIVE-75 changed
 *
 * **Identity, presentation and time all stopped being stored.**
 *
 * The card used to take an `index` and mark read by position, which was correct
 * only while nothing prepended between render and click. With a fixture that
 * was always true. With a live producer it is a race the user loses by clicking
 * at the wrong moment — a session finishes, a row lands on top, and the click
 * dismisses the row above the one they aimed at. It marks read by **id** now.
 *
 * The glyph and its colour come from the kind's registry entry rather than from
 * the record, and the label comes from `createdAt` and ticks — so a row reading
 * "4m" is four minutes old, rather than having been four minutes old once.
 */
export function NotificationCard({ notif }: NotificationCardProps) {
  const openEntity = useOpenEntity();
  const markRead = useMarkRead();
  const spec = NOTIFICATION_KIND_SPECS[notif.kind];
  const time = useRelativeTime(notif.createdAt);

  return (
    <button
      type="button"
      onClick={() => {
        markRead(notif.id);

        /**
         * A `url` action is deliberately not opened from here.
         *
         * External links are main's, through `external-links.ts`, which is what
         * keeps a foreign URL out of the app's own navigation. No producer of
         * `url` actions exists yet — Slack is HIVE-77 — so rather than route one
         * badly in advance, the click marks read and stays put.
         */
        if (notif.action.type === 'session') openEntity(notif.action.entityId);
      }}
      className={cn(
        'flex items-start gap-2.5 rounded-xl border px-3 py-[var(--cc-card-py)] text-left hover:bg-hover',
        notif.unread ? 'border-border bg-chip' : 'border-border-soft',
      )}
    >
      <Icon
        name={spec.icon}
        size={16}
        className={cn('mt-px shrink-0', TONE_TEXT[spec.tone])}
      />

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[12.5px] font-semibold text-ink">
          {notif.title}
        </span>
        {notif.body === '' ? null : (
          <span className="text-[11.5px] leading-[1.4] text-muted">
            {notif.body}
          </span>
        )}
        {notif.unread ? <span className="sr-only">unread</span> : null}
      </span>

      <span className="shrink-0 font-mono text-[10px] text-subtle">{time}</span>
    </button>
  );
}
