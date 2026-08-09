import { useEffect } from 'react';

import { isSession, type ProjectRow } from '@/types/entity';

import { useActiveEntity, useProjects } from '@stores/hive-store';
import { useExplorerProjectId, useSetExplorerProjectId } from '@stores/ui-store';

/**
 * Which repository the explorer is showing.
 *
 * The rule, in order:
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
 */
export function useExplorerProject(): ProjectRow | null {
  const entity = useActiveEntity();
  const projects = useProjects();
  const sticky = useExplorerProjectId();
  const setSticky = useSetExplorerProjectId();

  const fromSession =
    entity && isSession(entity)
      ? (projects.find((project) => project.id === entity.project) ?? null)
      : null;

  useEffect(() => {
    if (fromSession && fromSession.id !== sticky) setSticky(fromSession.id);
  }, [fromSession, sticky, setSticky]);

  if (fromSession) return fromSession;

  const remembered = projects.find((project) => project.id === sticky);
  /**
   * `?? null` rather than `?? projects[0]` on the remembered branch: a project
   * that was removed from the config while its id was sticky must fall through
   * to the default below, not resolve to nothing and render an empty tree.
   */
  return remembered ?? projects[0] ?? null;
}
