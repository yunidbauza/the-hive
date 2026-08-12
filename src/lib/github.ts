import type { GhResult, PrsSnapshot } from '@shared/github-contract';

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
