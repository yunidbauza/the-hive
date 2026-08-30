import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  AGENT_RUN_HISTORY,
  type AgentRunState,
  type RunSummary,
} from '@shared/agent-contract';

/**
 * `~/.hive/ledger/agents.json` — the only rewritten file this epic owns
 * (HIVE-115).
 *
 * One debounced writer, following `sessions/history.ts`. Every other file in
 * `~/.hive` is either append-only (the ledger) or user-authored (definitions);
 * this one is main's own bookkeeping, and a run that ends writes three fields.
 * Coalescing them is what keeps a chatty agent from rewriting the file on
 * every event.
 *
 * Deliberately lenient: `writeFileSync` straight over the path, with none of
 * `config/write.ts`'s temp-file/fsync/rename. Losing the last few seconds of
 * bookkeeping to a crash costs an agent one duplicated wake; it cannot corrupt
 * a definition or a ledger entry, because it owns neither.
 */

const PERSIST_DEBOUNCE_MS = 400;

const EMPTY: AgentRunState = {
  status: 'sleeping',
  runsSinceRotate: 0,
  runs: [],
};

export interface AgentStateOptions {
  path: string;
  debounceMs?: number;
}

export interface AgentState {
  all(): Record<string, AgentRunState>;
  read(name: string): AgentRunState;
  patch(name: string, change: Partial<AgentRunState>): AgentRunState;
  recordRun(name: string, summary: RunSummary): void;
  /**
   * Drop this agent's entry — the definition is gone.
   *
   * Without it a name freed by a delete is reused with the previous agent's
   * session uuid, run history and rotation counter still attached to it. See
   * `AgentRunFiles` in `registry.ts` for what that actually does.
   */
  forget(name: string): void;
  /** Move an entry to a new name, so a rename keeps the conversation. */
  carry(from: string, to: string): void;
  /** Write now, synchronously. For shutdown. */
  flush(): void;
  /**
   * Drop a pending write **without** performing it.
   *
   * The opposite of {@link AgentState.flush}, and the reason it exists is the
   * same one `SessionHistory.dispose` exists for: the debounce timer closes
   * over the write directly, so letting go of the reference does not let go of
   * the timer. A spec that drives a run and then tears the handlers down would
   * otherwise leave a 400 ms fuse that fires afterwards and writes
   * `agents.json` at whatever `configPath()` was stubbed to — a test leaving a
   * file behind, in a directory that may by then belong to another test.
   */
  dispose(): void;
}

/**
 * No agent is `working` at the moment this file is read.
 *
 * `working` is a claim about a **live child process**, and every child this app
 * spawned died with it. A graceful quit records each run and leaves `sleeping`
 * behind, but a force-quit, a crash or a power cut runs no hook at all — and
 * the `working` that was true when the file was last written is then false and
 * unrecoverable. Nothing would ever correct it: the tracker's map starts empty,
 * so no `close` is coming, and `agents:kill` answers `false` for a name it does
 * not hold. The row would read `working` forever, with no way for the user to
 * clear it.
 *
 * `asking` is deliberately left alone. It is a claim about an unanswered entry
 * in the ledger, which is a file — it survives the crash, and it is still true.
 */
function wakeFromWorking(
  agents: Record<string, AgentRunState>,
): Record<string, AgentRunState> {
  const woken: Record<string, AgentRunState> = {};

  for (const [name, agent] of Object.entries(agents)) {
    woken[name] =
      agent.status === 'working' ? { ...agent, status: 'sleeping' } : agent;
  }

  return woken;
}

function seed(path: string): Record<string, AgentRunState> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }

    return wakeFromWorking(parsed as Record<string, AgentRunState>);
  } catch {
    /*
      A missing file is the fresh-install case and a corrupt one is a
      hand-edit gone wrong. Neither is a reason to refuse to start: this file
      is derived bookkeeping, and starting empty costs one extra wake per
      agent, where refusing to start costs the whole app.
    */
    return {};
  }
}

export function createAgentState(options: AgentStateOptions): AgentState {
  const debounceMs = options.debounceMs ?? PERSIST_DEBOUNCE_MS;
  const agents = seed(options.path);
  let timer: NodeJS.Timeout | null = null;

  const write = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }

    try {
      mkdirSync(dirname(options.path), { recursive: true });
      writeFileSync(
        options.path,
        `${JSON.stringify(agents, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // A failed write is the next write's problem. Throwing here would take
      // down a run that has otherwise succeeded.
    }
  };

  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(write, debounceMs);
    // Never hold the process open for a pending run-state write.
    timer.unref?.();
  };

  const state: AgentState = {
    all: () => ({ ...agents }),

    read: (name) => agents[name] ?? { ...EMPTY, runs: [] },

    patch(name, change) {
      const next = { ...(agents[name] ?? { ...EMPTY, runs: [] }), ...change };

      agents[name] = next;
      schedule();

      return next;
    },

    recordRun(name, summary) {
      const current = agents[name] ?? { ...EMPTY, runs: [] };
      const runs = [...current.runs, summary];

      agents[name] = {
        ...current,
        runs:
          runs.length > AGENT_RUN_HISTORY
            ? runs.slice(runs.length - AGENT_RUN_HISTORY)
            : runs,
      };
      schedule();
    },

    forget(name) {
      if (!(name in agents)) return;

      delete agents[name];
      schedule();
    },

    carry(from, to) {
      const entry = agents[from];

      if (entry === undefined) return;

      agents[to] = entry;
      delete agents[from];
      schedule();
    },

    flush: write,

    dispose() {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    },
  };

  return state;
}
