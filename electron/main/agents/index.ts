/**
 * The agents runtime (HIVE-114).
 *
 * A thin composition root: it binds the registry to the two roots it needs and
 * nothing else. The registry itself takes both as arguments so it stays
 * testable against a temp directory, which is why this file exists rather than
 * `registry.ts` reaching for `agentsRoot()` itself.
 *
 * `skillNames` is a *function*, not a snapshot: skills can be written while
 * the app runs, and an agent naming a skill the user added a minute ago must
 * validate against the folder as it is now, not as it was at boot.
 *
 * It resolves **three** roots, not one. An agent is a `claude -p` process on
 * this machine, so it already loads the user's `~/.claude/skills` and their
 * installed plugins; validating against `~/.hive/skills` alone refused names
 * the agent could reach anyway, and refused every name at all on the fresh
 * install where that folder is empty. `available.ts` carries the argument in
 * full.
 */
import { readAvailableSkillNames } from '../skills/available';
import {
  installedPluginsFile,
  skillsRoot,
  userSkillsRoot,
} from '../skills/paths';

import { agentsRoot } from './paths';
import {
  createAgentRegistry,
  type AgentRegistry,
  type AgentRunFiles,
} from './registry';

export interface AgentsRuntimeOptions {
  /**
   * How a delete or a rename reaches the run bookkeeping that is keyed by an
   * agent's name but does not live in its folder (HIVE-115).
   *
   * Passed in rather than built here for the reason this whole file exists: it
   * needs `agents.json`, which only `ipc/index.ts` opens.
   */
  runFiles?: AgentRunFiles;
}

export function createAgentsRuntime(
  options: AgentsRuntimeOptions = {},
): AgentRegistry {
  return createAgentRegistry({
    root: agentsRoot(),
    skillNames: () =>
      readAvailableSkillNames({
        hive: skillsRoot(),
        user: userSkillsRoot(),
        installedPlugins: installedPluginsFile(),
      }),
    ...(options.runFiles === undefined ? {} : { runFiles: options.runFiles }),
  });
}

export type { AgentRegistry, AgentRunFiles } from './registry';
