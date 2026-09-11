import type { ProjectConfig } from '@shared/config-contract';

import type { RepoRef } from '../integrations/github/query';

/**
 * The shipper's merge grant (HIVE-166).
 *
 * `ship`'s one human checkpoint is the merge, and in the Hive that checkpoint
 * is the permission fence: the shipper agent does not hold `gh pr merge`, so
 * the call stops and becomes an inbox card. A project the user has marked
 * `autoMerge: true` is consent to skip that card for *that repository*, and
 * consent here is a **grant**, not a flag a skill reads: at wake time this
 * module turns every such project into one rule on the shipper's
 * `HIVE_GRANTS`, so the one call the fence would stop goes through and every
 * other project's merge still lands on the inbox.
 *
 * ## Why a grant rather than an answer at the fence
 *
 * Answering the ask inside `approve` would mean a card that raises and
 * dismisses itself, an `event` explaining why, and a decision path that runs
 * on every denied call. A grant composes with what exists: `matches` in
 * `@shared/permission-rules` already reads `Bash(<glob>)`, `wake-command.ts`
 * already carries per-wake grants, and the run log already shows them. The
 * rule is scoped as narrowly as the grammar allows: `gh pr merge`, any
 * number, this repository by `--repo`, and the glob's own guard refuses a
 * candidate carrying shell control characters.
 *
 * ## The repository slug
 *
 * A project entry names a folder, not a repository; the slug comes from
 * `gh repo view --json nameWithOwner` through the GitHub integration's
 * resolver, which is asynchronous and can fail offline. So the map is
 * refreshed in the background and read synchronously at wake time: a project
 * whose slug is not known yet grants nothing, and its merge raises the card.
 * That is the safe failure, and it costs one card, once.
 *
 * Only the agent named {@link AUTO_MERGE_AGENT} ever receives the grant. A
 * `fixer` or `builder` with `autoMerge` in its config would otherwise be
 * handed a merge nobody asked it to make.
 */

export const AUTO_MERGE_AGENT = 'shipper';

/** GitHub's own alphabet for owners and repositories; nothing the glob reads. */
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** The rule for one repository, or `null` when the slug could not be composed safely. */
export function autoMergeRule(repo: RepoRef): string | null {
  if (!SAFE_SEGMENT.test(repo.owner) || !SAFE_SEGMENT.test(repo.name)) return null;
  return `Bash(gh pr merge * --repo ${repo.owner}/${repo.name} *)`;
}

/** Pure: the rules for `name`, given the projects and what is known of their repositories. */
export function autoMergeRulesFor(
  name: string,
  projects: readonly ProjectConfig[],
  repoOf: (projectId: string) => RepoRef | undefined,
): string[] {
  if (name !== AUTO_MERGE_AGENT) return [];
  const rules: string[] = [];
  for (const project of projects) {
    if (project.autoMerge !== true) continue;
    const repo = repoOf(project.id);
    if (repo === undefined) continue;
    const rule = autoMergeRule(repo);
    if (rule !== null && !rules.includes(rule)) rules.push(rule);
  }
  return rules;
}

export interface AutoMergeDeps {
  projects: () => readonly ProjectConfig[];
  /** `Github.resolveProjects`: project id → repository, for the projects it can answer for. */
  resolve: () => Promise<Map<string, RepoRef>>;
}

export interface AutoMergeGrants {
  /**
   * The rules for this wake. Synchronous, from the last refresh; a flagged
   * project with no known slug schedules a refresh and grants nothing yet.
   */
  grantsFor(name: string): string[];
  /** Resolve every project's repository now. Never rejects. */
  refresh(): Promise<void>;
}

export function createAutoMergeGrants(deps: AutoMergeDeps): AutoMergeGrants {
  let known = new Map<string, RepoRef>();
  let inFlight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    if (inFlight !== null) return inFlight;
    inFlight = deps
      .resolve()
      .then((map) => {
        // Merge, never replace: an offline sweep answers for nobody, and
        // forgetting the slugs it did know would raise cards for repositories
        // that were fine an hour ago.
        for (const [id, repo] of map) known.set(id, repo);
      })
      .catch(() => {
        /* offline, logged out, no gh: the next wake asks again */
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    refresh,
    grantsFor(name) {
      const projects = deps.projects();
      // Drop slugs for projects that no longer exist, so a removed entry
      // cannot keep a grant alive through a stale map.
      const live = new Set(projects.map((project) => project.id));
      known = new Map([...known].filter(([id]) => live.has(id)));

      const rules = autoMergeRulesFor(name, projects, (id) => known.get(id));
      const wanting = projects.some(
        (project) => project.autoMerge === true && !known.has(project.id),
      );
      if (name === AUTO_MERGE_AGENT && wanting) void refresh();
      return rules;
    },
  };
}
