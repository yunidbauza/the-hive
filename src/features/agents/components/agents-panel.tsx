import { EmptyState } from '@components/ui/empty-state';
import { AgentRow } from '@features/agents/components/agent-row';
import { useAgentOrder } from '@stores/hive-store';

/**
 * Agents panel — the long-lived background agents and their live status.
 *
 * `agentOrder` is the whole list; clicking one opens its terminal, which is the
 * session view with agent chips (043).
 *
 * ## The list comes from disk
 *
 * This panel used to list three seeded agents — a Slack watcher, a PR reviewer,
 * a standup writer — which were a sketch of a feature rather than a feature.
 * Nothing started them, nothing could stop them, and their transcripts were
 * recordings. They went with the rest of the seed, leaving the list genuinely
 * empty and the copy pointing at nothing.
 *
 * Since HIVE-114 there is somewhere to point: `useAgentsSync` mirrors
 * `~/.hive/agents` into the store, so a row here is a real `AGENT.md`, and the
 * empty state names the pane that creates one. They still do not *run* — that
 * is HIVE-115 — which is why every row reads `sleeping`.
 */
export function AgentsPanel() {
  const agentOrder = useAgentOrder();

  if (agentOrder.length === 0) {
    return (
      <div data-panel="agents" className="flex flex-col gap-0.5">
        <EmptyState phrase="empty.agents" creature="hydralisk">
          No agents yet — create one in Settings › Agents.
        </EmptyState>
      </div>
    );
  }

  return (
    <div data-panel="agents" className="flex flex-col gap-0.5">
      {agentOrder.map((id) => (
        <AgentRow key={id} id={id} />
      ))}
    </div>
  );
}
