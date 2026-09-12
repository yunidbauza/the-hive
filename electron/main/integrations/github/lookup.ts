import type {
  GhResult,
  PrLookup,
  PrLookupReply,
  PrsSnapshot,
} from '@shared/github-contract';

import type { Github } from './index';

/**
 * How old a sweep may be and still answer a lookup: the PRs panel's one-minute
 * poll plus slack. So a `findings` count can be up to this stale. That is fine
 * for the shipper, which wakes every ten minutes, and `merge-pr` re-reads every
 * blocker live before it merges.
 */
export const PR_LOOKUP_MAX_AGE_MS = 90_000;

/**
 * One PR out of a sweep (HIVE-173).
 *
 * The sweep is what the PRs panel already polls, so a record here is exactly
 * what the badge shows. A sweep that failed answers with its own message and
 * no record, so a model can tell "gh is not installed" from "not your PR".
 * The slug is compared case-insensitively, as GitHub's own names are.
 */
export function lookupPr(result: GhResult<PrsSnapshot>, lookup: PrLookup): PrLookupReply {
  if (!result.ok) return { pr: null, reason: result.error.message };

  const wanted = lookup.repo.toLowerCase();
  const record = result.value.prs.find(
    (pr) => pr.number === lookup.number && `${pr.owner}/${pr.repo}`.toLowerCase() === wanted,
  );
  if (record === undefined) {
    return {
      pr: null,
      reason: `${lookup.repo}#${lookup.number} is not in the sweep of ${result.value.repos} configured repositor${result.value.repos === 1 ? 'y' : 'ies'}`,
    };
  }
  return { pr: record };
}

/**
 * The `mcp__hive__pr` answer: the recent sweep when it holds the PR, a fresh
 * sweep otherwise. A PR missing from a recent sweep may have opened since, so
 * a miss is never answered from the saved copy.
 */
export async function answerPrLookup(
  github: Pick<Github, 'prs' | 'latestPrs'>,
  lookup: PrLookup,
): Promise<PrLookupReply> {
  const recent = github.latestPrs(PR_LOOKUP_MAX_AGE_MS);
  if (recent !== null) {
    const reply = lookupPr({ ok: true, value: recent }, lookup);
    if (reply.pr !== null) return reply;
  }
  return lookupPr(await github.prs(), lookup);
}
