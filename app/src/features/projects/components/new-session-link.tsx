import { Plus } from '@phosphor-icons/react';

import { useProjectAccess } from '@hooks/use-project-config';
import { useSpawnSession } from '@stores/hive-store';
import { useNewSessionDefaults } from '@stores/ui-store';

interface NewSessionLinkProps {
  projectId: string;
}

/**
 * Start a session in this project, from the tree, without the picker.
 *
 * The header's "New session" button opens the picker so the user can choose a
 * project; here the project is already named by the row above, so the picker
 * would only ask a question the click already answered. This spawns straight
 * away on the current defaults.
 *
 * ## Why the accessible name says more than the visible text
 *
 * The visible label is `new session` — enough beside the folder row it hangs
 * under, and not enough for a screen-reader user who arrives at the button
 * without that row. The `aria-label` names the project too, and still contains
 * the visible text, which is what WCAG's Label in Name asks for.
 *
 * It does **not** make the button unambiguous to a locator: Playwright matches
 * accessible names as a case-insensitive substring, so `New session` finds the
 * header button and every link here. The fix belongs in the queries, and
 * `tests/e2e/electron/` passes `exact: true` where it means the header. Naming
 * this button something that does not contain "new session" would buy loose
 * locators at the cost of the visible label no longer being in the name.
 *
 * ## Why the disabled state carries no extra guard
 *
 * `new-session-picker.tsx` re-checks `can.spawnSessionIn` before spawning
 * because its search box spawns on Enter, which never touches a disabled
 * button. This link has one path in, and `disabled` closes it — a second check
 * here would be a branch nothing can reach.
 */
export function NewSessionLink({ projectId }: NewSessionLinkProps) {
  const access = useProjectAccess(projectId);
  const spawnSession = useSpawnSession();
  const { newModel, newEffort } = useNewSessionDefaults();

  return (
    <button
      type="button"
      // Empty task, exactly as the picker passes: the session opens ready and
      // the first message gives it its job (story 043).
      onClick={() => spawnSession(projectId, '', newModel, newEffort)}
      disabled={!access.spawnable}
      /*
        The refusal when there is one; otherwise what the click is about to
        commit to.

        This control spends a choice the user cannot see from here — the
        picker's steppers are the source, and the picker is not open. Naming
        the pair costs a tooltip and removes the only thing the picker offered
        that this does not: sight of the model before you start on it.
      */
      title={access.reason ?? `Starts on ${newModel} · ${newEffort}`}
      aria-label={`New session in ${projectId}`}
      className="flex items-center gap-1.5 rounded-lg py-[3px] pr-2.5 pl-[26px] text-left font-mono text-[11.5px] text-subtle hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-subtle"
    >
      <Plus size={10} weight="bold" aria-hidden="true" className="shrink-0" />
      new session
    </button>
  );
}
