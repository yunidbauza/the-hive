import { useClearNotifs } from '@stores/hive-store';

interface InboxHeaderProps {
  /** How many rows are in the list. Never zero — the panel returns early. */
  total: number;
  /** How many of those are unread. */
  unread: number;
}

/**
 * The row above the inbox list: what is in it, and the one way to empty it.
 *
 * ## Why the count shares the row
 *
 * A bare `Clear all` floating over a list is a toolbar, and a toolbar in a
 * 268px column has to earn its height twice over. Pairing the action with the
 * count it acts on turns the same 22 pixels into a **list header** — it reports
 * before it offers, which is the order every other panel in the rail uses.
 *
 * The unread half is only spoken when there is one. "7 notifications · 0
 * unread" is a sentence about nothing; the tab's red badge is already the
 * surface that answers "how much of this is new", and repeating a zero here
 * would make the row argue with a badge that is simply absent.
 *
 * ## No confirmation, and no undo
 *
 * Decided rather than defaulted. A notification is a **pointer** — the session
 * it names, the PR, the ticket — and every one of those is reachable from a
 * surface that is not the inbox. Clearing destroys the reminder and nothing
 * else, so the cost of a mis-click is one trip to another tab, which is less
 * than the cost of a confirm step on the gesture whose entire value is being
 * fast.
 *
 * That reasoning is exactly why this row does **not** also offer "mark all
 * read": the header bell stopped doing that deliberately (HIVE-93), and a
 * second bulk verb here would reintroduce it through the back door.
 */
export function InboxHeader({ total, unread }: InboxHeaderProps) {
  const clearNotifs = useClearNotifs();

  return (
    <div className="flex items-center justify-between gap-2 pb-2">
      {/*
        `tabular-nums` so the count does not reflow the row as notifications
        land — this line updates while the user is reading it.
      */}
      <span className="text-[11px] tabular-nums text-subtle">
        {total === 1 ? '1 notification' : `${String(total)} notifications`}
        {unread > 0 ? ` · ${String(unread)} unread` : ''}
      </span>

      <button
        type="button"
        onClick={clearNotifs}
        className="shrink-0 rounded-[5px] px-1.5 py-0.5 text-[11px] text-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        Clear all
      </button>
    </div>
  );
}
