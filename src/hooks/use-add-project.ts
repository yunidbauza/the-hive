import { useCallback, useState } from 'react';

import { addProjectToConfig, chooseProjectDirectory } from '@lib/project-config';

export interface AddProject {
  /**
   * Open the native directory chooser and map what comes back.
   *
   * Fire-and-forget: nothing a caller could do with the promise, since the
   * fresh snapshot arrives through the config subscription rather than as a
   * return value.
   */
  addProject: () => void;
  /** Whether a dialog is already open, so the control can refuse a second. */
  choosing: boolean;
}

/**
 * Map a directory as a project — the flow, without the button.
 *
 * Two surfaces offer it: Settings → Projects, and the projects rail. They owe
 * the user the same three things — one dialog per click, a write of exactly
 * the path the dialog returned, and nothing at all when it is closed — so the
 * flow lives here and the buttons are only buttons.
 *
 * `src/hooks/` rather than either slice: `features/settings/` and
 * `features/projects/` may not import each other, and this is the shape a fact
 * shared by two slices has to take.
 *
 * ## Why `choosing` is not a loading flag
 *
 * The dialog is modal to the window, so there is nothing to spin *over*. The
 * flag exists to stop a second `invoke` racing the first, which would open two
 * dialogs and write twice.
 */
export function useAddProject(): AddProject {
  const [choosing, setChoosing] = useState(false);

  const addProject = useCallback(() => {
    if (choosing) return;
    setChoosing(true);

    void (async () => {
      try {
        const path = await chooseProjectDirectory();
        // Cancelled, or no bridge to ask. Nothing to write, and nothing to
        // say: the user closed a dialog they opened.
        if (path === null) return;
        await addProjectToConfig({ path });
      } catch (cause) {
        /*
          `addProjectToConfig` cannot land here — the config module catches a
          refused write and keeps the last good snapshot. `chooseDirectory`
          can: it invokes main directly, so a broken channel rejects. Swallowed
          rather than rethrown because the caller is a click with no promise to
          reject into, and left unreported to the user because the thing they
          would be told is that a dialog they can simply reopen did not open.
        */
        console.error('[hive] the directory chooser failed:', cause);
      } finally {
        setChoosing(false);
      }
    })();
  }, [choosing]);

  return { addProject, choosing };
}
