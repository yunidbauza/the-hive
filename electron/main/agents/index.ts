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
 */
import { skillsRoot } from '../skills/paths';
import { readUserSkills } from '../skills/read';

import { agentsRoot } from './paths';
import { createAgentRegistry, type AgentRegistry } from './registry';

export function createAgentsRuntime(): AgentRegistry {
  return createAgentRegistry({
    root: agentsRoot(),
    skillNames: async () =>
      (await readUserSkills(skillsRoot())).skills.map((skill) => skill.name),
  });
}

export type { AgentRegistry } from './registry';
