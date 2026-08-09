import {
  GH_MERGED_WINDOW_MS,
  type GhPrChecks,
  type GhPrState,
  type PrRecord,
} from '../../../shared/github-contract';

import { repoAlias, type RepoRef } from './query';

/**
 * GitHub's GraphQL JSON to named fields.
 *
 * Pure. No I/O, no imports beyond the contract and the alias helper, and the
 * clock arrives as an argument — which is what lets the module carrying every
 * branch in this integration be tested against recorded payloads instead of
 * against GitHub.
 *
 * ## Why nothing here throws
 *
 * {@link toPrRecord} answers `null` for an entry it cannot read, exactly as
 * `jira/mapping.ts` does: one malformed PR then costs itself and nothing else.
 * A sweep of forty where the ninth has no `headRefName` renders thirty-nine
 * rows rather than an error, and the panel's rule that it must render either
 * way applies *inside* a sweep too.
 *
 * ## Why the filtering lives here
 *
 * "Mine, plus what landed in the last day" is a rule about the payload, not
 * about process management, so {@link collectPrs} applies it while it reads
 * rather than handing a wider list to the composition root to narrow. That
 * keeps the whole payload→records step one pure function with a table for a
 * test, and leaves `index.ts` doing only composition.
 */

/** A plain object, and not an array. `typeof null` is the usual trap. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string, or `null`. Whitespace-only counts as absent. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** The account the token belongs to, or `null` if the payload did not say. */
export function readViewerLogin(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const viewer = payload.viewer;
  return isRecord(viewer) ? text(viewer.login) : null;
}

/**
 * The check rollup, reduced to the three states a badge exists for.
 *
 * **A missing rollup is `passing`, and that is a deliberate reading rather than
 * a shrug.** `statusCheckRollup` is `null` when the head commit has no checks at
 * all, which is every PR in a repository without CI. `passing` is the state that
 * produces *no badge* (`composeBadges`), so those PRs render clean instead of
 * growing a permanent "checks running" that will never resolve.
 */
export function toChecks(raw: unknown): GhPrChecks {
  if (!isRecord(raw)) return 'passing';

  const commits = isRecord(raw.commits) ? raw.commits.nodes : null;
  const head = Array.isArray(commits) ? commits[0] : null;
  const commit = isRecord(head) ? head.commit : null;
  const rollup = isRecord(commit) ? commit.statusCheckRollup : null;
  const state = isRecord(rollup) ? text(rollup.state) : null;

  if (state === 'FAILURE' || state === 'ERROR') return 'failing';
  if (state === 'PENDING' || state === 'EXPECTED') return 'running';
  return 'passing';
}

/**
 * Unresolved review threads — what the amber badge counts.
 *
 * Outdated threads are **included**. GitHub marks a thread outdated when the
 * code beneath it moves, which is what happens when an agent pushes a fix
 * *without* resolving the conversation — precisely the case the badge exists to
 * catch. Excluding them would make a PR look clean the moment it was touched.
 */
export function countFindings(raw: unknown): number {
  if (!isRecord(raw)) return 0;

  const threads = isRecord(raw.reviewThreads) ? raw.reviewThreads.nodes : null;
  if (!Array.isArray(threads)) return 0;

  return threads.filter(
    (thread) => isRecord(thread) && thread.isResolved !== true,
  ).length;
}

/**
 * How far the PR has got, in the order the four states actually exclude one
 * another.
 *
 * Merged wins over everything — a merged PR that was once a draft is merged.
 * Draft wins over `approved` because a draft cannot be approved into being
 * ready, and showing "approved" on something nobody can merge would be a lie
 * about what is blocking it.
 */
export function toState(raw: unknown): GhPrState {
  if (!isRecord(raw)) return 'open';

  if (text(raw.state) === 'MERGED') return 'merged';
  if (raw.isDraft === true) return 'draft';
  if (text(raw.reviewDecision) === 'APPROVED') return 'approved';
  return 'open';
}

/** One PR, or `null` if the entry cannot be read. */
export function toPrRecord(raw: unknown, repo: RepoRef): PrRecord | null {
  if (!isRecord(raw)) return null;

  const number = raw.number;
  if (typeof number !== 'number' || !Number.isInteger(number)) return null;

  const title = text(raw.title);
  const url = text(raw.url);
  const branch = text(raw.headRefName);
  const updatedAt = text(raw.updatedAt);
  if (title === null || url === null || branch === null || updatedAt === null) {
    return null;
  }

  return {
    number,
    title,
    url,
    repo: repo.name,
    owner: repo.owner,
    branch,
    state: toState(raw),
    findings: countFindings(raw),
    checks: toChecks(raw),
    updatedAt,
  };
}

/** `mergedAt` as epoch milliseconds, or `null` when absent or unparseable. */
function mergedAtMs(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const stamp = text(raw.mergedAt);
  if (stamp === null) return null;

  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? null : ms;
}

/** Whether the PR's author is the account this token belongs to. */
function isAuthoredBy(raw: unknown, login: string): boolean {
  if (!isRecord(raw)) return false;
  const author = raw.author;
  return isRecord(author) && text(author.login) === login;
}

function nodesOf(repository: Record<string, unknown>, key: string): unknown[] {
  const connection = repository[key];
  if (!isRecord(connection)) return [];
  return Array.isArray(connection.nodes) ? connection.nodes : [];
}

/**
 * Every PR worth showing, from one sweep's payload.
 *
 * Order is **live work first, then what landed** — each group by `updatedAt`,
 * newest first. Sorting the whole list by time alone would let a PR merged five
 * minutes ago sit above one waiting on the user right now, and the panel's job
 * is to show what still needs them.
 *
 * A repository whose block is missing or `null` contributes nothing rather than
 * failing the sweep: GraphQL answers partial data with per-field `null` when one
 * repo of several is inaccessible, and losing the other four because of it would
 * be the wrong trade.
 */
export function collectPrs(
  payload: unknown,
  repos: readonly RepoRef[],
  login: string,
  now: number,
): PrRecord[] {
  if (!isRecord(payload)) return [];

  const records: PrRecord[] = [];

  repos.forEach((repo, index) => {
    const repository = payload[repoAlias(index)];
    if (!isRecord(repository)) return;

    for (const node of nodesOf(repository, 'open')) {
      if (!isAuthoredBy(node, login)) continue;
      const record = toPrRecord(node, repo);
      if (record !== null) records.push(record);
    }

    for (const node of nodesOf(repository, 'merged')) {
      if (!isAuthoredBy(node, login)) continue;

      const merged = mergedAtMs(node);
      if (merged === null || now - merged > GH_MERGED_WINDOW_MS) continue;

      const record = toPrRecord(node, repo);
      if (record !== null) records.push(record);
    }
  });

  return records.sort((left, right) => {
    const landed = Number(left.state === 'merged') - Number(right.state === 'merged');
    if (landed !== 0) return landed;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}
