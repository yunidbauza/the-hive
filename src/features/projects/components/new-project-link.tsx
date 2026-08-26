import { Plus } from '@phosphor-icons/react';

import { useAddProject } from '@hooks/use-add-project';

/**
 * Map another repository, from the rail, without a detour through Settings.
 *
 * The panel's sibling control, `NewSessionLink`, is the model: a quiet
 * monospace line with a plus, doing the obvious thing immediately rather than
 * opening something that asks the question the click already answered. This
 * one opens the OS directory chooser, which *is* the question — there is no
 * app-side form to fill in, because a project is a folder.
 *
 * ## Why it leads the panel rather than closing it
 *
 * `new session` hangs *under* the project it belongs to, so it reads as the
 * last child of that subtree. This belongs to no project, and a list whose
 * only affordance is at the bottom hides it the moment the fleet is longer
 * than the rail. At the top it is in the same place whatever the tree is
 * doing, which is what a control that adds to the list needs to be.
 *
 * ## Why the accessible name is not just "new project"
 *
 * The visible text stays lowercase to match `new session`; the `aria-label`
 * spells out that this *adds* one, for a screen-reader user who arrives here
 * without the tree beneath it. It still contains the visible words, which is
 * WCAG's Label in Name — and it deliberately does not contain "new session",
 * so the substring locators that already have to disambiguate that name are
 * left alone.
 */
export function NewProjectLink() {
  const { addProject, choosing } = useAddProject();

  return (
    <button
      type="button"
      onClick={addProject}
      disabled={choosing}
      /*
        What the click opens, named as the OS thing it is. There is no refusal
        state to report here the way `NewSessionLink` has one: mapping a folder
        is the act that *creates* the access every other control checks.
      */
      title="Choose a folder to map as a project"
      aria-label="Add a new project"
      className="mt-1 flex items-center gap-2 rounded-lg px-2.5 py-[3px] text-left font-mono text-[11.5px] text-subtle hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-subtle"
    >
      <Plus size={11} weight="bold" aria-hidden="true" className="shrink-0" />
      new project
    </button>
  );
}
