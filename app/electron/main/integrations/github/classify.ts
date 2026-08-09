import type { GhError, GhErrorKind } from '../../../shared/github-contract';

/**
 * What went wrong, from the shape of the failure rather than from its prose.
 *
 * Shared by the sweep and by repository resolution, because both run `gh` and
 * both fail the same handful of ways — and because a user whose `gh` is not
 * logged in must be told *that*, whichever call happened to notice first.
 *
 * Matching on `stderr` text is a last resort and is treated as one: the
 * patterns below are matched case-insensitively and only after the structural
 * signals — a timeout, an unreadable body — have been ruled out. GitHub's
 * wording is not a contract, so a miss degrades to `unknown`, which still
 * renders.
 *
 * Nothing from `stderr` is ever returned; the messages are written here.
 */

export const ghError = (kind: GhErrorKind, message: string): GhError => ({
  kind,
  message,
});

/**
 * The one failure that is genuinely *about this directory* rather than about
 * the machine's connection to GitHub.
 *
 * `gh repo view` says this when the working directory is a git repository with
 * no GitHub remote — a permanent fact about a scratch project, and the only
 * negative answer worth remembering. Everything else can be fixed by logging in
 * or reconnecting, and must be retried.
 */
export function isNotAGitHubRepo(stderr: string): boolean {
  const text = stderr.toLowerCase();

  /**
   * An unknown *host* is not an absent remote, and it is fixable.
   *
   * `gh` says "none of the git remotes configured for this repository point to
   * a known GitHub host. To tell gh about a new GitHub host, please use `gh
   * auth login`" — which matches the phrase below while meaning the opposite of
   * what this function is for. A GitHub Enterprise checkout was therefore
   * cached as "not a repository" for the life of the process, and running
   * `gh auth login --hostname …` changed nothing until the app was restarted:
   * exactly the failure the negative-cache split exists to prevent.
   *
   * The remedy `gh` prints is the signal. If it is telling the user how to fix
   * it, this is a state that can change, and the rule above says retry.
   */
  if (text.includes('gh auth login')) return false;

  return (
    text.includes('no git remotes') ||
    text.includes('none of the git remotes') ||
    text.includes('not a git repository')
  );
}

export function classifyGhFailure(stderr: string, timedOut: boolean): GhError {
  if (timedOut) {
    return ghError('timeout', 'GitHub did not answer in time.');
  }

  const text = stderr.toLowerCase();

  if (text.includes('rate limit') || text.includes('secondary rate')) {
    return ghError('rate-limited', 'GitHub is rate-limiting this account.');
  }

  if (
    text.includes('no such host') ||
    text.includes('dial tcp') ||
    text.includes('connection refused') ||
    text.includes('network is unreachable') ||
    text.includes('offline')
  ) {
    return ghError('offline', 'Could not reach GitHub.');
  }

  if (
    text.includes('authentication') ||
    text.includes('bad credentials') ||
    text.includes('401') ||
    text.includes('gh auth login') ||
    text.includes('not logged in')
  ) {
    return ghError(
      'unauthenticated',
      'GitHub CLI (`gh`) is not logged in — run `gh auth login`.',
    );
  }

  return ghError('unknown', 'The GitHub read failed.');
}
