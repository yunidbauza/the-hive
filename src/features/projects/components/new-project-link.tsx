import { Plus } from '@phosphor-icons/react';

import { useAddProject } from '@hooks/use-add-project';

/** Which of the panel's two registers this control is drawn in. */
export type NewProjectVariant = 'line' | 'cta';

/**
 * One control, two registers — and nothing else differs between them.
 *
 * `line` is the ghost line above the tree: the same grammar as `new session`
 * one level down, quiet enough to sit above a list without competing with it.
 * `cta` is the empty state's button, where there is no list to compete with and
 * the only thing on screen worth pressing should look pressable.
 *
 * The border is where `cta` stops. A fill would make the loudest thing in a
 * 320px rail an apology for an empty list, which is the one thing
 * `EmptyState` says a rail must not do.
 */
const CLASSES: Record<NewProjectVariant, string> = {
  /*
    `mb-2.5` is the gap, not the panel's. The panel's own `gap-0.5` is the
    rhythm *between rows*, and this is not a row — reading it as one is exactly
    what 2px above `nova-web` made it look like.
  */
  line: 'mt-1 mb-2.5 flex items-center gap-2 rounded-lg px-2.5 py-[3px] text-left font-mono text-[11.5px] text-subtle hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-subtle',
  cta: 'inline-flex items-center gap-[7px] rounded-lg border border-border px-3 py-[5px] font-mono text-[11.5px] text-ink hover:bg-hover disabled:cursor-not-allowed disabled:hover:bg-transparent',
};

/**
 * Map another repository, from the rail, without a detour through Settings.
 *
 * The panel's sibling control, `NewSessionLink`, is the model: a quiet
 * monospace line with a plus, doing the obvious thing immediately rather than
 * opening something that asks the question the click already answered. This
 * one opens the OS directory chooser, which *is* the question — there is no
 * app-side form to fill in, because a project is a folder.
 *
 * ## Why it leads the tree and closes the empty state
 *
 * `new session` hangs *under* the project it belongs to, so it reads as the
 * last child of that subtree. This belongs to no project, and a list whose only
 * affordance is at the bottom hides it the moment the fleet is longer than the
 * rail. At the top it is in the same place whatever the tree is doing, which is
 * what a control that adds to the list needs to be.
 *
 * With no tree there is no list to lead, and leading anyway put it *above* the
 * sprite and the line explaining the emptiness — so the copy had to point back
 * up at it. The empty state renders it as `EmptyState`'s `control` instead:
 * sprite, flavour line, button, then the one thing the rail cannot do.
 *
 * ## Why the accessible name is not just "new project"
 *
 * The visible text stays lowercase to match `new session`, in both variants —
 * the border changes how loud the control is, not what it is called. The
 * `aria-label` spells out that this *adds* one, for a screen-reader user who
 * arrives here without the tree beneath it. It still contains the visible
 * words, which is WCAG's Label in Name — and it deliberately does not contain
 * "new session", so the substring locators that already have to disambiguate
 * that name are left alone.
 */
export function NewProjectLink({
  variant = 'line',
}: {
  variant?: NewProjectVariant;
}) {
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
      className={CLASSES[variant]}
    >
      <Plus size={11} weight="bold" aria-hidden="true" className="shrink-0" />
      new project
    </button>
  );
}
