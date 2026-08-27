import { createContext, useContext } from 'react';

/**
 * Whether the surrounding markup is a provider band.
 *
 * ## Why this is context and not a prop
 *
 * `SettingsGroup` behaves differently inside a `SettingsProviderGroup`: it draws
 * no rule, drops its bottom padding, and renders its title as `h4` rather than
 * `h3`. Those three are one fact — "something already contains me" — and the
 * first version of this shipped them as a `nested` boolean each caller passed.
 *
 * That made the invariant a convention. Three components hard-coded
 * `nested`, which is correct only for as long as they are used nowhere but the
 * Jira band; the day one is reused in a plain pane it renders `h2 → h4` and
 * nothing — not a test, not the linter, not the type — says so. And a group
 * added to a band without the prop draws a rule the band exists to remove.
 *
 * Context makes it structural instead: nesting is decided by *where a group is
 * rendered*, which is the thing it was always meant to describe. There is no
 * prop to forget, none to pass wrongly, and a group moved between panes gets
 * the right answer by being moved.
 *
 * Default `false`, so a group rendered anywhere else is a top-level group —
 * which is what every pane but Integrations has.
 */
export const SettingsNestingContext = createContext(false);

/** True when this group sits inside a provider band. */
export function useIsNestedGroup(): boolean {
  return useContext(SettingsNestingContext);
}
