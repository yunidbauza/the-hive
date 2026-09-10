import { useCallback, useEffect, useRef, useState } from 'react';

import { useRemoteCapabilities } from '@hooks/use-project-config';
import { chooseProjectDirectory } from '@lib/project-config';

export interface ChooseDirectory {
  /** Open whichever chooser is right for this window. */
  choose: () => void;
  /** Whether a native dialog is already open, so a second click is refused. */
  choosing: boolean;
  /** Whether the server-side picker should be open. The caller mounts it. */
  picking: boolean;
  /** Close the picker without choosing. */
  cancelPicking: () => void;
  /** A path the picker returned. */
  onPicked: (path: string) => void;
}

/**
 * Ask the user for a directory, from whichever machine actually holds it
 * (HIVE-146).
 *
 * Three surfaces need this and all three used to be dead while attached:
 * mapping a project, repointing one that moved, and choosing where a clone
 * lands. Each one asked `config:choose-directory`, which is `WINDOW_BOUND` —
 * the dialog needs a parent window and a server has none — so each one
 * rendered a disabled button with the same borrowed reason string.
 *
 * They are all the same question, so the branch lives here once rather than
 * three times: the native dialog when this window is local, the server-side
 * picker when it is attached.
 *
 * ## Why the paths are equivalent, in all three cases
 *
 * Every one of them names a directory on the machine that will *use* it. A
 * project's files, a repointed project's new location and a clone's
 * destination all live wherever the sessions run, which while attached is the
 * server. So the picker is not a lesser substitute for the dialog here — it is
 * the one that asks the right machine.
 *
 * ## Why `onChosen` is held in a ref
 *
 * Callers pass an inline arrow, so a plain dependency would rebuild `choose`
 * on every render and defeat the memo. The ref is refreshed in an effect, so
 * the callback that runs is always the latest one without the identity of
 * `choose` depending on it.
 */
export function useChooseDirectory(
  onChosen: (path: string) => void | Promise<void>,
): ChooseDirectory {
  const [choosing, setChoosing] = useState(false);
  const [picking, setPicking] = useState(false);
  const { chooseDirectory } = useRemoteCapabilities();

  const chosen = useRef(onChosen);
  useEffect(() => {
    chosen.current = onChosen;
  }, [onChosen]);

  /**
   * Both paths funnel through here, so a caller's write cannot behave
   * differently depending on which chooser produced the path.
   */
  const deliver = useCallback(async (path: string) => {
    try {
      await chosen.current(path);
    } catch (cause) {
      /*
        The caller is a click with no promise to reject into. The config
        module already swallows a refused write and keeps the last good
        snapshot, so what reaches here is a broken IPC hop — logged rather
        than shown, because what the user would be told is that a chooser
        they can simply reopen did not work.
      */
      console.error('[hive] choosing a directory failed:', cause);
    }
  }, []);

  const choose = useCallback(() => {
    if (!chooseDirectory) {
      setPicking(true);
      return;
    }
    if (choosing) return;
    setChoosing(true);

    void (async () => {
      try {
        const path = await chooseProjectDirectory();
        // Cancelled, or no bridge to ask. Nothing to write, and nothing to
        // say: the user closed a dialog they opened.
        if (path === null) return;
        await deliver(path);
      } catch (cause) {
        console.error('[hive] the directory chooser failed:', cause);
      } finally {
        setChoosing(false);
      }
    })();
  }, [choosing, chooseDirectory, deliver]);

  const cancelPicking = useCallback(() => setPicking(false), []);

  const onPicked = useCallback(
    (path: string) => {
      setPicking(false);
      void deliver(path);
    },
    [deliver],
  );

  return { choose, choosing, picking, cancelPicking, onPicked };
}
