import type { ProjectConfig } from '../../../shared/config-contract';
import type { GhError } from '../../../shared/github-contract';

import { classifyGhFailure, isNotAGitHubRepo } from './classify';
import type { RepoRef } from './query';
import type { RunAsync } from './run';

/**
 * Which GitHub repositories the configured projects are.
 *
 * A project is a **directory**, and a directory is not a repository name. The
 * translation is `gh repo view --json nameWithOwner`, run with the project as
 * its cwd, because `gh` already knows how to read a remote in every form the
 * user might have cloned it in — `git@`, `https://`, an enterprise host, a fork
 * with an upstream. Parsing `.git/config` here would be re-implementing that,
 * worse, in a place that would go stale.
 *
 * ## What is cached, and what is deliberately not
 *
 * A **successful** answer is cached for the process lifetime: the poll runs
 * every minute and a repository's remote changes approximately never, so
 * without a memo this would be a spawn per project per minute to re-learn a
 * constant.
 *
 * A **failure is not cached**, and that distinction is the whole design. This
 * command talks to GitHub and needs credentials, so it fails when the machine
 * is offline, when `gh` is not logged in yet, or during a blip. Caching those
 * would mean an app launched before `gh auth login` says "no configured project
 * is a GitHub repository" every minute *forever*, and keeps saying it after the
 * user logs in — the panel would tell them to fix their project list, which was
 * never the problem, and only a restart would clear it.
 *
 * The one negative worth remembering is `no git remotes`: a scratch directory
 * with no GitHub remote is a permanent fact about that directory, not about the
 * connection. That case is cached; everything else is retried next sweep, which
 * costs one spawn per unresolved project per minute and buys a system that
 * repairs itself.
 */

/** `owner/name`, as `nameWithOwner` spells it. */
const NAME_WITH_OWNER = /^([^/\s]+)\/([^/\s]+)$/;

export interface RepoResolution {
  repos: RepoRef[];
  /**
   * Why resolution came up short, when it did.
   *
   * `null` when every project answered — including projects that answered "I am
   * not a GitHub repository", which is an answer and not a failure. Non-null
   * carries the *reason*, so an empty list caused by a logged-out `gh` can say
   * so instead of blaming the user's project list.
   */
  failure: GhError | null;
}

export interface RepoResolver {
  /**
   * The distinct repositories behind these projects.
   *
   * Deduped, because two projects can point at one repository — a worktree and
   * its checkout, which is exactly how this app is developed — and asking about
   * it twice would show every PR twice.
   */
  resolve(projects: readonly ProjectConfig[]): Promise<RepoResolution>;
}

function parseNameWithOwner(stdout: string): RepoRef | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const value: unknown = (parsed as Record<string, unknown>).nameWithOwner;
  if (typeof value !== 'string') return null;

  const match = NAME_WITH_OWNER.exec(value.trim());
  if (match === null) return null;

  return { owner: match[1], name: match[2] };
}

/** One directory's answer: a repository, "not one", or a reason it failed. */
type Answer =
  | { kind: 'repo'; repo: RepoRef }
  | { kind: 'not-a-repo' }
  | { kind: 'failed'; error: GhError };

export function createRepoResolver(
  ghPath: string,
  run: RunAsync,
): RepoResolver {
  /** Resolved path → its repository, or `null` for a *definitive* "not one". */
  const cache = new Map<string, RepoRef | null>();

  async function ask(path: string): Promise<Answer> {
    const cached = cache.get(path);
    if (cached !== undefined) {
      return cached === null ? { kind: 'not-a-repo' } : { kind: 'repo', repo: cached };
    }

    let result;
    try {
      result = await run(ghPath, ['repo', 'view', '--json', 'nameWithOwner'], {
        cwd: path,
      });
    } catch {
      // The binary could not be executed. Not cached — it was on the `PATH`
      // moments ago, so this is the machine changing underneath the app.
      return {
        kind: 'failed',
        error: { kind: 'not-installed', message: 'Could not run `gh`.' },
      };
    }

    if (result.code === 0) {
      const repo = parseNameWithOwner(result.stdout);
      /*
        A zero exit is a definitive answer either way. Output this code cannot
        read is still `gh` saying "here is what this directory is", so it is
        cached as "not a repository" rather than retried once a minute forever.
      */
      cache.set(path, repo);
      return repo === null ? { kind: 'not-a-repo' } : { kind: 'repo', repo };
    }

    if (isNotAGitHubRepo(result.stderr)) {
      cache.set(path, null);
      return { kind: 'not-a-repo' };
    }

    // Offline, logged out, a blip. Deliberately uncached: the user can fix all
    // three without restarting the app, and the next sweep must notice.
    return {
      kind: 'failed',
      error: classifyGhFailure(result.stderr, result.timedOut),
    };
  }

  return {
    async resolve(projects) {
      const repos: RepoRef[] = [];
      const seen = new Set<string>();
      let failure: GhError | null = null;

      for (const project of projects) {
        /**
         * Three ways a project cannot be asked about, and all three are
         * ordinary: the path did not resolve, it is not a git repository, or
         * the config itself marked the entry unusable. None is an error — a
         * user is allowed to keep a scratch directory in their project list.
         */
        if (project.path === null || !project.isRepo || project.status !== 'ok') {
          continue;
        }

        /*
          Sequential, not `Promise.all`. The first sweep would otherwise spawn a
          `gh` per project at once, and every sweep after it reads a cache and
          costs nothing — so the parallelism would buy a fraction of a second,
          once, in exchange for a process storm on a machine that is already
          running the user's terminals.
        */
        const answer = await ask(project.path);

        if (answer.kind === 'failed') {
          // The first reason wins: they are almost always the same reason, and
          // the first is the one that has not been coloured by a retry.
          failure ??= answer.error;
          continue;
        }

        if (answer.kind === 'not-a-repo') continue;

        // Case-insensitive, because GitHub's own names are: `Owner/Repo` and
        // `owner/repo` are one repository and must not be swept twice.
        const key = `${answer.repo.owner}/${answer.repo.name}`.toLowerCase();
        if (seen.has(key)) continue;

        seen.add(key);
        repos.push(answer.repo);
      }

      return { repos, failure };
    },
  };
}
