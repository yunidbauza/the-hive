import { useCallback } from 'react';

import { useChooseDirectory } from '@hooks/use-choose-directory';
import { addProjectToConfig } from '@lib/project-config';

export interface AddProject {
  /**
   * Map a directory as a project.
   *
   * Opens the native dialog locally, or the server-side picker while attached.
   * Fire-and-forget in both cases: the fresh snapshot arrives through the
   * config subscription rather than as a return value, so there is nothing a
   * caller could do with a promise.
   */
  addProject: () => void;
  /** Whether a native dialog is already open, so the control can refuse a second. */
  choosing: boolean;
  /**
   * Whether the server-side picker should be open (HIVE-146).
   *
   * The caller mounts `DirectoryPicker` on this. It replaced a
   * `disabledReason`, and that is the whole shape of the change: while attached
   * there is now something the button can do, so a disabled control would be
   * wrong rather than honest.
   */
  picking: boolean;
  /** Close the picker without choosing. */
  cancelPicking: () => void;
  /** A path the picker returned. Writes it, then closes. */
  onPicked: (path: string) => void;
}

/**
 * Map a directory as a project — the flow, without the button.
 *
 * Two surfaces offer it: Settings → Projects, and the projects rail. They owe
 * the user the same three things — one chooser per click, a write of exactly
 * the path that came back, and nothing at all when it is dismissed — so the
 * flow lives here and the buttons are only buttons.
 *
 * `src/hooks/` rather than either slice: `features/settings/` and
 * `features/projects/` may not import each other, and this is the shape a fact
 * shared by two slices has to take. `DirectoryPicker` lives in
 * `features/shared/components/` for the same reason.
 *
 * Which chooser opens is {@link useChooseDirectory}'s decision, shared with
 * repointing a project and choosing a clone's destination. All this adds is
 * what to do with the path.
 */
export function useAddProject(): AddProject {
  const write = useCallback((path: string) => addProjectToConfig({ path }), []);
  const { choose, choosing, picking, cancelPicking, onPicked } =
    useChooseDirectory(write);

  // No context to carry: there is only one thing being added.
  const addProject = useCallback(() => choose(), [choose]);

  return { addProject, choosing, picking, cancelPicking, onPicked };
}
