import { useMemo, useRef } from 'react';

import { TerminalHost } from '@components/terminal/terminal-host';
import {
  ORCHESTRATOR_ID,
  createStaticTransport,
} from '@lib/terminal/static-transport';
import type { TerminalTransport } from '@lib/terminal/terminal-transport';
import { useAgentOrder, useNavOrder } from '@stores/hive-store';
import { useActiveTab, useTheme } from '@stores/ui-store';

/**
 * Center stage — the terminal, and everything that frames it.
 *
 * `min-w-0` is load-bearing, not defensive: without it this flex child refuses
 * to shrink below its content, a long terminal line widens the column, and
 * xterm's fit addon measures the widened box and grows into it. The rails are
 * fixed-width, so this column is what absorbs every window resize.
 *
 * This is the composition root for the stage: it is allowed to reach into the
 * stores precisely so that `components/terminal/` never has to. Story 040 adds
 * the view-state machine (picker / orchestrator / session / agent) and the
 * session meta bar around what is mounted here.
 */
export function CenterStage() {
  const theme = useTheme();
  const activeTab = useActiveTab();
  const navOrder = useNavOrder();
  const agentOrder = useAgentOrder();

  const ids = useMemo(
    () => [ORCHESTRATOR_ID, ...navOrder, ...agentOrder],
    [navOrder, agentOrder],
  );

  /**
   * Transports are created once per entity and cached for the life of the app.
   * Identity matters: `TerminalSurface` resubscribes whenever its transport
   * changes, so rebuilding these each render would tear down and replay every
   * transcript on every unrelated state change.
   */
  const cache = useRef(new Map<string, TerminalTransport>());

  const entries = useMemo(
    () =>
      ids.map((id) => {
        let transport = cache.current.get(id);
        if (!transport) {
          transport = createStaticTransport(id);
          cache.current.set(id, transport);
        }
        // Read-only for the whole prototype: every view that accepts input
        // does it through a DOM row beside the terminal (stories 041, 043).
        return { id, transport, readOnly: true };
      }),
    [ids],
  );

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-panel-2">
      <div className="flex min-h-0 flex-1 flex-col">
        <TerminalHost entries={entries} activeId={activeTab} theme={theme} />
      </div>
    </main>
  );
}
