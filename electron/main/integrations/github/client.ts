import type { GhResult, PrRecord } from '../../../shared/github-contract';

import { classifyGhFailure, ghError } from './classify';
import {
  collectPrs,
  collectSearchPrs,
  hasAnyConnection,
  readViewerLogin,
} from './mapping';
import {
  buildPrQuery,
  buildPrVariables,
  buildSearchVariables,
  repoQualifiers,
  safeSearchTerm,
  type RepoRef,
} from './query';
import type { RunAsync } from './run';

/**
 * The sweep: one `gh api graphql` call, one list of PRs.
 *
 * ## Why the payload beats the exit code
 *
 * `gh` exits non-zero whenever the GraphQL response carries an `errors` array —
 * including the case where it *also* carries perfectly good data. One of the two
 * search connections failing while the other answers is exactly that case:
 * GitHub sends `null` for the field it could not resolve, an error naming it,
 * and real nodes for the other. Reading the exit code first would throw the good
 * half away, so this reads the body first and only falls back to classifying a
 * failure when there is nothing usable in it.
 *
 * Note that an *inaccessible repository* no longer produces an error at all. A
 * `repo:` qualifier the token cannot see simply matches nothing, so one bad
 * project in the config now costs its own results and stays silent — where the
 * aliased-repository query it replaced would name it in `errors`.
 *
 * ## What is never returned
 *
 * `stdout` and `stderr` do not escape. Failures are named by
 * `classify.ts` from a classification of what happened — never assembled from
 * command output, which can contain a URL with a token in it if a user has
 * configured one that way.
 */

/** Enough of the response to tell "answered" from "failed". */
interface GraphqlBody {
  data?: unknown;
}

export interface GithubClient {
  /**
   * Read every PR across these repositories.
   *
   * `now` is a parameter rather than a `Date.now()` call so the merged window is
   * testable without a fake clock reaching into this module.
   */
  sweep(repos: readonly RepoRef[], now: number): Promise<GhResult<PrRecord[]>>;
  /**
   * Every PR matching `term` across these repositories, **whoever wrote it**.
   *
   * The same document and the same scoping as {@link GithubClient.sweep} — only
   * the search expressions differ, and only by dropping `author:@me` and adding
   * the user's words. It takes no `now`, because a search has no merged window:
   * see `collectSearchPrs`.
   */
  search(term: string, repos: readonly RepoRef[]): Promise<GhResult<PrRecord[]>>;
}

