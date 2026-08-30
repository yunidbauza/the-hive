import { useEffect } from 'react';

import { agentsSnapshot, loadAgents, subscribeAgents } from '@/lib/agents';

import {
  useAppendAgentLines,
  useHydrateAgents,
  useSetAgentStatus,
} from '@stores/hive-store';

/**
 * Keep the fleet's agents in step with `~/.hive/agents` (HIVE-114).
 *
 * Mounted once at the composition root, for the reason `useLedgerSync` is:
 * `agents:changed` is a broadcast, and a per-consumer subscription would mean
 * one listener per row for one channel.
 *
 * ## Two mirrors, one fetch
 *
 * The definitions land in two places — `lib/agents.ts`'s snapshot, which the
 * Settings pane reads, and the store's `entities`, which the rail reads. They
 * are filled from the *same* `list()` rather than each fetching its own,
 * because two independent reads of a folder the user is editing can disagree,
 * and a pane insisting an agent exists while the rail insists it does not is a
 * bug with no visible cause.
 *
 * ## Subscribe, then fetch
 *
 * The same ordering `useLedgerSync` documents, and it matters more here: this
 * hook mounts once and never remounts, and unlike the ledger these snapshots
 * *replace* rather than merge, so a change landing between the fetch and the
 * subscription would not be re-fetched by anything and the list would simply
 * stay wrong until the next edit.
 *
 * On the browser target there is no bridge and this does nothing.
 */
export function useAgentsSync(): void {
  const hydrate = useHydrateAgents();
  const setStatus = useSetAgentStatus();
  const appendLines = useAppendAgentLines();

  useEffect(() => {
    const agents = window.hive?.agents;

    if (agents === undefined) return;

    const pull = () => {
      void loadAgents();
    };

    const stopPush = agents.onChanged(pull);
    // The store follows the module's snapshot rather than fetching again, so
    // the two mirrors are filled from one read.
    const stopMirror = subscribeAgents(() => {
      hydrate(agentsSnapshot()?.agents ?? []);
    });
    // A run's status and its log lines arrive on their own channels — not a
    // folder change, so `pull`/`subscribeAgents` never see them.
    const stopStatus = agents.onStatus(setStatus);
    const stopLines = agents.onLines(appendLines);

    pull();

    return () => {
      stopPush();
      stopMirror();
      stopStatus();
      stopLines();
    };
  }, [hydrate, setStatus, appendLines]);
}
