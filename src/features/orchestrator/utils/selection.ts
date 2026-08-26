/**
 * Which fleet row the caret is on, given what the user has chosen and what the
 * fleet currently holds.
 *
 * `ui-store` holds an **entity id** rather than a position (see `selId` there):
 * the nav order is sorted by recency, so an index is a fact about the current
 * fleet and not about the caret, and a background spawn used to renumber every
 * row out from under a selection the user had not touched.
 *
 * That leaves two states this function exists to resolve, and they are not the
 * same state:
 *
 * - **`null` — nothing chosen yet.** A fresh launch. The caret shows on the
 *   first row and `→` opens it, which is what the table did when the selection
 *   was an index defaulting to `0`; an unset caret that pointed at nothing
 *   would make the documented `→` shortcut do nothing until an arrow key had
 *   been pressed.
 * - **A chosen id that is no longer in the fleet** — a row that ended and aged
 *   out past the cap. There is no fallback here on purpose: the user did choose
 *   something and it is gone, so the honest answer is no caret rather than
 *   silently moving their selection to a row they never picked. `↑`/`↓`
 *   recover from it (`console-input.tsx`), which is the gesture that means
 *   "somewhere else".
 *
 * Shared by the table and the command row because they must agree about where
 * "here" is — the same reason `useNavOrder` exists at all.
 */
export function effectiveSelId(
  selId: string | null,
  navOrder: readonly string[],
): string | null {
  return selId ?? navOrder[0] ?? null;
}
