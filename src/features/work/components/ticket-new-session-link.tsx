import { Plus } from '@phosphor-icons/react';

import { usePickerActions } from '@stores/ui-store';

interface TicketNewSessionLinkProps {
  ticketKey: string;
}

/**
 * Start a session for this ticket (HIVE-73).
 *
 * ## Why this opens the picker and the projects-tree link does not
 *
 * `features/projects`' `NewSessionLink` spawns immediately, because the row
 * above it already names the project — the picker would only ask a question the
 * click had answered. A ticket names no project at all: a Jira issue has no
 * idea which of the user's repositories it will be worked in, and the same
 * issue can legitimately be worked in two. So the click here *is* a question,
 * and the picker is where it gets asked — along with model and thinking effort,
 * which the user may well want to set differently for a ticket than for a
 * scratch session.
 *
 * The two links are therefore siblings in intent and opposites in mechanism,
 * which is why neither delegates to the other.
 *
 * ## Why it reaches the picker through the store
 *
 * `features/work` may not import from `features/sessions` — the ESLint zones
 * forbid it and `pnpm verify:boundaries` proves the fence still fires. So this
 * sets a flag in `ui-store` and the picker, mounted at the composition root,
 * reads it. The two slices never learn about each other.
 *
 * ## Why the accessible name is not the visible text
 *
 * `new session` matches the header button's name case-insensitively, and
 * `tests/e2e/electron/fixtures/hive-app.ts` drives the picker with
 * `getByRole('button', { name: 'New session' })`. Naming the ticket keeps that
 * query pointed at one control, and is the better announcement besides: a
 * screen-reader user arriving here out of context cannot see the card above it.
 */
export function TicketNewSessionLink({ ticketKey }: TicketNewSessionLinkProps) {
  const { openPicker } = usePickerActions();

  return (
    <button
      type="button"
      onClick={() => openPicker(ticketKey)}
      aria-label={`New session for ${ticketKey}`}
      className="-mx-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-[3px] text-left font-mono text-[11.5px] text-subtle hover:bg-hover hover:text-ink"
    >
      <Plus size={10} weight="bold" aria-hidden="true" className="shrink-0" />
      new session
    </button>
  );
}
