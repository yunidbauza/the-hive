import { AgentRow } from '@features/agents/components/agent-row';
import { useAgentOrder } from '@stores/hive-store';

/**
 * Agents panel — the long-lived background agents and their live status.
 *
 * Agents are fixture-defined in this phase: there is no create or pause here,
 * and `agentOrder` is the whole list. Clicking one opens its terminal, which is
 * the session view with agent chips (043).
 */
export function AgentsPanel() {
  const agentOrder = useAgentOrder();

  return (
    <div data-panel="agents" className="flex flex-col gap-0.5">
      {agentOrder.map((id) => (
        <AgentRow key={id} id={id} />
      ))}
    </div>
  );
}
