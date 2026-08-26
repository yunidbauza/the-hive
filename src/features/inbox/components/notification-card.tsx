import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import {
  NOTIFICATION_KIND_SPECS,
  type HiveNotification,
  type Tone,
} from '@/types/notification';

import { Icon } from '@components/ui/icon';
import { useReducedMotion } from '@hooks/use-reduced-motion';
import { useRelativeTime } from '@hooks/use-relative-time';
import { currentRowFor, useDismissNotif, useOpenEntity } from '@stores/hive-store';

/**
 * How long the exit animation runs, in ms (HIVE-93).
 *
 * **Must match `--animate-ccslideout` in `tokens.css`.** The unmount is scheduled
 * from here while the animation is declared there, so the number exists twice by
 * necessity; exporting it at least means the tests assert against the same one
 * the component waits for, rather than a second guess.
 */
export const CARD_EXIT_MS = 220;

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
 * notification points, and it **removes the card** (HIVE-93).
 *
 * It used to mark the card read and leave it in the list. Read-and-kept is the
 * right contract for something you glance at, and the wrong one for something you
 * *act on*: a row whose click just navigated you somewhere has spent its entire
 * purpose, and keeping it turns the inbox into a log the user has to prune by
 * hand. Removal covers the badge too — `useUnreadCount` derives from the list, so
 * a dismissed row stops being counted without a separate `markRead` write.
 *
 * A card with `action.type === 'none'` is dismissed as well. Nothing was
 * navigated to, but the click is still the user dealing with it, and now that the
 * header bell no longer marks everything read there would otherwise be no way to
 * clear one at all.
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
  const dismissNotif = useDismissNotif();
  const reduced = useReducedMotion();
  const spec = NOTIFICATION_KIND_SPECS[notif.kind];
  const time = useRelativeTime(notif.createdAt);

  const [leaving, setLeaving] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * A card can be unmounted by something other than its own click — a newer
   * notification trimming the buffer's tail, or the panel unmounting with the
   * rail. Clearing the timer stops `dismissNotif` firing for a row that is
   * already gone.
   */
  useEffect(
    () => () => {
      if (exitTimer.current !== null) clearTimeout(exitTimer.current);
    },
    [],
  );

  const performAction = () => {
    /**
     * `session` here, everything else in main.
     *
     * Only the renderer knows what opening a session *means* — it is a tab, a
     * selection and a view transition, none of which main can see. Every other
     * action is the reverse: opening a URL goes through main's external-link
     * allowlist, and installing an update is main's by definition.
     *
     * The row used to stop at `session` and silently drop the rest, which was
     * correct while nothing produced the rest. `act` hands them back along the
     * same router a clicked desktop toast takes, so a row and a toast cannot come
     * to mean different things about one notification.
     */
    if (notif.action.type === 'session') {
      /**
       * Resolved to the row that terminal names **now**, not the row it named
       * when the notification was written.
       *
       * Notifications come from hooks, and hooks speak *terminal* ids — baked
       * into a pty's environment and never changed. A `/clear` in the meantime
       * retires the row that id pointed at, and `openEntity` refuses an ended
       * session by design (it belongs to the successor now). The click then did
       * the one thing it must never do: dropped the user on the orchestrator
       * instead of the live session the notification was actually about.
       *
       * `use-notification-activate` has resolved this for the **desktop toast**
       * all along. This row did not — so one notification meant two different
       * things depending on where it was clicked, which is exactly what the
       * comment below forbids.
       */
      openEntity(currentRowFor(notif.action.entityId));
      return;
    }
    if (notif.action.type === 'none') return;
    void window.hive?.notifications.act(notif.action);
  };

  const onClick = () => {
    // A second click during the exit must not act twice — the row is on its way
    // out and `pointer-events-none` below only covers the pointer, not the
    // keyboard.
    if (leaving) return;

    performAction();

    /**
     * Under `prefers-reduced-motion` the row simply goes.
     *
     * `global.css` already collapses animation durations under the query, so the
     * slide would not play anyway — but the timer would still hold the row on
     * screen for 220ms with nothing happening, which reads as lag rather than as
     * restraint.
     */
    if (reduced) {
      dismissNotif(notif.id);
      return;
    }

    /**
     * The card's own height, measured and handed to the keyframes.
     *
     * `max-height` cannot animate from `auto`, and a hard-coded start value would
     * either clip a two-line body or leave a taller card collapsing from a height
     * it never had. One `offsetHeight` read at click time is exact, and it is the
     * only layout read in the path.
     */
    const el = ref.current;
    if (el !== null) {
      el.style.setProperty('--cc-card-h', `${el.offsetHeight}px`);
    }
    setLeaving(true);
    exitTimer.current = setTimeout(() => dismissNotif(notif.id), CARD_EXIT_MS);
  };

  return (
    <button
      ref={ref}
      type="button"
      /*
        The card's identity in the DOM, the way `data-panel` and
        `data-terminal-id` are elsewhere. It exists because the list is a column
        of buttons and the panel now has a *header* button too: "every button in
        the inbox" stopped meaning "every card" the moment Clear all landed, and
        a test that counts rows should say which rows it means.
      */
      data-notification={notif.id}
      onClick={onClick}
      className={cn(
        'flex items-start gap-2.5 rounded-xl border px-3 py-[var(--cc-card-py)] text-left hover:bg-hover',
        notif.unread ? 'border-border bg-chip' : 'border-border-soft',
        /*
          The list's spacing lives here rather than as a parent `gap`, so it can
          collapse with the rest of the card on the way out. See `inbox-panel`.

          `overflow-hidden` so the contents clip as `max-height` closes instead of
          spilling past the shrinking border.
        */
        'mb-[var(--cc-list-gap-sm)] overflow-hidden last:mb-0',
        leaving && 'pointer-events-none animate-ccslideout',
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
