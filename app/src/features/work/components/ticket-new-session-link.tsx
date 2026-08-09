import { Plus } from '@phosphor-icons/react';

import { usePickerActions } from '@stores/ui-store';

interface TicketNewSessionLinkProps {
  ticketKey: string;
}

/**
 * Start a session for this ticket (HIVE-73).
 *
 * ## Why this opens the picker rather than spawning
 *
 * A ticket names no project. A Jira issue has no idea which of the user's
 * repositories it will be worked in, and the same issue can legitimately be
 * worked in two — so the click here *is* a question, and the picker is where it
 * gets asked, along with model and thinking effort, which the user may well
 * want to set differently for a ticket than for a scratch session.
 *
 * A start affordance hung off a row that *does* name its project could spawn
 * straight away instead, since the picker would only ask what the click had
 * already answered. That is the shape a projects-tree equivalent would take;
 * none exists on this branch.
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
