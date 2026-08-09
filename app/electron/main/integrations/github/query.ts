import {
  GH_MERGED_PAGE,
  GH_OPEN_PAGE,
  GH_THREAD_PAGE,
} from '../../../shared/github-contract';

/**
 * The GraphQL document, and how many repositories fit in one of them.
 *
 * ## Why one query for every repository
 *
 * The obvious shape is a query per repo, run in a loop. This is one query with
 * an **aliased `repository` block per repo** — `r0:`, `r1:`, … — which makes a
 * sweep one `gh` spawn and one HTTP round trip no matter how many projects the
 * user has configured. At a poll a minute, per-repo calls would be the whole
 * cost of this feature.
 *
 * ## Why the repo names are variables and not interpolated
 *
 * Only the *alias list* is generated, and it is generated from a **count** —
 * `r0`, `owner0`, `name0` — so no value derived from the user's config is ever
 * concatenated into the query text. The owners and names travel as GraphQL
 * variables, where they are data and cannot be anything else. This is the same
 * rule `gh.ts` states for argv, applied one layer up: the query is a constant
 * shape, and the inputs are bound.
 *
 * Names come from the config file rather than the renderer, so this is defence
 * in depth rather than the only line — which is exactly when it is cheap enough
 * to be worth having.
 */

/** One repository to sweep. */
export interface RepoRef {
  owner: string;
  name: string;
}

/** The alias a repository's block answers under. Derived from the index only. */
export function repoAlias(index: number): string {
  return `r${index}`;
}

/**
 * The fields read from one PR.
 *
 * `reviewThreads` is the whole reason this is GraphQL rather than
 * `gh pr list --json`: the REST-shaped field set has no thread resolution in
 * it, and "unresolved review threads" is what the findings badge counts.
 */
const PR_PARTS = `fragment PrParts on PullRequest {
  number
  title
  url
  isDraft
  state
  reviewDecision
  headRefName
  updatedAt
  mergedAt
  author { login }
  reviewThreads(first: ${String(GH_THREAD_PAGE)}) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

/**
 * Two connections per repository rather than one `states: [OPEN, MERGED]`.
 *
 * A combined connection orders by `updatedAt` across both states, so a busy
 * repository's merged PRs would push the user's open ones off the first page —
 * and the open ones are the entire point of the panel. Asking separately gives
 * each state its own page and makes neither able to starve the other.
 */
const REPO_PRS = `fragment RepoPrs on Repository {
  name
  owner { login }
  open: pullRequests(states: [OPEN], first: ${String(GH_OPEN_PAGE)}, orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes { ...PrParts }
  }
  merged: pullRequests(states: [MERGED], first: ${String(GH_MERGED_PAGE)}, orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes { ...PrParts }
  }
}`;

/**
 * The document for `count` repositories.
 *
 * `viewer { login }` rides along because the author filter needs to know who
 * "mine" is, and asking in the same round trip is free — a separate
 * `gh api user` call would double the request count to learn something that
 * never changes within a session.
 */
export function buildPrQuery(count: number): string {
  const params: string[] = [];
  const blocks: string[] = [];

  for (let index = 0; index < count; index += 1) {
    params.push(`$owner${String(index)}: String!, $name${String(index)}: String!`);
    blocks.push(
      `  ${repoAlias(index)}: repository(owner: $owner${String(index)}, name: $name${String(index)}) { ...RepoPrs }`,
    );
  }

  // No repositories means no parameter list at all — `query () {` is a syntax
  // error, not an empty query.
  const signature = params.length === 0 ? '' : `(${params.join(', ')})`;

  return [
    `query${signature} {`,
    '  viewer { login }',
    ...blocks,
    '}',
    REPO_PRS,
    PR_PARTS,
  ].join('\n');
}

/**
 * The variable bindings, keyed to match {@link buildPrQuery}'s parameter names.
 *
 * A flat `Record<string, string>` because that is what `gh api graphql` takes
 * on the command line, one `-f key=value` per entry.
 */
export function buildPrVariables(
  repos: readonly RepoRef[],
): Record<string, string> {
  const variables: Record<string, string> = {};

  repos.forEach((repo, index) => {
    variables[`owner${String(index)}`] = repo.owner;
    variables[`name${String(index)}`] = repo.name;
  });

  return variables;
}
