import type { ConfigSnapshot, ProjectConfig } from '@shared/config-contract';
import { OVERMIND, type LedgerPostRequest } from '@shared/ledger-contract';

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

/**
 * The rule for one repository, or `null` when the slug could not be composed
 * safely.
 *
 * `--repo <slug>` is the **last** thing on the line, with no wildcard after
 * it. `gh` reads the last `--repo` it is given, so a trailing `*` would let
 * consent for one repository carry `--repo victim/other` after the granted
 * slug and merge there instead (whole-branch review, HIVE-166). With the slug
 * pinned at the end an earlier `--repo` is the one overridden, and `merge-pr`
 * spells its command with `--repo` last for exactly this reason. The glob is
 * case-sensitive where GitHub's slugs are not, which fails closed: a merge
 * spelled in another case raises the card.
 */
export function autoMergeRule(repo: RepoRef): string | null {
  if (!SAFE_SEGMENT.test(repo.owner) || !SAFE_SEGMENT.test(repo.name)) return null;
  return `Bash(gh pr merge * --repo ${repo.owner}/${repo.name})`;
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

/**
 * The posts that tell the shipper a project's merge consent changed (retro C).
 *
 * A config change reaches no agent through the ledger. On 2026-09-12 the
 * person turned auto-merge on while a PR sat at `approval`, and the shipper's
 * next interval wake read an inbox with nothing addressed to it and ended. One
 * directed `post` per project whose `autoMerge` flipped, either way, wakes the
 * shipper at once (a directed post is a waking kind) with the reason in its
 * inbox, so a row about to merge also learns that consent was withdrawn.
 *
 * Nothing for the first load (`before` is `null`, and a boot is not a
 * change), for a project that was not there before, or when no agent named
 * {@link AUTO_MERGE_AGENT} exists to read it.
 */
export function autoMergeNotices(
  before: ConfigSnapshot | null,
  after: ConfigSnapshot,
  hasShipper: boolean,
): LedgerPostRequest[] {
  if (before === null || !hasShipper) return [];

  const was = new Map(before.projects.map((project) => [project.id, project.autoMerge === true]));
  const posts: LedgerPostRequest[] = [];

  for (const project of after.projects) {
    const on = project.autoMerge === true;
    const prior = was.get(project.id);
    if (prior === undefined || prior === on) continue;

    posts.push({
      from: OVERMIND,
      to: AUTO_MERGE_AGENT,
      kind: 'post',
      body:
        `Auto-merge turned ${on ? 'on' : 'off'} for ${project.name} (${project.path ?? 'no path'})\n` +
        `Re-run approval for every row whose path is ${project.path ?? 'this project'} in this wake.`,
      meta: { kind: 'auto-merge', project: project.id, path: project.path, autoMerge: on },
    });
  }

  return posts;
}
