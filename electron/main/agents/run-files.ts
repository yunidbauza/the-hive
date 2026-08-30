/**
 * What a deleted or renamed agent leaves behind, cleaned up (HIVE-115).
 *
 * The registry moves `~/.hive/agents/<name>`; this moves the two things keyed
 * by that same name which are not in it — the `agents.json` entry, and
 * `~/.hive/work/<name>`. `AgentRunFiles` in `registry.ts` carries the argument
 * for why leaving them behind is a correctness bug rather than untidiness.
 *
 * The state is reached through a **function**, not a value: `ipc/index.ts`
 * builds the registry before it opens `agents.json`, so a captured reference
 * would be `null` forever. It stays `null` only in the browser-shaped case, and
 * "there is no state file" and "the entry is not in it" have the same
 * consequence here — nothing to forget.
 *
 * Nothing here throws. A delete whose bookkeeping could not be cleared is still
 * a delete, and the folder is already gone by the time this runs; failing loudly
 * would turn a tidy-up into a refusal the user cannot act on. The generated
 * `<name>.system.md` is deliberately not touched: it is rewritten from the
 * definition on every wake, so it self-heals and a stale one is unreachable.
 */
import { rename, rm } from 'node:fs/promises';

import type { AgentRunFiles } from './registry';
import type { AgentState } from './state';

export interface AgentRunFilesDeps {
  /** `agents.json`, once it has been opened. */
  state: () => AgentState | null;
  /** `~/.hive/work/<name>`. */
  workdir: (name: string) => string;
}

export function createAgentRunFiles(deps: AgentRunFilesDeps): AgentRunFiles {
  return {
    async forget(name) {
      deps.state()?.forget(name);

      try {
        await rm(deps.workdir(name), { recursive: true, force: true });
      } catch {
        // A workdir that will not go is scratch nobody reads. The entry it
        // belonged to is already gone, so nothing can find it again.
      }
    },

    async carry(from, to) {
      deps.state()?.carry(from, to);

      try {
        await rename(deps.workdir(from), deps.workdir(to));
      } catch {
        // No workdir yet (an agent that has never run), or a destination that
        // somehow exists. Either way the next wake makes one — `wake-command`
        // mkdirs it — and losing scratch is not worth failing a rename over.
      }
    },
  };
}
