import {
  AGENT_PENDING_WAKE_MAX,
  type PendingWakeEntry,
} from '@shared/agent-contract';
import type { LedgerEntry } from '@shared/ledger-contract';

import { decide } from './scheduler-rules';
import type { AgentState } from './state';

/**
 * The trigger word every wake in this module reports.
 *
 * It reaches the agent's own prompt — `You woke because: ledger — answer a12
 * from overmind` — so it is the word the model reads, not only a label for the
 * log.
 */
const LEDGER_TRIGGER = 'ledger';

export interface SchedulerDeps {
  /**
   * `RunTracker.run`, narrowed to what this module uses.
   *
   * A refusal is not an error here: `working` and `paused` are *answers*, and
   * queueing is what this module does about them. It is deliberately the
   * tracker rather than the waker — that method is the one door every trigger
   * passes through, and it is where a paused agent is refused. A second
   * entrance would let a ledger entry wake an agent the user had just stopped.
   */
  run: (name: string, trigger: string, extra?: string) => { started: boolean };
  state: Pick<AgentState, 'read' | 'patch' | 'all'>;
  /** Whether a party id names a registered agent rather than a session. */
  isAgent: (id: string) => boolean;
}

export interface Scheduler {
  /** One entry landed, from any party. */
  onEntry(entry: LedgerEntry): void;
  /** A run finished and its status is already on disk. */
  onRunClosed(name: string): void;
  /** A paused agent was resumed. */
  onResume(name: string): void;
  /** Boot: wake anything a crash left queued. */
  start(): void;
}

/** `ask a12 from overmind` — how a wake says what it woke for. */
const describeEntries = (queued: readonly PendingWakeEntry[]): string =>
  queued.map((item) => `${item.kind} ${item.id} from ${item.from}`).join(', ');

/**
 * Ledger-addressed wakes (HIVE-120).
 *
 * The scheduler subscribes to `ledger.onChange` alongside `deliver` and the
 * notifier, and turns an entry addressed to an agent into a wake — now, or at
 * the next moment the agent can take one. It is the half of the scheduler that
 * answers *something happened*; HIVE-121 adds the half that answers *time
 * passed*, to this same module.
 *
 * ## Why the queue lives on disk
 *
 * An entry that arrives mid-run is remembered in `agents.json` rather than in a
 * map here. The failure that prevents is silent rather than loud: a quit drops
 * an in-memory queue, and the asks behind those entries are still open with
 * nothing left to bring the agent back to them.
 */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  /**
   * Take the queue and wake once for all of it.
   *
   * **Cleared before the wake, never after.** The wake re-enters
   * `RunTracker.run`, and a spawn that fails synchronously finalizes the run
   * from inside that very call — arriving back at `onRunClosed` with this
   * function's caller still on the stack. A queue still standing at that moment
   * is an unbounded loop; clearing first makes the second pass find nothing.
   */
  const flush = (name: string): void => {
    const queued = deps.state.read(name).pendingWake ?? [];

    if (queued.length === 0) return;

    deps.state.patch(name, { pendingWake: [] });
    deps.run(name, LEDGER_TRIGGER, describeEntries(queued));
  };

  const enqueue = (name: string, entry: LedgerEntry): void => {
    const queued = deps.state.read(name).pendingWake ?? [];

    /*
      A full queue refuses the newcomer rather than evicting the entry that has
      waited longest — the oldest is the one most at risk of being forgotten.
      Nothing is lost by the refusal: this list exists to cause *one* wake, and
      the agent reads its own inbox on it.
    */
    if (queued.length >= AGENT_PENDING_WAKE_MAX) return;

    deps.state.patch(name, {
      pendingWake: [
        ...queued,
        { kind: entry.kind, id: entry.id, from: entry.from },
      ],
    });
  };

  return {
    onEntry(entry) {
      const to = entry.to;

      if (to === undefined || !deps.isAgent(to)) return;

      const decision = decide(deps.state.read(to).status, entry);

      if (decision === 'ignore') return;

      if (decision === 'wake') {
        deps.run(
          to,
          LEDGER_TRIGGER,
          `${entry.kind} ${entry.id} from ${entry.from}`,
        );
        return;
      }

      enqueue(to, entry);
    },

    onRunClosed(name) {
      /*
        Read back rather than trusted from the caller (HIVE-117).

        A pause is allowed to land while a turn is in flight — the design lets
        that turn finish — so `finalizeRun` holds `paused` rather than writing
        its computed resting status over it. An agent that was `working` when an
        entry was queued can therefore be `paused` by the time its run closes,
        and flushing then would reach `RunTracker.run`'s `refused: 'paused'`:
        the entries would be dropped while their asks stayed open, which is the
        worst of the three available outcomes.

        The pause outranks the flush. `onResume` delivers the queue instead,
        which is exactly what the paused rule already promises — reached by a
        path the story's delivery table did not anticipate.

        `pushAgentStatus` re-reads `agents.json` for this same reason, and its
        docblock records it.
      */
      if (deps.state.read(name).status === 'paused') return;

      flush(name);
    },

    onResume(name) {
      flush(name);
    },

    start() {
      /*
        A queue can outlive the app that made it.

        `agents.json` is read at boot through `wakeFromWorking`, which rewrites
        `working` to `sleeping` because no child of the last launch survived it.
        So an agent queued while working and then force-quit comes back resting,
        with a queue standing and **nothing that would ever flush it** — no run
        will close, and no resume is coming.

        A paused agent is skipped, for the reason `onRunClosed` skips one: the
        user stopped it, and boot is not a resume.
      */
      for (const [name, agent] of Object.entries(deps.state.all())) {
        if (agent.status === 'paused') continue;

        flush(name);
      }
    },
  };
}
