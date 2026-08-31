import {
  AGENT_PENDING_WAKE_MAX,
  type PendingWakeEntry,
} from '@shared/agent-contract';
import {
  OVERMIND,
  type LedgerEntry,
  type LedgerPostRequest,
} from '@shared/ledger-contract';
import { expiredAsks } from '@shared/ledger-derive';

import { decide, decideForStatus, type WakeDecision } from './scheduler-rules';
import type { AgentState } from './state';

/**
 * The trigger word every wake in this module reports.
 *
 * It reaches the agent's own prompt — `You woke because: ledger — answer a12
 * from overmind` — so it is the word the model reads, not only a label for the
 * log.
 */
const LEDGER_TRIGGER = 'ledger';

/**
 * How often main looks for asks that time has retired.
 *
 * A minute rather than anything finer because the deadline it enforces is
 * measured in hours: {@link LEDGER_ASK_TTL_MS} is a day, and an ask that dies
 * up to sixty seconds late has cost nobody anything.
 */
export const LEDGER_SWEEP_MS = 60_000;

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
  /**
   * Whether this agent's definition asks to be woken by the log at all.
   *
   * `wake.on: [ledger]` is a **gate**, not a hint, and the Settings copy says so
   * in as many words: "Without it, only the schedule wakes it, and a question
   * addressed to it waits unread until then." An agent whose author unticked it
   * must not spend turns and budget on entries they opted out of.
   */
  wakesOnLedger: (name: string) => boolean;
  /**
   * The log, narrowed to the two things the sweep does with it.
   *
   * `read` rather than a snapshot handed in, because the sweep runs on a timer
   * and must see the log as it is at that moment, not as it was when this
   * module was built.
   */
  ledger: {
    read: () => { entries: readonly LedgerEntry[] };
    /**
     * Reports rather than throws, like `Ledger.append` itself — and the report
     * is read: a sweep that assumed its write landed would re-expire the same
     * ask every minute forever.
     */
    append: (request: LedgerPostRequest) => { ok: boolean };
  };
  now: () => number;
  /** Injected by the unit test, as in `splash.ts`. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface Scheduler {
  /** One entry landed, from any party. */
  onEntry(entry: LedgerEntry): void;
  /** A run finished and its status is already on disk. */
  onRunClosed(name: string): void;
  /** A paused agent was resumed. */
  onResume(name: string): void;
  /** Boot: wake anything a crash left queued, and arm the expiry sweep. */
  start(): void;
  /** Shutdown: disarm the sweep. */
  stop(): void;
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
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;

  let sweeping: ReturnType<typeof setInterval> | undefined;
  /**
   * Set by {@link Scheduler.stop}, and honoured by **every** entry point.
   *
   * Disarming the interval alone is not enough to stop this module. Shutdown
   * calls `RunTracker.closeAll`, which finalizes each live run synchronously and
   * so re-enters `onRunClosed` — where a flush would spawn a fresh `claude` that
   * `closeAll` has already finished iterating past, leaving an orphan with
   * nobody left to signal it. That is the exact process the quit hook exists to
   * prevent, so the gate has to cover the callbacks and not just the timer.
   */
  let stopped = false;

  /**
   * One entry, as the wake prompt names it.
   *
   * Shared by the immediate path and the queue so a wake reads the same however
   * it was reached.
   */
  const describeEntry = (entry: {
    kind: string;
    id: string;
    from: string;
  }): string => `${entry.kind} ${entry.id} from ${entry.from}`;

  /**
   * Retire the asks time has taken, once a minute.
   *
   * Reads {@link expiredAsks} rather than `openAsks`, and has to: `openAsks`
   * drops an ask the moment it crosses its ttl, so the entries this is looking
   * for are precisely the ones that function hides.
   *
   * The event is appended `from` the overmind — main is retiring the question,
   * not the party who asked it — and names the ask as its `thread`, which
   * `Ledger.append` permits on any kind (only an `answer` must find its thread
   * still open). It does not *close* the ask: `expiredAsks` dedupes on the
   * event's own presence, and that is what makes this idempotent across
   * restarts while the sweep keeps no state of its own.
   */
  const sweep = (): void => {
    if (stopped) return;

    const now = deps.now();

    for (const ask of expiredAsks(deps.ledger.read().entries, now)) {
      const written = deps.ledger.append({
        from: OVERMIND,
        to: ask.from,
        kind: 'event',
        thread: ask.id,
        body: `ask ${ask.ref ?? ask.id} expired`,
        meta: { expired: ask.id },
      });

      /*
        The write is the dedup, so a failed write must not be followed by a wake.

        `Ledger.append` reports a failure as a value rather than throwing, and
        without this the entry that would have retired this ask is missing while
        the wake still fires — so a full disk or a moved `~/.hive` would spawn a
        fresh headless run for every expired ask, every sixty seconds, for as
        long as the condition lasts.
      */
      if (!written.ok) {
        console.warn(`[hive] could not retire ${ask.id}; leaving it open`);
        continue;
      }

      /*
        Woken here rather than by routing the event above back through
        `onEntry`.

        Reaching the asker that way would mean putting `event` in
        `WAKING_KINDS` — and every `run.started` and `run.ended` is an event, so
        each wake would cause the next one. The asker is known right here; there
        is nothing to gain by asking the log to tell us what we just wrote.

        Through `route` rather than `run`, though: an asker that is mid-run or
        paused would otherwise lose the news for good, because the expiry event
        is on disk by now and this sweep will never look at that ask again.
      */
      if (deps.isAgent(ask.from) && deps.wakesOnLedger(ask.from)) {
        route(ask.from, decideForStatus(deps.state.read(ask.from).status), {
          kind: 'expired',
          id: ask.id,
          from: OVERMIND,
        });
      }
    }
  };

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
    if (stopped) return;

    const queued = deps.state.read(name).pendingWake ?? [];

    if (queued.length === 0) return;

    deps.state.patch(name, { pendingWake: [] });

    const started = deps.run(name, LEDGER_TRIGGER, describeEntries(queued));

    if (started.started) return;

    /*
      Put it back. A refusal is not a delivery.

      `RunTracker.run` has three refusal paths that never reach `onRunClosed` —
      `working`, `paused`, and a command that could not be built — and on every
      one of them these entries would otherwise be gone with their asks still
      open, which is the silent loss the on-disk queue exists to prevent. The
      commonest case is not a race: at boot `mcp.start()` is still in flight, so
      `wake-command` refuses for a config that is not written yet.

      Restoring cannot loop. The one refusal that re-enters this function is a
      synchronous spawn failure, and it finalizes — and so flushes — while the
      queue is still empty, before this line puts anything back.

      Anything that arrived while the wake was being refused is kept: the
      restored entries go in front of it, oldest first, and the cap is applied
      to the result so a refusal cannot grow the queue past it.
    */
    const since = deps.state.read(name).pendingWake ?? [];

    deps.state.patch(name, {
      pendingWake: [...queued, ...since].slice(0, AGENT_PENDING_WAKE_MAX),
    });
  };

  const enqueue = (name: string, entry: PendingWakeEntry): void => {
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

  /**
   * Wake now, or queue for the first moment the agent can take it.
   *
   * The single path both callers use — an entry arriving, and the sweep
   * retiring an ask — so an expiry cannot reach an agent by a route that skips
   * the queue. It used to, and a `working` or `paused` asker lost the news
   * permanently: the expiry event is already on disk by then, so the sweep's
   * own dedup would never revisit it.
   *
   * **A refused wake is queued, not dropped.** `RunTracker.run` refuses without
   * ever reaching `onRunClosed` when the agent is `working` or `paused`, or when
   * the command cannot be built — which at boot is the ordinary case rather than
   * an edge one, because `mcp.start()` is still in flight. Queueing there turns
   * every one of those into a delivery deferred rather than a question lost.
   */
  const route = (name: string, decision: WakeDecision, item: PendingWakeEntry): void => {
    if (decision === 'wake' && deps.run(name, LEDGER_TRIGGER, describeEntry(item)).started) {
      return;
    }

    enqueue(name, item);
  };

  return {
    onEntry(entry) {
      if (stopped) return;

      const to = entry.to;

      if (to === undefined || !deps.isAgent(to)) return;
      /*
        The definition's own gate (`wake.on: [ledger]`).

        Checked before the queue as well as before the wake: an agent that does
        not take ledger wakes should not accumulate a queue of entries that
        nothing will ever deliver, and whose only effect would be to fire on the
        day its author ticks the box.
      */
      if (!deps.wakesOnLedger(to)) return;

      const decision = decide(deps.state.read(to).status, entry);

      if (decision === 'ignore') return;

      route(to, decision, { kind: entry.kind, id: entry.id, from: entry.from });
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
      if (stopped) return;
      if (deps.state.read(name).status === 'paused') return;

      flush(name);
    },

    onResume(name) {
      flush(name);
    },

    start() {
      // Arming twice would leak the first interval beyond any `stop()`.
      if (sweeping !== undefined) return;

      stopped = false;

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

      sweeping = setIntervalFn(sweep, LEDGER_SWEEP_MS);
      // Never a reason to hold the process open — the app's windows do that.
      // Optional because a test's injected timer is a plain handle.
      sweeping.unref?.();
    },

    stop() {
      /*
        The flag first, and it is the half that matters.

        Shutdown calls `RunTracker.closeAll`, which finalizes every live run
        synchronously and so re-enters `onRunClosed` from inside the teardown.
        With only the interval disarmed, that flush would spawn a fresh `claude`
        after `closeAll` had already finished iterating the runs it knew about —
        an orphan with nobody left to signal it, which is precisely what the quit
        hook exists to prevent.
      */
      stopped = true;

      if (sweeping === undefined) return;

      clearIntervalFn(sweeping);
      sweeping = undefined;
    },
  };
}
