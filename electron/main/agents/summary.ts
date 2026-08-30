/**
 * What `agents:list` answers once runs exist (HIVE-115).
 *
 * The registry reads *definitions* and knows nothing about runs; `state.ts`
 * holds the runs and knows nothing about definitions. Neither can be given the
 * other without one of them growing a dependency it has no other use for, so
 * the join is a function, and it is pure.
 *
 * It matters that this exists at all: HIVE-115 widened {@link AgentSummary}
 * with `sessionUuid`, `runsSinceRotate` and `cost`, and until something filled
 * them in, `agents:list` was answering `undefined` for all three forever — a
 * contract that compiles and is never true.
 */
import {
  formatRunCost,
  type AgentRunState,
  type AgentsSnapshot,
  type AgentSummary,
} from '@shared/agent-contract';

/**
 * A definition plus what has happened to it.
 *
 * The definition wins on everything it knows — name, description, icon, wake —
 * and the state wins on everything it knows, `status` included. A row that says
 * `working` is a row about a process, and only `agents.json` has ever seen one;
 * `registry.list()` hard-codes `sleeping` because it has no way to tell.
 *
 * An agent with no entry in the state file is left exactly as the registry
 * described it. That is the fresh-install case and it is also the case where a
 * hand-deleted `agents.json` is being recovered from — in both, "nothing has
 * run yet" is the truth, and inventing zeroed fields would only make an agent
 * that has never run indistinguishable from one whose history was lost.
 */
export function mergeRunState(
  snapshot: AgentsSnapshot,
  state: Record<string, AgentRunState>,
): AgentsSnapshot {
  return {
    ...snapshot,
    agents: snapshot.agents.map((agent) => withRunState(agent, state[agent.name])),
  };
}

function withRunState(
  agent: AgentSummary,
  run: AgentRunState | undefined,
): AgentSummary {
  if (run === undefined) return agent;

  const last = run.runs[run.runs.length - 1];
  const cost = formatRunCost(last?.costUsd);

  return {
    ...agent,
    status: run.status,
    runsSinceRotate: run.runsSinceRotate,
    /*
      The whole history, not just `last` (HIVE-116). `cost` below is still the
      most recent run's, because a row draws one number; the view's `Today`
      tile draws a count and a sum, which no single summary can answer.

      `rotateAfter` is deliberately absent from this list: it is the
      definition's, the registry has already put it on `agent`, and the spread
      above carries it through untouched.
    */
    runs: run.runs,
    ...(run.lastRunAt === undefined ? {} : { lastRunAt: run.lastRunAt }),
    ...(run.nextRunAt === undefined ? {} : { nextRunAt: run.nextRunAt }),
    ...(run.sessionUuid === undefined ? {} : { sessionUuid: run.sessionUuid }),
    ...(cost === undefined ? {} : { cost }),
  };
}
