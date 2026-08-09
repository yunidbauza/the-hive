import type {
  GhError,
  GhErrorKind,
  GhResult,
  PrRecord,
} from '../../../shared/github-contract';

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
 * `stdout` and `stderr` do not escape. The error messages below are written
 * here, from a classification of what happened — never assembled from command
 * output, which can contain a URL with a token in it if a user has configured
 * one that way.
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

const fail = (kind: GhErrorKind, message: string): GhError => ({
  kind,
  message,
});

/**
 * What went wrong, from the shape of the failure rather than from its prose.
 *
 * Matching on `stderr` text is a last resort and is treated as one: the two
 * patterns below are matched case-insensitively and only after the structural
 * signals — a timeout, an empty body — have been ruled out. GitHub's wording is
 * not a contract, so a miss here degrades to `unknown`, which still renders.
 */
function classify(stderr: string, timedOut: boolean): GhError {
  if (timedOut) {
    return fail('timeout', 'GitHub did not answer in time.');
  }

  const text = stderr.toLowerCase();

  if (text.includes('rate limit') || text.includes('secondary rate')) {
    return fail('rate-limited', 'GitHub is rate-limiting this account.');
  }

  if (
    text.includes('no such host') ||
    text.includes('dial tcp') ||
    text.includes('connection refused') ||
    text.includes('network is unreachable')
  ) {
    return fail('offline', 'Could not reach GitHub.');
  }

  if (
    text.includes('authentication') ||
    text.includes('bad credentials') ||
    text.includes('401') ||
    text.includes('gh auth login')
  ) {
    return fail(
      'unauthenticated',
      'GitHub refused the credentials `gh` is using.',
    );
  }

  return fail('unknown', 'The GitHub read failed.');
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
          error: fail('no-repos', 'No configured project is a GitHub repository.'),
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
        return { ok: false, error: fail('not-installed', 'Could not run `gh`.') };
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
        return { ok: false, error: classify(result.stderr, result.timedOut) };
      }

      return { ok: true, value: collectPrs(data, repos, login, now) };
    },
  };
}
