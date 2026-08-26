import type { GhResult, PrRecord, PrsSnapshot } from '@shared/github-contract';

/**
 * The renderer's half of the GitHub bridge.
 *
 * Mirrors `jira.ts` in the two ways that matter. **No bridge returns `null`** —
 * that is the browser demo, not a failure, and story 083's rule is to
 * feature-detect the bridge rather than the user agent. **A rejected channel
 * returns `null` too**, logged once, because a panel that throws when IPC
 * hiccups is worse than one that says it does not know.
 *
 * No module-level cache. The answer is the store's — `hydratePrs` owns it, and
 * a second copy here would be a second source of truth for the same rows.
 */
export const readPullRequests = async (): Promise<GhResult<PrsSnapshot> | null> => {
  const bridge = window.hive;
  if (!bridge) return null;

  try {
    return await bridge.github.prs();
  } catch (cause) {
    console.error('[hive] github.prs failed:', cause);
    return null;
  }
};

/**
 * Search pull requests, whoever wrote them.
 *
 * `projectId` narrows to one mapped project; omitting it means every mapped
 * project. Same two `null` cases as {@link readPullRequests} and for the same
 * reasons — no bridge is the browser demo, and a rejected channel is a hiccup
 * the panel reports as "could not search" rather than throwing over.
 */
export const searchPullRequests = async (
  term: string,
  projectId?: string,
): Promise<GhResult<PrRecord[]> | null> => {
  const bridge = window.hive;
  if (!bridge) return null;

  try {
    return await bridge.github.searchPrs(term, projectId);
  } catch (cause) {
    console.error('[hive] github.searchPrs failed:', cause);
    return null;
  }
};
