import type { ConfigSnapshot } from '../../../shared/config-contract';
import type {
  GhResult,
  PrRecord,
  PrsSnapshot,
} from '../../../shared/github-contract';
import { probeCommand } from '../../config/probe';

import { createGithubClient, type GithubClient } from './client';
import { createRepoResolver, type RepoResolver } from './repos';
import type { RunAsync } from './run';

/**
 * The verbs main exposes for GitHub.
 *
 * Composition, and nothing else. `repos.ts` turns directories into repository
 * names, `client.ts` owns the call, `mapping.ts` owns the payload, and this file
 * owns two decisions: which of them a verb needs, and what happens when the
 * machine is not set up yet.
 *
 * **Every verb answers; none throws.** `gh.ts`'s rule, and the reason
 * `GhResult` exists: a rail that cannot render because GitHub is unreachable
 * tells the user this app is broken, when the truth is that GitHub is
 * unreachable.
 *
 * ## Why `gh` is re-resolved on every read
 *
 * `probeCommand` searches the `PATH` a *session* would search, which is the
 * config's runtime environment and can be edited in the settings pane while the
 * app runs. Resolving once at startup would keep reporting "not installed"
 * after the user fixed exactly the thing the message told them to fix.
 */

export interface Github {
  /** Every PR worth showing, across the configured project repositories. */
  prs(): Promise<GhResult<PrsSnapshot>>;
  /**
   * Every PR matching `term`, whoever wrote it (the PRs panel's search row).
   *
   * `projectId` narrows the sweep to one mapped project — the session the user
   * is watching — and its absence means every mapped project. That is the
   * checkbox in the panel, and it is the *only* axis the user can widen: with
   * or without it, the search reaches the repositories the config maps and no
   * others. There is no "all of GitHub" here, deliberately; see
   * `buildSearchVariables`.
   *
   * A `projectId` naming no mapped project resolves to an empty repository list
   * and is refused by the client's scope check, which is the honest answer —
   * better than silently widening to everything the user did not ask for.
   */
  searchPrs(term: string, projectId?: string): Promise<GhResult<PrRecord[]>>;
}

export interface GithubDeps {
  /** The current config. Read per call — projects change while the app runs. */
  config: () => ConfigSnapshot;
  /**
   * The environment a session would spawn with, merged by the caller.
   *
   * Injected rather than read here because `process.env` is not the answer: a
   * user whose `gh` lives somewhere only their shell profile knows about has it
   * in the config's runtime env, and reporting on a `PATH` no session uses
   * would answer a different question than the one asked.
   */
  env: () => NodeJS.ProcessEnv;
  run: RunAsync;
  /** Injected so the merged window is testable without touching the clock. */
  now: () => number;
}

export function createGithub(deps: GithubDeps): Github {
  /**
   * Resolver and client are cached **per resolved `gh` path**.
   *
   * The resolver holds the directory→repository cache, which is the thing worth
   * keeping between polls; rebuilding it every minute would make the memo
   * pointless. Keying on the path means a `gh` that moved gets a fresh pair
   * rather than a cache built by the old one.
   */
  let cachedFor: string | null = null;
  let resolver: RepoResolver | null = null;
  let client: GithubClient | null = null;

  return {
    async prs() {
      const path = deps.env().PATH ?? '';
      const { resolved } = probeCommand('gh', path);

      if (resolved === null) {
        return {
          ok: false,
          error: {
            kind: 'not-installed',
            message: 'GitHub CLI (`gh`) was not found on this machine.',
          },
        };
      }

      if (cachedFor !== resolved || resolver === null || client === null) {
        cachedFor = resolved;
        resolver = createRepoResolver(resolved, deps.run);
        client = createGithubClient(resolved, deps.run);
      }

      const { repos, failure } = await resolver.resolve(deps.config().projects);

      /**
       * A resolution failure outranks the empty list it produced.
       *
       * Without this, a `gh` that is not logged in reports `no-repos` — because
       * `gh repo view` fails for every project, the list comes back empty, and
       * the sweep short-circuits on the count. The user would be told to fix
       * their project list, which was never the problem, while the message that
       * would actually help them (`gh auth login`) sat one layer down. The
       * failure is only preferred when there is genuinely nothing to sweep: a
       * machine where four repositories resolved and a fifth timed out still
       * gets its four.
       */
      if (repos.length === 0 && failure !== null) {
        return { ok: false, error: failure };
      }

      const result = await client.sweep(repos, deps.now());

      if (!result.ok) return result;

      return { ok: true, value: { prs: result.value, repos: repos.length } };
    },

    async searchPrs(term, projectId) {
      const path = deps.env().PATH ?? '';
      const { resolved } = probeCommand('gh', path);

      if (resolved === null) {
        return {
          ok: false,
          error: {
            kind: 'not-installed',
            message: 'GitHub CLI (`gh`) was not found on this machine.',
          },
        };
      }

      if (cachedFor !== resolved || resolver === null || client === null) {
        cachedFor = resolved;
        resolver = createRepoResolver(resolved, deps.run);
        client = createGithubClient(resolved, deps.run);
      }

      /*
        Narrowed before resolution, not after. Resolving every project to ask
        about one of them would spawn a `gh repo view` per project on the first
        keystroke of a search — and the resolver's cache is per directory, so
        the ones thrown away would not even be reused unless the user later
        widened.
      */
      const projects = deps.config().projects;
      const scoped =
        projectId === undefined
          ? projects
          : projects.filter((project) => project.id === projectId);

      const { repos, failure } = await resolver.resolve(scoped);

      // Same precedence as `prs()`: a resolution failure outranks the empty
      // list it produced, so `gh auth login` is not reported as `no-repos`.
      if (repos.length === 0 && failure !== null) {
        return { ok: false, error: failure };
      }

      return client.search(term, repos);
    },
  };
}
