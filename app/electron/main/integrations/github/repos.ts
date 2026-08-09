import type { ProjectConfig } from '../../../shared/config-contract';

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
 * ## Why the answer is memoised
 *
 * The poll runs every minute; a repository's remote changes approximately
 * never. Without a cache this would be one spawn per project per minute to
 * re-learn a constant. The cache holds the **negative** answer too — a directory
 * that is not a GitHub repository is not going to become one mid-session — and
 * lives in a closure rather than at module scope, so each test gets its own.
 *
 * The consequence is precise and worth writing down: repointing a project at a
 * different repository is not picked up until the app restarts. That is the
 * right trade at a poll a minute, and repointing already restarts the sessions
 * that care.
 */

/** `owner/name`, as `nameWithOwner` spells it. */
const NAME_WITH_OWNER = /^([^/\s]+)\/([^/\s]+)$/;

export interface RepoResolver {
  /**
   * The distinct repositories behind these projects.
   *
   * Deduped, because two projects can point at one repository — a worktree and
   * its checkout, which is exactly how this app is developed — and asking about
   * it twice would show every PR twice.
   */
  resolve(projects: readonly ProjectConfig[]): Promise<RepoRef[]>;
}

function parseNameWithOwner(stdout: string): RepoRef | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Not JSON at all. `gh` printed something this code does not understand,
    // which makes it a repository it cannot name — not a reason to fail the
    // sweep, because the other projects may well resolve.
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const value: unknown = (parsed as Record<string, unknown>).nameWithOwner;
  if (typeof value !== 'string') return null;

  const match = NAME_WITH_OWNER.exec(value.trim());
  if (match === null) return null;

  return { owner: match[1], name: match[2] };
}

export function createRepoResolver(
  ghPath: string,
  run: RunAsync,
): RepoResolver {
  /** Resolved path → its repository, or `null` for "asked, and it is not one". */
  const cache = new Map<string, RepoRef | null>();

  async function repoFor(path: string): Promise<RepoRef | null> {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;

    let repo: RepoRef | null = null;

    try {
      const result = await run(
        ghPath,
        ['repo', 'view', '--json', 'nameWithOwner'],
        { cwd: path },
      );
      // A non-zero exit is the ordinary "this git repository has no GitHub
      // remote" answer, which is a state and not a failure.
      if (result.code === 0) repo = parseNameWithOwner(result.stdout);
    } catch {
      // A `gh` that could not be executed. Cached as "not a repository" like
      // any other negative answer: retrying a broken binary once a minute is
      // how a poller becomes the problem.
    }

    cache.set(path, repo);
    return repo;
  }

  return {
    async resolve(projects) {
      const found: RepoRef[] = [];
      const seen = new Set<string>();

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
        const repo = await repoFor(project.path);
        if (repo === null) continue;

        // Case-insensitive, because GitHub's own names are: `Owner/Repo` and
        // `owner/repo` are one repository and must not be swept twice.
        const key = `${repo.owner}/${repo.name}`.toLowerCase();
        if (seen.has(key)) continue;

        seen.add(key);
        found.push(repo);
      }

      return found;
    },
  };
}
