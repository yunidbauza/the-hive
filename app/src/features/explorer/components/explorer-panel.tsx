import { useCallback, useEffect, useState } from 'react';

import { EmptyState, EmptyStatePath } from '@components/ui/empty-state';
import { Icon } from '@components/ui/icon';
import { TreeNode } from '@features/explorer/components/tree-node';
import { useDirectory } from '@features/explorer/hooks/use-directory';
import { useExplorerProject } from '@features/explorer/hooks/use-explorer-project';
import { useProjectAccess } from '@hooks/use-project-config';
import {
  hasFsBridge,
  onFsChanged,
  unwatchProject,
  watchProject,
} from '@lib/explorer/fs-client';
import { useEditorLayout } from '@stores/appearance-store';
import { useEditorActions, useEditorStore } from '@stores/editor-store';
import { useCollapseExplorer } from '@stores/ui-store';

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
 * ## The watcher lives here
 *
 * One subscription and one watcher, for the visible project, torn down when the
 * project changes or the panel unmounts. Here rather than at the composition
 * root — unlike `useSessionStatus`, which is app-wide — because the thing being
 * watched *is* what this panel is showing. A watcher outliving the panel would
 * hold an `FSEvents` stream over a repository nobody is looking at.
 */
export function ExplorerPanel() {
  const project = useExplorerProject();
  const access = useProjectAccess(project?.id ?? '');
  const collapseAll = useCollapseExplorer();
  const { openFile, closeAll } = useEditorActions();
  const { nav } = useEditorLayout();

  /**
   * Bumped by the watcher and by ↻. Every mounted directory node re-reads.
   *
   * A counter rather than a timestamp: two events in the same millisecond must
   * still be two refreshes, and `Date.now()` would collapse them.
   */
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  const projectId = project?.id ?? null;
  const usable = projectId !== null && access.spawnable;

  const root = useDirectory(projectId ?? '', '', usable, refreshToken);

  useEffect(() => {
    if (!usable || projectId === null) return;

    let live = true;
    void watchProject(projectId);

    const stop = onFsChanged((event) => {
      if (!live || event.projectId !== projectId) return;
      refresh();
      /**
       * The store is reached through `getState()` here rather than a hook, and
       * this is the one place in the app that does it.
       *
       * `reconcile` is called from inside a subscription callback, not from a
       * render — there is no component to re-render on and nothing to
       * subscribe to. Taking it as a hook would subscribe this panel to the
       * editor store and re-render the whole tree every time a buffer changed,
       * which is precisely what the store split exists to prevent.
       */
      useEditorStore.getState().reconcile(event.projectId, event.paths);
    });

    return () => {
      live = false;
      stop();
      void unwatchProject();
    };
  }, [usable, projectId, refresh]);

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
  if (!hasFsBridge()) {
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
        <span className="flex-1 truncate font-mono text-[11.5px] tracking-wide text-subtle uppercase">
          {project.name}
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
        <EmptyState>This repository is empty.</EmptyState>
      ) : null}

      {usable
        ? root.entries?.map((entry) => (
            <TreeNode
              key={entry.name}
              projectId={project.id}
              entry={entry}
              parentPath=""
              depth={0}
              refreshToken={refreshToken}
              onOpenFile={onOpenFile}
            />
          ))
        : null}
    </div>
  );
}