export function createGithubClient(
  ghPath: string,
  run: RunAsync,
): GithubClient {
  /**
   * The half of a query that has nothing to do with *which* PRs are wanted.
   *
   * Extracted when search landed, because search and sweep differ only in their
   * two search expressions — everything after the call is identical, and it is
   * the part with the subtle rules in it: the payload beating the exit code,
   * the two sentinels, and the refusal to let command output escape. Two copies
   * of that would be two chances to drop one of them.
   */
  const ask = async (
    variables: Record<string, string>,
  ): Promise<GhResult<{ data: unknown; login: string }>> => {
    const args = ['api', 'graphql', '-f', `query=${buildPrQuery()}`];

    for (const [key, value] of Object.entries(variables)) {
      // `-F` types the value; `-f` keeps it a string. A search expression is
      // always a string, and `-F` would try to read one that happened to look
      // numeric as a number — or, worse, one beginning with `@` as a filename.
      args.push('-f', `${key}=${value}`);
    }

    let result;
    try {
      result = await run(ghPath, args);
    } catch {
      // The binary could not be executed at all. It was on the `PATH` when
      // the call started, so this is a machine changing underneath the app
      // rather than a configuration the user can see and fix.
      return {
        ok: false,
        error: ghError('not-installed', 'Could not run `gh`.'),
      };
    }

    let body: GraphqlBody | null = null;
    try {
      body = JSON.parse(result.stdout) as GraphqlBody;
    } catch {
      body = null;
    }

    const data = body?.data;
    const login = readViewerLogin(data);

    /**
     * Two sentinels, because one of them cannot see the failure that matters.
     *
     * **No `viewer`** means the request did not succeed at all: it is the one
     * part of this query that cannot be `null` for a working token, whatever
     * the exit code said. "Mine" is no longer defined by the login —
     * `author:@me` in the expression is — but `mapping.ts` still checks each
     * node's author against it for the sweep, so an unreadable login must not
     * stand in for a successful read.
     *
     * **No connection at all** is the one `viewer` misses, and it is the more
     * dangerous of the two. `viewer` is a top-level field that resolves
     * independently of the searches, so a response where both connections
     * failed still carries a good login beside `open: null, merged: null`.
     * GraphQL calls that partial success and `gh` reports it in `errors`,
     * which this deliberately does not read (the payload beats the exit code,
     * above) — so without this check the call would answer `ok` with an empty
     * list, and `hydratePrs` would install it as *live and not stale*. The
     * panel would then say "No open pull requests of yours" with total
     * confidence: the precise failure this integration was rewritten to stop,
     * reintroduced one layer up and across every repository at once.
     *
     * An empty connection is not a missing one. A user with no open work gets
     * `{ nodes: [] }`, which passes, and one search surviving while the other
     * fails is the partial-data case `collectPrs` is built to keep.
     */
    if (login === null || !hasAnyConnection(data)) {
      return {
        ok: false,
        error: classifyGhFailure(result.stderr, result.timedOut),
      };
    }

    return { ok: true, value: { data, login } };
  };

  /**
   * Nothing to scope the search to is a configuration answer, never a request.
   *
   * This covers two cases that must not be told apart by the caller, because
   * the consequence of getting either wrong is the same. The ordinary one is an
   * empty repository list. The other is a list where nothing survived
   * {@link repoQualifiers} — and *that* one is why the check is on the
   * qualifiers rather than on `repos.length`. A search with no `repo:` scope is
   * a perfectly valid query that answers with pull requests from every
   * repository GitHub can see, so a call that fell through here would not fail:
   * it would quietly fill the panel with work from projects the user never
   * configured.
   */
  const scopeFor = (
    repos: readonly RepoRef[],
  ): { ok: true; scope: string[] } | { ok: false; error: GhResult<never> } => {
    const scope = repoQualifiers(repos);
    if (scope.length > 0) return { ok: true, scope };

    /*
      The two cases share a kind but not a sentence. Telling a user whose
      projects all resolved that none of them is a GitHub repository would
      send them to fix a list that is already correct. The second case is
      close to unreachable — these names come from `gh repo view` and
      GitHub's own are always within the permitted set — but an unreachable
      branch is a poor place to keep a message that is false.
    */
    return {
      ok: false,
      error: {
        ok: false,
        error: ghError(
          'no-repos',
          repos.length === 0
            ? 'No configured project is a GitHub repository.'
            : 'No configured repository has a name GitHub search can be scoped to.',
        ),
      },
    };
  };

  return {
    async sweep(repos, now) {
      const scoped = scopeFor(repos);
      if (!scoped.ok) return scoped.error;

      const answer = await ask(buildPrVariables(scoped.scope));
      if (!answer.ok) return answer;

      return {
        ok: true,
        value: collectPrs(answer.value.data, answer.value.login, now),
      };
    },

    async search(term, repos) {
      /*
        An empty term after sanitising is not a search, and it must not be sent.
        `assertText` admits `":"` and `"   "`, both of which `safeSearchTerm`
        reduces to nothing — and an expression with no term is `is:pr is:open
        repo:… sort:…`, which answers with *every* open PR in scope and would be
        presented to the user as search results. The UI never sends one; main
        does not rely on that.
      */
      if (safeSearchTerm(term) === '') return { ok: true, value: [] };

      const scoped = scopeFor(repos);
      if (!scoped.ok) return scoped.error;

      const answer = await ask(buildSearchVariables(term, scoped.scope));
      if (!answer.ok) return answer;

      return { ok: true, value: collectSearchPrs(answer.value.data) };
    },
  };
}
