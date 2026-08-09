import type { GhResult, PrRecord } from '../../../shared/github-contract';

import { classifyGhFailure, ghError } from './classify';
import { collectPrs, readViewerLogin } from './mapping';
import { buildPrQuery, buildPrVariables, type RepoRef } from './query';
import type { RunAsync } from './run';

/**
 * The sweep: one `gh api graphql` call, one list of PRs.
 *
 * ## Why the payload beats the exit code
 *
 * `gh` exits non-zero whenever the GraphQL response carries an `errors` array —
 * including the case where it *also* carries perfectly good data. One
 * inaccessible repository out of five is exactly that case: GitHub answers with
 * `null` for that block, an error naming it, and real data for the other four.
 * Reading the exit code first would throw those four away, so this reads the
 * body first and only falls back to classifying a failure when there is nothing
 * usable in it.
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
      if (repos.length === 0) {
        return {
          ok: false,
          error: ghError(
            'no-repos',
            'No configured project is a GitHub repository.',
          ),
        };
      }

      const variables = buildPrVariables(repos);
      const args = ['api', 'graphql', '-f', `query=${buildPrQuery(repos.length)}`];

      for (const [key, value] of Object.entries(variables)) {
        // `-F` types the value; `-f` keeps it a string. Owners and names are
        // strings, and a repository literally named `123` must not arrive as a
        // number.
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
       * did not succeed — whatever the exit code said. It is also load-bearing,
       * since "mine" is defined by it, and showing everybody's PRs because the
       * login was unreadable would be the wrong failure.
       */
      if (login === null) {
        return {
          ok: false,
          error: classifyGhFailure(result.stderr, result.timedOut),
        };
      }

      return { ok: true, value: collectPrs(data, repos, login, now) };
    },
  };
}
