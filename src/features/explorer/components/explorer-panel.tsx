import { useCallback } from 'react';

import { EmptyState, EmptyStatePath } from '@components/ui/empty-state';
import { Icon } from '@components/ui/icon';
import { TreeNode } from '@features/explorer/components/tree-node';
import { useDirectory } from '@features/explorer/hooks/use-directory';
import { useExplorerProject } from '@features/explorer/hooks/use-explorer-project';
import { useProjectAccess } from '@hooks/use-project-config';
import { baseName, hasFsBridge } from '@lib/explorer/fs-client';
import { useEditorLayout } from '@stores/appearance-store';
import { useEditorActions } from '@stores/editor-store';
import {
  useBumpFsRevision,
  useCollapseExplorer,
  useFsRevision,
} from '@stores/ui-store';

/**
 * Project explorer — the repository the active session is working in.
 *
 * Replaces the Activity feed as the right rail's third tab. The feed was
 * fixture data narrating events the app already shows elsewhere; this is the
 * one surface that answers "what is the agent actually changing", which is the
 * question a command center for agentic sessions exists to answer.
 *
 * This file is part of a feature slice and may not import `features/editor` —
 * the two talk through `editor-store`, which is exactly what the fence is for.
 *
 * ## The watcher does *not* live here
 *
 * It did, and that was a bug: the rail swaps panels and the shell can unmount
 * the rail entirely, so freshness died the moment the user looked at the Inbox
 * with a file open. `useProjectWatcher()` is mounted at the composition root
 * instead, and this panel reads the revision counter it bumps.
 */
export function ExplorerPanel() {
  const { project, root: subRoot } = useExplorerProject();
  const access = useProjectAccess(project?.id ?? '');
  const collapseAll = useCollapseExplorer();
  const { openFile, closeAll } = useEditorActions();
  const { nav } = useEditorLayout();

  /**
   * The shared filesystem revision. Every mounted directory node re-reads when
   * it changes — whether the watcher bumped it or the ↻ button did.
   */
  const refreshToken = useFsRevision();
  const refresh = useBumpFsRevision();

  /**
   * Read once per render, before the hooks that depend on it.
   *
   * Not reactive, and does not need to be: a preload bridge either exists when
   * the window loads or never does. It gates `usable` rather than only the
   * early return below, because the hooks run before that return — without it
   * the browser demo would fire a root read on every mount and throw the
   * `ENOBRIDGE` answer away.
   */
  const bridge = hasFsBridge();

  const projectId = project?.id ?? null;
  const usable = bridge && projectId !== null && access.spawnable;

  /**
   * Rooted at the session's own directory, which is the project root for every
   * session that has not moved (HIVE-78).
   */
  const root = useDirectory(projectId ?? '', subRoot, usable, refreshToken);

  const onOpenFile = useCallback(
    (relPath: string) => {
      if (projectId === null) return;
      /**
       * Single-file mode is applied *here*, not in the store.
       *
       * No store subscribes to another (`AGENTS.md`), and `editor-store` must
       * not read a preference out of `appearance-store` to decide how many
       * files it holds. So the policy lives where the setting is read: the
       * caller closes what was open before opening the next.
       */
      if (nav === 'single') closeAll();
      openFile(projectId, relPath);
    },
    [projectId, nav, closeAll, openFile],
  );

  /**
   * The browser demo, which has no bridge at all.
   *
   * Checked before the project, because "there is no filesystem here" is true
   * regardless of what the config says — and in the demo there is no config
   * either, so the projects list is empty and the message below would blame the
   * user for something they cannot fix.
   */
  if (!bridge) {
    return (
      <div data-panel="explorer" className="flex flex-col gap-0.5">
        <EmptyState>The project explorer needs the desktop app.</EmptyState>
      </div>
    );
  }

  if (!project) {
    return (
      <div data-panel="explorer" className="flex flex-col gap-0.5">
        <EmptyState
          action={
            <>
              Add one in <EmptyStatePath>Settings → Projects</EmptyStatePath>.
            </>
          }
        >
          No projects mapped.
        </EmptyState>
      </div>
    );
  }

  return (
    <div data-panel="explorer" className="flex min-h-0 flex-col">
      {/*
        The header names the repository and carries the two controls that act
        on the whole tree. It does not scroll with the tree: losing the refresh
        button behind a deep directory is losing the one control that fixes a
        tree you think is stale.
      */}
      <div className="mb-1 flex shrink-0 items-center gap-1.5 px-1">
        {/*
          The header says when the tree is *not* at the project root (HIVE-78).
          Silently showing a worktree's contents under the project's name is the
          same class of untruth this story removed from the branch label: the
          files would be right and the label would be wrong. The full relative
          path stays in the tooltip; the visible suffix is the last segment,
          because a 130px rail cannot carry `.claude/worktrees/…` and the
          worktree's own name is the part that identifies it.
        */}
        <span
          className="flex-1 truncate font-mono text-[11.5px] tracking-wide text-subtle uppercase"
          title={subRoot === '' ? project.name : `${project.name}/${subRoot}`}
        >
          {project.name}
          {subRoot === '' ? null : (
            <span className="text-muted"> · {baseName(subRoot)}</span>
          )}
        </span>

        <button
          type="button"
          onClick={refresh}
          title="Refresh"
          className="rounded-md p-1 text-subtle hover:bg-hover hover:text-muted"
        >
          <Icon name="ph-arrows-clockwise" size={13} />
          <span className="sr-only">Refresh the tree</span>
        </button>

        <button
          type="button"
          onClick={collapseAll}
          title="Collapse all"
          className="rounded-md p-1 text-subtle hover:bg-hover hover:text-muted"
        >
          <Icon name="ph-arrows-in-simple" size={13} />
          <span className="sr-only">Collapse every folder</span>
        </button>
      </div>

      {/*
        The project resolves but its directory does not. `access.reason` is the
        config's own verdict, which names the file to edit — a better message
        than anything this panel could compose, and the same one the projects
        tree shows for the same project.
      */}
      {!usable ? (
        <EmptyState>{access.reason ?? 'This project has no folder.'}</EmptyState>
      ) : null}

      {usable && root.error ? (
        <EmptyState>{root.error}</EmptyState>
      ) : null}

      {usable && !root.error && root.entries?.length === 0 ? (
        <EmptyState phrase="empty.explorer" creature="hive">This repository is empty.</EmptyState>
      ) : null}

      {usable
        ? root.entries?.map((entry) => (
            <TreeNode
              key={entry.name}
              projectId={project.id}
              entry={entry}
              /**
               * The prefix, so every path this tree produces stays
               * **project-relative** (HIVE-78) — `.claude/worktrees/x/src/a.ts`
               * rather than `src/a.ts`.
               *
               * That is what keeps the editor honest for free: two files with
               * the same path in two worktrees are two different keys in
               * `editor-store`, so opening one cannot mark the other stale, and
               * the fs guard resolves both under the same project root it
               * always did.
               */
              parentPath={subRoot}
              depth={0}
              refreshToken={refreshToken}
              onOpenFile={onOpenFile}
            />
          ))
        : null}
    </div>
  );
}
