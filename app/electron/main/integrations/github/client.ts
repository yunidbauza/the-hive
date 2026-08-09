import type { GhResult, PrRecord } from '../../../shared/github-contract';

import { classifyGhFailure, ghError } from './classify';
import { collectPrs, readViewerLogin } from './mapping';
import {
  buildPrQuery,
  buildPrVariables,
  repoQualifiers,
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
}

export function createGithubClient(
  ghPath: string,
  run: RunAsync,
): GithubClient {
  return {
    async sweep(repos, now) {
      /**
       * Nothing to scope the search to is a configuration answer, never a
       * request.
       *
       * This covers two cases that must not be told apart here, because the
       * consequence of getting either wrong is the same. The ordinary one is an
       * empty repository list. The other is a list where nothing survived
       * {@link repoQualifiers} — and *that* one is why the check moved from
       * `repos.length` to the qualifiers. An `author:@me` search with no `repo:`
       * scope is a perfectly valid query that answers with the user's pull
       * requests from every repository they have ever touched, so a sweep that
       * fell through here would not fail: it would quietly fill the panel with
       * work from projects the user never configured.
       */
      const scope = repoQualifiers(repos);
      if (scope.length === 0) {
        return {
          ok: false,
          error: ghError(
            'no-repos',
            'No configured project is a GitHub repository.',
          ),
        };
      }

      const variables = buildPrVariables(scope);
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
        // the sweep started, so this is a machine changing underneath the app
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
       * No `viewer` means no answer worth reading.
       *
       * Not merely a missing field: `viewer` is the one part of this query that
       * cannot be `null` for a working token, so its absence means the request
       * did not succeed — whatever the exit code said. Both searches answering
       * with an empty list is a legitimate outcome for a user with no open work,
       * and indistinguishable from a failure without this.
       *
       * "Mine" is no longer defined by the login — `author:@me` in the search
       * expression is — but `mapping.ts` still checks each node's author against
       * it, so an unreadable login must not be allowed to stand in for a
       * successful read.
       */
      if (login === null) {
        return {
          ok: false,
          error: classifyGhFailure(result.stderr, result.timedOut),
        };
      }

      return { ok: true, value: collectPrs(data, login, now) };
    },
  };
}
