import type {
  GhResult,
  PrLookup,
  PrLookupReply,
  PrsSnapshot,
} from '@shared/github-contract';

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
