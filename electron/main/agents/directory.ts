/**
 * The agents directory, as a peer sees it (HIVE-127).
 *
 * Pure, and separate from the route that serves it, because everything worth
 * getting wrong here is a data decision: who is excluded, which status is
 * reported, and — most of all — which fields cross the process boundary into
 * another model's context.
 *
 * The projection is a **whitelist**, written out field by field rather than
 * spread-and-delete. {@link AgentSummary} carries `sessionUuid` (a live
 * conversation id), `cost`, `today` and `dailyUsd`; a subtractive projection
 * would hand all of them to a peer the day someone adds a field to that type
 * and does not think about this file.
 */

import {
  type AgentRunState,
  type AgentsDirectory,
  type AgentsDirectoryEntry,
  type AgentsSnapshot,
} from '@shared/agent-contract';
import {
  ProjectAutoMergeRefused,
  type ConfigSnapshot,
  type ProjectAutoMergeRequest,
  type ProjectsDirectory,
  type ProjectsDirectoryEntry,
  type SetProjectAutoMergeRequest,
} from '@shared/config-contract';

import { mergeRunState } from './summary';

export function agentsDirectoryFor(
  caller: string,
  snapshot: AgentsSnapshot,
  state: Record<string, AgentRunState>,
): AgentsDirectory {
  /*
    Joined before projecting, and not optional: `registry.list()` hard-codes
    `sleeping` because it has no way to tell whether a process is running, and
    only `agents.json` has ever seen one. Reusing `mergeRunState` rather than
    reading the state file directly keeps one answer to "what is this agent
    doing" for the directory and the Agents tab alike.
  */
  const joined = mergeRunState(snapshot, state);

  const agents = joined.agents
    // A caller is not its own peer, and it already knows what it is for.
    .filter((agent) => agent.name !== caller)
    .map((agent): AgentsDirectoryEntry => {
      const entry: AgentsDirectoryEntry = {
        name: agent.name,
        description: agent.description,
        status: agent.status,
        /*
          Copied, so nothing handed across the boundary is an alias into the
          registry's own snapshot — a caller that mutated one would otherwise
          be editing what the next caller is shown.
        */
        accepts: [...agent.wake.on],
        tools: [...agent.tools],
      };

      return agent.invalid === undefined ? entry : { ...entry, invalid: agent.invalid };
    })
    /*
      Sorted so two calls a second apart read the same way — `readdir` order is
      the filesystem's business, not a contract — and so a test can assert an
      order at all.
    */
    .sort((a, b) => a.name.localeCompare(b.name));

  return { agents };
}

/**
 * The config's projects as an agent may see them (HIVE-173).
 *
 * A whitelist written field by field, as {@link agentsDirectoryFor} is: `env`,
 * `shell` and `claudeCommand` never cross, and a field added to
 * `ProjectConfig` later is ignored until someone decides an agent may see it.
 */
export function projectsDirectoryFor(snapshot: ConfigSnapshot): ProjectsDirectory {
  const projects = snapshot.projects.map((project): ProjectsDirectoryEntry => {
    const entry: ProjectsDirectoryEntry = {
      id: project.id,
      key: project.key,
      name: project.name,
      path: project.path,
      status: project.status,
      origin: project.origin,
      autoMerge: project.autoMerge === true,
    };
    if (project.container !== undefined) {
      entry.container = { workspace: project.container.workspace };
    }
    return entry;
  });

  return { projects };
}

/** What {@link projectAutoMergeFor} needs from the config module; injected so a test can fail the write. */
export interface ProjectAutoMergeDeps {
  config: () => ConfigSnapshot;
  setAutoMerge: (request: SetProjectAutoMergeRequest) => ConfigSnapshot;
}

/**
 * The `project_auto_merge` tool's work (retro B): find the project by id,
 * then by key, write the switch, and answer the directory `projects` answers
 * from the snapshot the write produced.
 *
 * Every refusal is a {@link ProjectAutoMergeRefused} with a sentence for the
 * model. A write the config refused is reported without the config's own
 * reason, which can quote a path; that reason goes to the log.
 */
export function projectAutoMergeFor(
  request: ProjectAutoMergeRequest,
  deps: ProjectAutoMergeDeps,
): ProjectsDirectory {
  const projects = deps.config().projects;
  const target =
    projects.find((project) => project.id === request.project) ??
    projects.find((project) => project.key === request.project);

  if (target === undefined) {
    const keys = projects.map((project) => project.key).join(', ');
    throw new ProjectAutoMergeRefused(
      `no project "${request.project}" is configured${keys === '' ? '' : ` (keys: ${keys})`}; nothing was changed`,
    );
  }

  const written = deps.setAutoMerge({ id: target.id, autoMerge: request.on });
  const landed = written.projects.find((project) => project.id === target.id);
  if ((landed?.autoMerge === true) !== request.on) {
    console.warn(`[agents] auto-merge for ${target.id} was not written: ${written.errors.join('; ')}`);
    throw new ProjectAutoMergeRefused(
      `the config could not be written, so auto-merge for "${target.id}" is unchanged`,
    );
  }

  return projectsDirectoryFor(written);
}
