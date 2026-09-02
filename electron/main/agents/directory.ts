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
