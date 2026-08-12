import { useEffect } from 'react';

import { relativeRoot } from '@/lib/explorer/session-root';
import { isSession, type ProjectRow } from '@/types/entity';

import { useProjectPath } from '@hooks/use-project-config';
import { useActiveEntity, useProjects } from '@stores/hive-store';
import { useExplorerProjectId, useSetExplorerProjectId } from '@stores/ui-store';

/**
 * Which repository the explorer is showing — and, since HIVE-78, **where in
 * it**.
 *
 * The rule for the project, in order:
 *
 * 1. **The active session's project.** This is the whole model — the app is
 *    organised around "which session am I watching", the session already names
 *    its project, and a second selector would be one more thing to keep in sync
 *    with the first.
 * 2. **The last one it was rooted at**, for the orchestrator tab and for agent
 *    tabs, neither of which names a project. Without this, every trip to the
 *    orchestrator would yank the tree back to the first mapped project — once
 *    per navigation, on a panel the user was reading.
 * 3. **The first mapped project**, on a cold start where neither of the above
 *    has an answer.
 *
 * The sticky value is written as a side effect rather than during render,
 * because a `set` during render is a React warning and, more to the point, this
 * is a *record of where the user has been* — which is exactly the kind of thing
 * that belongs after the paint rather than in it.
 *
 * ## The subdirectory
 *
 * A session whose agent moved into a worktree is editing files under
 * `<project>/.claude/worktrees/<name>`, and a tree rooted at the project shows
 * the wrong ones. `root` is the project-relative prefix that fixes it — `''`
 * for the ordinary case, and `''` again whenever the answer is uncertain. See
 * `lib/explorer/session-root.ts` for why this is a prefix rather than a new
 * root, and why the fs guard is untouched by it.
 *
 * **Only the active session's own project is retargeted.** The sticky and
 * default branches deliberately answer `''`: the prefix describes where a
 * particular session is working, and applying one session's worktree to a
 * project the user navigated to for another reason would be a stranger lie than
 * the one this fixes.
 */
export interface ExplorerTarget {
  project: ProjectRow | null;
  /** Project-relative directory to root the tree at. `''` is the project root. */
  root: string;
}

export function useExplorerProject(): ExplorerTarget {
  const entity = useActiveEntity();
  const projects = useProjects();
  const sticky = useExplorerProjectId();
  const setSticky = useSetExplorerProjectId();

  const session = entity && isSession(entity) ? entity : null;

  const fromSession =
    session !== null
      ? (projects.find((project) => project.id === session.project) ?? null)
      : null;

  /**
   * Read for the project the *session* names, not the one finally chosen.
   *
   * Hooks cannot be called conditionally, so this runs on every render; passing
   * the resolved project would make it depend on the sticky fallback below and
   * quietly root the tree inside a worktree belonging to a different project.
   */
  const path = useProjectPath(fromSession?.id ?? '');

  useEffect(() => {
    if (fromSession && fromSession.id !== sticky) setSticky(fromSession.id);
  }, [fromSession, sticky, setSticky]);

  if (fromSession) {
    return { project: fromSession, root: relativeRoot(path, session?.cwd) };
  }

  const remembered = projects.find((project) => project.id === sticky);
  /**
   * `?? null` rather than `?? projects[0]` on the remembered branch: a project
   * that was removed from the config while its id was sticky must fall through
   * to the default below, not resolve to nothing and render an empty tree.
   */
  return { project: remembered ?? projects[0] ?? null, root: '' };
}
