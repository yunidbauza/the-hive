import type { Ticket } from '@/types/ticket';

/**
 * Colour by Jira's own category, never by the status *name* (HIVE-69).
 *
 * This map was keyed on a four-literal union until the `Ticket` widening, which
 * is precisely why the widening had to happen: real statuses are per-workflow
 * and arbitrary, so a project with "Blocked", "In QA" or "Awaiting deploy" would
 * have had no entry here and rendered unstyled — or, worse, been mapped onto one
 * of the four and told the user something false.
 *
 * Three buckets is the whole set, because `statusCategory` is
 * `new | indeterminate | done` at the source. Jira uses the same field to colour
 * its own lozenge, so this agrees with what the user sees in Jira and there is
 * no table to maintain as workflows change.
 *
 * ## Why it lives here rather than on the card
 *
 * The status lozenge is now the transition menu's **trigger**, so two components
 * paint it: `ticket-card.tsx` for a fixture with no Jira behind it, and
 * `ticket-transition-menu.tsx` for a real issue. A second copy of this map is
 * exactly the drift that would make a fixture and a real ticket render the same
 * status in different colours.
 */
export const CATEGORY_TEXT: Record<Ticket['statusCategory'], string> = {
  todo: 'text-subtle',
  'in-progress': 'text-brand',
  done: 'text-green',
};

/**
 * The lozenge's own shape, shared for the same reason the colours are.
 *
 * Layout only — no colour — so the two callers compose it with
 * {@link CATEGORY_TEXT} and, in the interactive case, a hover fill. Keeping the
 * padding and tracking in one place is what makes the interactive pill and the
 * inert one the same size, which matters because a card can hold either and a
 * 2px difference between them reads as a rendering bug.
 */
export const STATUS_PILL =
  'shrink-0 rounded-full bg-chip px-[9px] py-0.5 text-[10px] font-bold uppercase tracking-[0.05em]';
