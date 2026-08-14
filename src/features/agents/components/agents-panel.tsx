import { EmptyState } from '@components/ui/empty-state';
import { AgentRow } from '@features/agents/components/agent-row';
import { useAgentOrder } from '@stores/hive-store';

/**
 * Agents panel — the long-lived background agents and their live status.
 *
 * `agentOrder` is the whole list; clicking one opens its terminal, which is the
 * session view with agent chips (043).
 *
 * ## Empty until something can create one
 *
 * This panel used to list three seeded agents — a Slack watcher, a PR reviewer,
 * a standup writer — which were a sketch of a feature rather than a feature.
 * Nothing in the app started them, nothing could stop them, and their
 * transcripts were recordings. They are gone with the rest of the seed.
 *
 * That leaves the list genuinely empty, and honestly so: there is no way to
 * create a background agent yet, so the copy names that instead of pointing at
 * a settings page that cannot help.
 */
export function AgentsPanel() {
  const agentOrder = useAgentOrder();

  if (agentOrder.length === 0) {
    return (
      <div data-panel="agents" className="flex flex-col gap-0.5">
        <EmptyState
          phrase="empty.agents"
          creature="hydralisk"
          action="Background agents are not available yet."
        >
          No agents running.
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
