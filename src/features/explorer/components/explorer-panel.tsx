import { useCallback } from 'react';

import { EmptyState, EmptyStatePath } from '@components/ui/empty-state';
import { Icon } from '@components/ui/icon';
import { TreeNode } from '@features/explorer/components/tree-node';
import { useDirectory } from '@features/explorer/hooks/use-directory';
import { useExplorerProject } from '@features/explorer/hooks/use-explorer-project';
import { useExplorerRoot } from '@features/explorer/hooks/use-explorer-root';
import { useProjectAccess } from '@hooks/use-project-config';
import { hasFsBridge } from '@lib/explorer/fs-client';
import { useEditorLayout } from '@stores/appearance-store';
import { useEditorActions } from '@stores/editor-store';
import { useProjects } from '@stores/hive-store';
import {
  useBumpFsRevision,
  useCollapseExplorer,
  useFsRevision,
  useRevealStage,
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
  const { project, root: subRoot, sessionId, display, branch } = useExplorerProject();
  /**
   * Main's verdict on which tree the reads below actually resolve under.
   *
   * `null` until it answers. The header and the buffer key both depend on it,
   * and both were wrong while the renderer inferred it — see `useExplorerRoot`.
   */
  const explorerRoot = useExplorerRoot(project?.id ?? null, sessionId);
  // Only to tell the two empty states apart — see the branch below.
  const projects = useProjects();
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
  /*
    `explorerRoot === null` is "main has not said yet", and reading before then
    would open buffers keyed against a root we are guessing at. One round trip,
    once per session change.
  */
  const usable =
    bridge && projectId !== null && access.spawnable && explorerRoot !== null;

  /**
   * Rooted at the session's own directory, which is the project root for every
   * session that has not moved (HIVE-78).
   */
  const root = useDirectory(
    projectId ?? '',
    subRoot,
    usable,
    refreshToken,
    sessionId,
  );
  const revealStage = useRevealStage();

  /**
   * The worktree name the header speaks, or `''` for the project root.
   *
   * Two sources, because there are two mechanisms and only one of them needs
   * main's permission. An **in-project** worktree is reached by a prefix this
   * panel prepends, so `display.suffix` is authoritative — main resolves the
   * same path by construction. An **out-of-project** one is a second root main
   * had to grant, so nothing may be said about it until main says `widened`.
   */
  const rootSuffix =
    explorerRoot?.widened === true
      ? (explorerRoot.path.split('/').pop() ?? '')
      : subRoot === ''
        ? ''
        : display.suffix;

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
      openFile(projectId, relPath, sessionId, explorerRoot?.key ?? '');
      /**
       * The rail is clickable behind a full-stage overlay now, so a file opened
       * from here would otherwise land *behind* settings or the picker: the row
       * highlights, the stage does not move, and the editor only turns up when
       * the overlay is dismissed by hand. Opening a file is a request to look
       * at it.
       */
      revealStage();
    },
    [projectId, sessionId, explorerRoot, nav, closeAll, openFile, revealStage],
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

  /**
   * Two different reasons for an empty tree, and they need different sentences
   * (HIVE-93).
   *
   * `useExplorerProject` now answers `null` whenever the stage is not showing a
   * session with a mapped project — the overmind tab, an agent tab, a session
   * whose project was removed from the config. Blaming that on "no projects
   * mapped" would be false in the common case and would send the user to
   * Settings to fix something that is not broken.
   *
   * So the config is asked first: nothing mapped is a setup problem with a
   * destination, and anything else is simply "you are not in a session", whose
   * way out is to open one.
   */
  if (!project) {
    return (
      <div data-panel="explorer" className="flex flex-col gap-0.5">
        {projects.length === 0 ? (
          <EmptyState
            action={
              <>
                Add one in <EmptyStatePath>Settings → Projects</EmptyStatePath>.
              </>
            }
          >
            No projects mapped.
          </EmptyState>
        ) : (
          <EmptyState
            phrase="empty.explorer"
            creature="hive"
            action="Open one from the fleet, or start a new session."
          >
            No session open — the explorer follows the session you are watching.
          </EmptyState>
        )}
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
          files would be right and the label would be wrong. The full path stays
          in the tooltip; the visible suffix is the last segment, because a
          268px rail cannot carry `.claude/worktrees/…` and the worktree's own
          name is the part that identifies it.

          `display`, not `subRoot`. The prefix is `''` for two situations that
          must not read the same — a session at the project root, and one
          working in a worktree kept *outside* the project, which is now a root
          main resolves rather than a prefix this panel prepends. Reading the
          suffix off the prefix meant the second case rendered as the first: the
          bare project name over a tree that was not the project's.
        */}
        {/*
          `explorerRoot`, not `display`, decides whether a worktree is named.

          `display` is derived from the session's cwd, which is what the
          *renderer* knows — and main widens the root only for a cwd it has
          proved is a registered worktree of this project. When that proof
          fails, main serves the project root while `display` still had a
          worktree's name for it: the right label over the wrong files, which is
          the untruth this header exists to prevent, inverted.

          So the suffix is spoken only when main says the tree really is
          somewhere else. The in-project case keeps `display`, because there the
          prefix is the renderer's own and main honours it by construction.
        */}
        <span
          className="flex-1 truncate font-mono text-[11.5px] tracking-wide text-subtle uppercase"
          title={
            explorerRoot?.widened === true
              ? explorerRoot.path
              : (display.full ?? project.name)
          }
        >
          {project.name}
          {rootSuffix === '' ? null : (
            <span className="text-muted"> · {rootSuffix}</span>
          )}
        </span>

        {/*
          The branch, when one has been observed.

          Not decoration: the two questions a user asks of a file tree
          mid-session are *which directory* and *which branch*, and the panel
          could answer neither. `branchLabel`'s em dash is deliberately not used
          here — the rail already prints it in the session meta bar, and a
          second em dash in a 268px column is noise rather than an answer.
        */}
        {branch === undefined ? null : (
          <span
            className="max-w-[110px] shrink-0 truncate rounded-full border border-border bg-chip px-1.5 py-px font-mono text-[9.5px] text-brand"
            title={`On branch ${branch}`}
          >
            {branch}
          </span>
        )}

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
              sessionId={sessionId}
              rootKey={explorerRoot?.key ?? ''}
              onOpenFile={onOpenFile}
            />
          ))
        : null}
    </div>
  );
}
