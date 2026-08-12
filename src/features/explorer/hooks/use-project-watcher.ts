import { useEffect } from 'react';

import { useExplorerProject } from '@features/explorer/hooks/use-explorer-project';
import { useProjectAccess } from '@hooks/use-project-config';
import {
  onFsChanged,
  unwatchProject,
  watchProject,
} from '@lib/explorer/fs-client';
import { useReconcileFiles } from '@stores/editor-store';
import { useBumpFsRevision } from '@stores/ui-store';

/**
 * Watch the visible project, and route its changes to both consumers.
 *
 * ## Why this is not inside `ExplorerPanel`
 *
 * It was, and that was a bug. The rail swaps `PANELS[railTab]` and the shell
 * unmounts the rail entirely on `showActivityRail`, so the watcher's lifetime
 * was "the explorer tab is the one on screen". Switch to Inbox with a file open
 * and freshness stopped dead: no silent reload, no `staleOnDisk`, and the next
 * save failed with a conflict the user was never warned about.
 *
 * The tree is only *one* consumer of these events. The editor is the other, it
 * lives on the centre stage, and it outlives the panel — so the subscription
 * belongs at the composition root, alongside `useSessionStatus` and for the
 * same reason: one broadcast channel, one listener, mounted where both readers
 * can be reached.
 *
 * ## Two outputs, one event
 *
 * `bumpFsRevision()` tells the tree to re-read its expanded directories.
 * `reconcile()` tells the editor to reload clean buffers and flag dirty ones.
 * They are deliberately separate: the tree can be unmounted while a file is
 * open, and a file can be open with no tree ever having been shown.
 */
export function useProjectWatcher(): void {
  /**
   * The **project**, not the subdirectory (HIVE-78).
   *
   * `useExplorerProject` also answers where in the project the tree is rooted,
   * and this deliberately ignores it: main watches a whole project and reports
   * project-relative paths, so a watcher narrowed to a worktree would stop
   * reporting changes to files the editor still has open from outside it.
   * Widening what is watched costs nothing here — `reconcile` already filters
   * by path, and the tree re-reads only its expanded directories.
   */
  const { project } = useExplorerProject();
  const access = useProjectAccess(project?.id ?? '');
  const bumpFsRevision = useBumpFsRevision();
  const reconcile = useReconcileFiles();

  const projectId = project?.id ?? null;
  const watchable = projectId !== null && access.spawnable;

  useEffect(() => {
    if (!watchable || projectId === null) return;

    let live = true;
    void watchProject(projectId);

    const stop = onFsChanged((event) => {
      if (!live || event.projectId !== projectId) return;
      bumpFsRevision();
      reconcile(event.projectId, event.paths);
    });

    return () => {
      live = false;
      stop();
      void unwatchProject();
    };
  }, [watchable, projectId, bumpFsRevision, reconcile]);
}
