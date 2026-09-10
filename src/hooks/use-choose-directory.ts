import { useCallback, useEffect, useRef, useState } from 'react';

import { useRemoteCapabilities } from '@hooks/use-project-config';
import { chooseProjectDirectory } from '@lib/project-config';

export interface ChooseDirectory<T> {
  /**
   * Open whichever chooser is right for this window.
   *
   * `context` is handed straight back to `onChosen` when a path arrives. It
   * exists so a caller with more than one thing to choose *for* — the projects
   * list, whose rows share one picker — never has to read which row it was off
   * component state. See the hook's own doc for why that distinction matters.
   */
  choose: (context: T) => void;
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
 * ## Why the context travels rather than being read back off state
 *
 * The projects list mounts **one** picker for every row, so when a path
 * arrives it has to know which project was being repointed. Reading that from
 * component state is the obvious shape and it is wrong twice over.
 *
 * `onRepoint` does `setRepointing(id)` and calls `choose()` in the same event
 * handler, so `choose` runs *before* the render that carries the new id — the
 * callback it would reach closes over the previous value. And `onChosen` is
 * held in a ref refreshed by a **passive** effect, which React schedules on a
 * macrotask; the native-dialog branch resolves on a microtask, so it can run
 * before that refresh lands and reach the previous render's callback anyway.
 *
 * Neither is reachable today — a native dialog is seconds of human time, and
 * the picker branch commits many times before a path arrives — but the only
 * thing standing between those two races and a config write against the wrong
 * project is latency. Passing the id in at the click and back out with the
 * path removes the class rather than the instance.
 *
 * `onChosen` stays in a ref for a separate reason: callers pass inline arrows,
 * so a plain dependency would rebuild `choose` every render and defeat the
 * memo.
 */
export function useChooseDirectory<T = void>(
  onChosen: (path: string, context: T) => void | Promise<void>,
): ChooseDirectory<T> {
  const [choosing, setChoosing] = useState(false);
  const [picking, setPicking] = useState(false);
  const { chooseDirectory } = useRemoteCapabilities();

  const chosen = useRef(onChosen);
  useEffect(() => {
    chosen.current = onChosen;
  }, [onChosen]);

  /** What the in-flight choice is for, captured at the click that started it. */
  const context = useRef<T | null>(null);

  /**
   * Both paths funnel through here, so a caller's write cannot behave
   * differently depending on which chooser produced the path.
   */
  const deliver = useCallback(async (path: string) => {
    const held = context.current;
    context.current = null;
    if (held === null) return;
    try {
      await chosen.current(path, held);
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

  const choose = useCallback(
    (forContext: T) => {
      if (!chooseDirectory) {
        context.current = forContext;
        setPicking(true);
        return;
      }
      if (choosing) return;
      context.current = forContext;
      setChoosing(true);

      void (async () => {
        try {
          const path = await chooseProjectDirectory();
          // Cancelled, or no bridge to ask. Nothing to write, and nothing to
          // say: the user closed a dialog they opened.
          if (path === null) {
            context.current = null;
            return;
          }
          await deliver(path);
        } catch (cause) {
          context.current = null;
          console.error('[hive] the directory chooser failed:', cause);
        } finally {
          setChoosing(false);
        }
      })();
    },
    [choosing, chooseDirectory, deliver],
  );

  /** Dismissing the picker drops what it was for, or the next open inherits it. */
  const cancelPicking = useCallback(() => {
    context.current = null;
    setPicking(false);
  }, []);

  const onPicked = useCallback(
    (path: string) => {
      setPicking(false);
      void deliver(path);
    },
    [deliver],
  );

  return { choose, choosing, picking, cancelPicking, onPicked };
}
