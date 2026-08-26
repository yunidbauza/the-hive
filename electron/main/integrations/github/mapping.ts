import {
  GH_MERGED_WINDOW_MS,
  type GhPrChecks,
  type GhPrState,
  type PrRecord,
} from '../../../shared/github-contract';

/**
 * GitHub's GraphQL JSON to named fields.
 *
 * Pure. No I/O, no imports beyond the contract, and the clock arrives as an
 * argument — which is what lets the module carrying every branch in this
 * integration be tested against recorded payloads instead of against GitHub.
 *
 * ## Why nothing here throws
 *
 * {@link toPrRecord} answers `null` for an entry it cannot read, exactly as
 * `jira/mapping.ts` does: one malformed PR then costs itself and nothing else.
 * A sweep of forty where the ninth has no `headRefName` renders thirty-nine
 * rows rather than an error, and the panel's rule that it must render either
 * way applies *inside* a sweep too.
 *
 * ## What is still filtered here, now that the search filters too
 *
 * "Mine" is asked for in the query — `author:@me`, see `query.ts` — so the
 * author check here is no longer what defines the list. It is kept anyway,
 * because it costs one comparison and it is the thing that would catch a search
 * expression that failed to scope the way it was meant to. Cheap agreement
 * between two independent mechanisms beats trusting either alone.
 *
 * **The twenty-four hour merged window is a different matter: this is the only
 * place it is applied.** It filters on `mergedAt`, which is the question the
 * panel actually asks — "did this land recently" — and deliberately not on the
 * `updated:` qualifier the search could have carried, which answers "was this
 * touched recently" and would drop a PR for being quiet.
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

/**
 * The repository a node came from, or `null`.
 *
 * Read off the node rather than passed in. Search returns one flat list spanning
 * every repository in the expression, so there is no longer an index that says
 * which repo a result belongs to — the node has to carry it, and a node that
 * does not is one this app cannot place on a card.
 */
function repoOf(raw: Record<string, unknown>): { name: string; owner: string } | null {
  const repository = raw.repository;
  if (!isRecord(repository)) return null;

  const name = text(repository.name);
  const owner = isRecord(repository.owner) ? text(repository.owner.login) : null;
  if (name === null || owner === null) return null;

  return { name, owner };
}

/**
 * One PR, or `null` if the entry cannot be read.
 *
 * A search over `type: ISSUE` can also answer with issues and with nodes the
 * inline `... on PullRequest` fragment left empty, so "cannot be read" is a
 * routine outcome here rather than a corruption — those arrive as `{}` and leave
 * as `null`, costing themselves and nothing else.
 */
export function toPrRecord(raw: unknown): PrRecord | null {
  if (!isRecord(raw)) return null;

  const number = raw.number;
  if (typeof number !== 'number' || !Number.isInteger(number)) return null;

  const title = text(raw.title);
  const url = text(raw.url);
  const branch = text(raw.headRefName);
  const updatedAt = text(raw.updatedAt);
  const repo = repoOf(raw);
  if (
    title === null ||
    url === null ||
    branch === null ||
    updatedAt === null ||
    repo === null
  ) {
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

/**
 * Whether the payload carries at least one search connection worth reading.
 *
 * The difference between "you have no open pull requests" and "GitHub did not
 * answer", which `viewer` alone cannot tell apart. `viewer` is a top-level field
 * that resolves independently of the two searches, so a response where both
 * connections failed — a search-backend timeout, a secondary rate limit, an
 * expression GitHub would not parse — still carries a perfectly good login next
 * to `open: null, merged: null`. Reading that as a successful empty sweep would
 * install a *live, non-stale* empty list and put "No open pull requests of
 * yours" on the panel with total confidence, which is the exact failure this
 * whole change set out to remove.
 *
 * An empty connection is **not** this: `{ nodes: [] }` is a record and passes.
 * Only a `null` or missing connection counts as no answer, and only when both
 * are — one search surviving is the partial-data case `collectPrs` keeps.
 */
export function hasAnyConnection(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  return isRecord(payload.open) || isRecord(payload.merged);
}

/** The `nodes` of one search connection, or nothing at all. */
function nodesOf(payload: Record<string, unknown>, key: string): unknown[] {
  const connection = payload[key];
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
 * The sort is applied here rather than trusted from `sort:updated-desc`, because
 * the two searches arrive as separate lists and the panel's order interleaves
 * neither — it stacks them.
 *
 * A connection that came back missing or `null` contributes nothing rather than
 * failing the sweep. GraphQL answers partial data with a `null` field and an
 * error beside it, and losing the connection that did answer because its sibling
 * did not would be the wrong trade.
 */
export function collectPrs(
  payload: unknown,
  login: string,
  now: number,
): PrRecord[] {
  if (!isRecord(payload)) return [];

  const records: PrRecord[] = [];

  for (const node of nodesOf(payload, 'open')) {
    if (!isAuthoredBy(node, login)) continue;
    const record = toPrRecord(node);
    if (record !== null) records.push(record);
  }

  for (const node of nodesOf(payload, 'merged')) {
    if (!isAuthoredBy(node, login)) continue;

    const merged = mergedAtMs(node);
    if (merged === null || now - merged > GH_MERGED_WINDOW_MS) continue;

    const record = toPrRecord(node);
    if (record !== null) records.push(record);
  }

  return records.sort((left, right) => {
    const landed = Number(left.state === 'merged') - Number(right.state === 'merged');
    if (landed !== 0) return landed;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

/**
 * The same payload, read for a **search** rather than a sweep.
 *
 * Two filters the sweep applies are deliberately absent, and each would be a
 * bug here:
 *
 * - **The author check.** `collectPrs` re-checks every node against the
 *   viewer's login behind `author:@me`, belt and braces on "mine". A search is
 *   explicitly not about mine, so the same check would silently discard every
 *   result the user asked for.
 * - **The twenty-four hour merged window.** That window exists because the
 *   panel is a *standing* list, where a merge from last month is finished
 *   business nobody needs a row for. A search is a question, and "PRs about
 *   carapace" plainly includes the one merged in March. Hiding it would look
 *   like the search was broken.
 *
 * The sort is shared: open above merged, newest first within each. A search
 * result set reads like the list it replaces, so it is ordered like it.
 */
export function collectSearchPrs(payload: unknown): PrRecord[] {
  if (!isRecord(payload)) return [];

  const records: PrRecord[] = [];

  for (const key of ['open', 'merged'] as const) {
    for (const node of nodesOf(payload, key)) {
      const record = toPrRecord(node);
      if (record !== null) records.push(record);
    }
  }

  return records.sort((left, right) => {
    const landed = Number(left.state === 'merged') - Number(right.state === 'merged');
    if (landed !== 0) return landed;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}
