import { useSyncExternalStore } from 'react';

import { agentsSnapshot, subscribeAgents } from '@/lib/agents';

import type { AgentsSnapshot } from '@shared/agent-contract';

/**
 * The agent definitions on disk, or `null` while there are none (HIVE-114).
 *
 * A hook beside the module rather than components importing `lib/agents.ts`
 * directly — the same split `use-skills.ts` and `use-project-config.ts` keep,
 * and the rule `AGENTS.md` states.
 */
export function useAgents(): AgentsSnapshot | null {
  return useSyncExternalStore(subscribeAgents, agentsSnapshot, agentsSnapshot);
}
