import {
  AGENT_PENDING_WAKE_MAX,
  dayKey,
  type AgentRunResult,
  type AgentRunState,
  type PendingWakeEntry,
  type WakeSpec,
} from '@shared/agent-contract';
import {
  OVERMIND,
  type LedgerEntry,
  type LedgerPostRequest,
} from '@shared/ledger-contract';
import { expiredAsks } from '@shared/ledger-derive';
import { SLACK_SERVER_KEY } from '@shared/slack-contract';

import type { RunStart } from './runs';
import { decide, decideForStatus, type WakeDecision } from './scheduler-rules';
import type { AgentState } from './state';
import { inQuiet, nextRunFrom, quietEndAfter } from './wake-schedule';

/**
 * The trigger word every *ledger-routed* wake in this module reports.
 *
 * It reaches the agent's own prompt — `You woke because: ledger — answer a12
 * from overmind` — so it is the word the model reads, not only a label for the
 * log.
 */
const LEDGER_TRIGGER = 'ledger';

/**
 * What a wake reports when a person's own run is the reason for it (HIVE-126).
 *
 * The same word `agents:run` writes for an immediate manual wake, so a run that
 * had to wait reads to the agent exactly like one that did not — only later.
 */
const MANUAL_TRIGGER = 'manual';

/**
 * The `kind` a manual run is queued under, and the only kind carrying `text`.
 *
 * Not a ledger kind — no entry with this kind is ever appended to the log. It
 * exists so a flushed queue can tell a person's request apart from an entry's,
 * which is what {@link PendingWakeEntry.text} and the trigger both turn on.
 */
const MANUAL_KIND = 'manual';

/**
 * The two words a *scheduled* wake reports, and why there are two.
 *
 * They reach the model's prompt like {@link LEDGER_TRIGGER} does, and the
 * distinction is one the agent can act on: `interval` says "some time has
 * passed since you last ran", `schedule` says "it is the hour you asked for".
 * A single word would make a 09:00 standup indistinguishable from a five-
 * minute poll in its own transcript.
 */
const INTERVAL_TRIGGER = 'interval';
const CALENDAR_TRIGGER = 'schedule';

/** Minutes past local midnight, for the quiet-hours comparison. */
const minuteOfDay = (at: number): number => {
  const date = new Date(at);

  return date.getHours() * 60 + date.getMinutes();
};

/** The next local midnight — when a capped agent's day starts over. */
const nextMidnightAfter = (at: number): number => {
  const midnight = new Date(at);

  midnight.setHours(0, 0, 0, 0);
  midnight.setDate(midnight.getDate() + 1);

  return midnight.getTime();
};

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
   * `RunTracker.run`, in full.
   *
   * A refusal is not an error here: `working` and `paused` are *answers*, and
   * queueing is what this module does about them. It is deliberately the
   * tracker rather than the waker — that method is the one door every trigger
   * passes through, and it is where a paused agent is refused. A second
   * entrance would let a ledger entry wake an agent the user had just stopped.
   *
   * It was narrowed to `{ started: boolean }` while queueing was the only thing
   * this module did about a refusal, and queueing does not care why. HIVE-126's
   * {@link Scheduler.manualWake} does: `working` and `paused` are waits worth
   * keeping, and a definition that cannot be read is not.
   */
  run: (name: string, trigger: string, extra?: string) => RunStart;
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
   * Every agent with a usable schedule — or `undefined` before the registry
   * has answered its first listing.
   *
   * **The map, not a per-agent lookup, because it is also the roster.**
   * `agents.json` gains an entry when an agent *runs*, is paused, or is queued
   * against; nothing writes one when a definition is merely saved. A tick
   * driven off run state alone would therefore never see a newly created
   * agent — the feature's primary path — so the tick walks the union of this
   * map and `state.all()`.
   *
   * **`undefined` is not an empty map.** The listing is a folder walk that
   * parses every `AGENT.md`, and it routinely loses the race with the boot
   * tick. Read as "nothing is scheduled", that would clear every agent's
   * overdue `nextRunAt` on the launch after a missed window — destroying
   * exactly what the catch-up exists to spend. So the tick does nothing at all
   * until the registry has answered once.
   *
   * A definition that will not parse is absent from the map once it *has*
   * answered, which is what keeps a broken file off the timer while it stays
   * listed for the user to fix.
   *
   * Read every tick rather than cached here: that is what makes "a definition
   * change re-arms the schedule" need no timer to re-arm.
   *
   * `mcp` rides along for the same reason `dailyUsd` does (HIVE-123): the
   * scheduler's Slack skip has to gate on the agent's **current** `mcp:`
   * list, not on whatever an old run's `RunSummary.slack` says, or an agent
   * that removed `slack` from its definition after a `needs-auth` run would
   * skip forever on a fact that stopped being true. Optional, and read as `[]`
   * when absent, so a schedule that predates this field (every existing test
   * fixture) still means "does not name Slack" rather than failing to type.
   */
  schedules: () =>
    | ReadonlyMap<string, { wake: WakeSpec; dailyUsd?: number; mcp?: string[] }>
    | undefined;
  /**
   * Tell the renderer this agent's row changed.
   *
   * `RunTracker` pushes when a run starts and when it ends, which covers every
   * change the ledger half of this module causes. The tick causes changes with
   * *no* run attached — a new `nextRunAt`, an incremented skip count, a day
   * that hit its ceiling — and those are exactly the ones a person is looking
   * at the row to see. Without this, `next 18:20 · skipped 3` would go stale
   * on precisely the agent being diagnosed: one that is not running.
   */
  pushStatus: (name: string) => void;
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
  /**
   * A person pressed run (HIVE-126).
   *
   * The manual path used to call `RunTracker.run` directly, so a refusal was
   * printed in the console and the intent was gone — while the identical intent
   * arriving through the ledger was queued and delivered later. Same agent,
   * same wish, different durability, and nothing on screen said which you got.
   *
   * Refuses rather than queues for anything but `working` and `paused`: those
   * two are waits that end, and the rest is a fault the user has to act on.
   *
   * `wake.on: [ledger]` is deliberately **not** consulted, unlike `onEntry`.
   * That gate asks whether an agent's author wanted the *log* to wake it, and a
   * person pressing run has answered a different question.
   *
   * `stopped` **is** honoured, like every other entry point — see the note on
   * the implementation for why the tracker cannot be relied on to refuse in its
   * place.
   */
  manualWake(name: string, extra?: string): AgentRunResult;
  /** Boot: wake anything a crash left queued, and arm the expiry sweep. */
  start(): void;
  /** Shutdown: disarm the sweep. */
  stop(): void;
}

/**
 * One entry, as the wake prompt names it.
 *
 * `ask a12 from overmind`, or `manual run from overmind — review PR 1234` for
 * the one kind that brought its own words. Shared by the immediate path and the
 * queue so a wake reads the same however it was reached.
 */
const describeEntry = (entry: PendingWakeEntry): string =>
  entry.text === undefined
    ? `${entry.kind} ${entry.id} from ${entry.from}`
    : `${entry.kind} ${entry.id} from ${entry.from} — ${entry.text}`;

/** `ask a12 from overmind` — how a wake says what it woke for. */
const describeEntries = (queued: readonly PendingWakeEntry[]): string =>
  queued.map(describeEntry).join(', ');

/**
 * Which trigger a flushed queue reports (HIVE-126).
 *
 * `manual` wins over `ledger` whenever a person's own run is in the queue: it
 * is the reason with someone behind it, and `ledger` would name a route that
 * entry never took — there is no log line for `ledger_read` to find.
 */
const triggerFor = (queued: readonly PendingWakeEntry[]): string =>
  queued.some((item) => item.kind === MANUAL_KIND)
    ? MANUAL_TRIGGER
    : LEDGER_TRIGGER;

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
   * Has anything reached this agent since it last ran?
   *
   * What `check: onchange` consults. An addressed entry newer than the last
   * run, or a queue standing from a wake it could not take.
   *
   * `entries` is passed in rather than read here: the tick asks this of every
   * agent about one instant, and reading the unfiltered log per agent would
   * scan it N times a minute for an N-agent fleet, forever.
   *
   * Deliberately **not** gated on `wake.on: [ledger]`. That gate decides
   * whether an entry *wakes* the agent; it does not decide whether the entry
   * is a change worth waking for on a schedule the author did set — the
   * field's own help promises a question "waits unread until the next
   * scheduled wake", and this is that wake arriving to read it.
   *
   * An agent that has never run treats every entry as new, which is right: it
   * has read none of them.
   */
  const hasChanged = (
    name: string,
    agent: AgentRunState,
    entries: readonly LedgerEntry[],
  ): boolean => {
    if ((agent.pendingWake ?? []).length > 0) return true;

    const since = agent.lastRunAt ?? 0;

    return entries.some((item) => item.to === name && item.ts > since);
  };

  /**
   * Did the last run find Slack signed out, and does the agent still name it?
   * (HIVE-123)
   *
   * Two conditions, not one. `RunSummary.slack`, carried onto the last run at
   * close from its `init` event (`runs.ts`), says what the *last run* found —
   * but nothing clears `AgentRunState.runs` when a definition is edited
   * (`state.ts`'s `saveAgent`/`renameAgent`/`deleteAgent` all leave run
   * history untouched), so a `needs-auth` run followed by removing `slack`
   * from `mcp:` would otherwise skip forever on a fact that stopped being
   * true. `mcp` is the agent's **current** definition, read off the same
   * `schedules()` map the tick already resolves `wake` from — not a second,
   * parallel lookup — so the gate is "signed out *and still relevant*", not
   * an inference from history alone.
   *
   * `undefined`/absent `slack` covers both an agent whose `mcp:` never named
   * `slack` and one that has **never run at all**, and both read as "not
   * signed out": a signed-out-at-boot Slack must not wedge an agent
   * permanently, so the first wake is always let through to discover its own
   * status. Only the *clock-driven* tick is gated — a ledger wake or a manual
   * "Run now" still reaches `RunTracker.run` directly, so the agent stays
   * reachable while its autonomous polling is quiet.
   */
  const slackSignedOut = (agent: AgentRunState, mcp: readonly string[]): boolean =>
    mcp.includes(SLACK_SERVER_KEY) && agent.runs.at(-1)?.slack === 'needs-auth';

  /**
   * Time passed (HIVE-121).
   *
   * The other half of this module. `onEntry` answers *something happened*;
   * this answers *the clock moved* — and it does so by polling `nextRunAt` out
   * of `agents.json` rather than by arming a timer per agent.
   *
   * That is the load-bearing choice, and it is not about simplicity.
   * `nextRunAt` is already persisted as a wall-clock timestamp; a per-agent
   * `setTimeout` would keep that same truth a second time, in memory, where a
   * quit or a lid-shut sleep makes the two disagree — and the persisted one is
   * the one that survives. Polling leaves exactly one representation of when a
   * wake is due, so four things stop being code: boot catch-up (one overdue
   * timestamp is one wake, however long the app was closed), re-arming on a
   * definition change (the definition is re-read every tick), pause, and
   * resume.
   *
   * The cost is that a wake can be up to {@link LEDGER_SWEEP_MS} late. The
   * grammar's floor is one minute, so no precision a definition is able to
   * *express* is lost.
   */
  const tickSchedules = (): void => {
    if (stopped) return;

    const listed = deps.schedules();

    /*
      The registry has not answered yet — do nothing at all.

      Not "nothing is scheduled". That listing parses every `AGENT.md` on disk
      and routinely loses its race with the boot tick, and the clearing branch
      below would spend that race destroying every agent's overdue
      `nextRunAt` — the one thing the boot tick exists to spend.
    */
    if (listed === undefined) return;

    const now = deps.now();
    // One read for the whole tick, not one per agent: `hasChanged` scans the
    // unfiltered log, and every agent here is asked about the same instant.
    const entries = deps.ledger.read().entries;
    /*
      Every write the tick makes is one a row is showing, so it is pushed —
      but only when something actually moves. A quiet-hours deferral recomputes
      the same window end every minute all night, and pushing that would be one
      status update per agent per minute saying nothing changed.
    */
    const arm = (
      name: string,
      from: number | undefined,
      to: number | undefined,
      change: Partial<AgentRunState> = {},
    ): void => {
      if (from === to && Object.keys(change).length === 0) return;

      deps.state.patch(name, { nextRunAt: to, ...change });
      deps.pushStatus(name);
    };

    /*
      The union of what has run and what is merely defined.

      `agents.json` gains an entry when an agent runs, is paused, or is queued
      against — never when a definition is saved. Walking run state alone would
      mean an agent authored in Settings and left alone was never scheduled at
      all, which is this feature's main path.
    */
    for (const name of new Set([
      ...Object.keys(deps.state.all()),
      ...listed.keys(),
    ])) {
      const agent = deps.state.read(name);

      /*
        `working` is the one-run-at-a-time rule, and the tick is *skipped*
        rather than queued — the next one is a minute away. `paused` is the
        user's decision. `asking` ended its turn waiting on a reply, and the
        reply is its wake; `describeNextRun` already draws `on answer` for it,
        so a tile promising a time would promise a wake the answer pre-empts.

        An `asking` agent's `nextRunAt` is left stale on purpose: when the
        answer lands and the status moves, the next tick finds one overdue time
        and spends it as a single catch-up wake.
      */
      if (agent.status !== 'sleeping' && agent.status !== 'failed') continue;

      const schedule = listed.get(name);
      const next =
        schedule === undefined ? undefined : nextRunFrom(schedule.wake, now);

      // No schedule — and clear a time left behind by one there used to be.
      if (schedule === undefined || next === undefined) {
        arm(name, agent.nextRunAt, undefined);
        continue;
      }

      const { wake } = schedule;

      /*
        Inside quiet hours: defer to the window's end rather than to the next
        interval, so a five-minute agent does not spend the night re-deciding
        to stay asleep — and so `Next` reads as the promise it is.

        Not a skip. A silence the author asked for is not the same fact as
        "nothing changed", and counting it would have a nightly agent reading
        `skipped 96` every morning for working perfectly.

        Ahead of the due check, so the deferral holds whether or not the old
        time has elapsed — and so the re-arm further down can never clamp
        against it.

        Only interval mode can reach this: `parseAgent` refuses a `wake.at`
        time that falls inside the window, so a calendar agent's times are
        outside it by construction.
      */
      if (wake.quiet !== undefined && inQuiet(minuteOfDay(now), wake.quiet)) {
        arm(name, agent.nextRunAt, quietEndAfter(now, wake.quiet));
        continue;
      }

      /*
        The day's ceiling, enforced here rather than on the command line.

        `--max-budget-usd` caps one wake; the binary knows nothing about days.
        And the number it is compared against is the accumulator in
        `agents.json` rather than a sum over `runs[]`, because that array holds
        the last twenty runs and a five-minute agent takes 288 — a ceiling
        derived from it would stop biting exactly where it matters.

        Scheduled wakes only. A ledger entry and a manual run both still reach
        `RunTracker.run`, which is the point: this is a budget for unattended
        work, not a lock on the agent.
      */
      const today = agent.today?.day === dayKey(now) ? agent.today : undefined;

      if (schedule.dailyUsd !== undefined && (today?.usd ?? 0) >= schedule.dailyUsd) {
        // Once a day, not once a minute for the rest of it.
        if (today?.capped === true) {
          arm(name, agent.nextRunAt, nextMidnightAfter(now));
          continue;
        }

        arm(name, agent.nextRunAt, nextMidnightAfter(now), {
          today: {
            ...(today ?? { day: dayKey(now), runs: 0, usd: 0 }),
            capped: true,
          },
        });
        /*
          Posted as the **overmind**, not as the agent, and gated on that at
          the other end. `meta` is a free-form rider any party can write, so a
          card minted from an agent's own `from` is one any agent could mint
          for itself — which is exactly why the expiry event is the overmind's
          too. Main declined to start this run; main says so.
        */
        deps.ledger.append({
          from: OVERMIND,
          kind: 'event',
          body: `${name} reached its daily budget — $${schedule.dailyUsd.toFixed(2)}`,
          meta: { dailyCap: schedule.dailyUsd, agent: name },
        });
        continue;
      }

      /*
        Never scheduled: arm it, do not fire it. Saving a definition starts a
        schedule now; it does not owe a wake dated from the epoch.
      */
      if (agent.nextRunAt === undefined) {
        arm(name, undefined, next);
        continue;
      }

      /*
        A schedule that got *shorter* must not wait out the old, longer time.

        `every: 6h` armed at 10:00 and edited to `every: 5m` at 10:05 would
        otherwise sit until 16:00, and a calendar agent switched to an interval
        would sit for nearly a day — while the docs promise that a definition
        change re-arms the schedule. Downward only: a *lengthened* interval
        still owes the wake it already armed, and pushing that out would be the
        same bug facing the other way.

        This is safe against the two deliberate deferrals above only because
        both of them `continue` before reaching here — otherwise it would fight
        the quiet-hours branch once a minute all night.
      */
      const due = Math.min(agent.nextRunAt, next);

      if (due !== agent.nextRunAt) arm(name, agent.nextRunAt, due);
      if (now < due) continue;

      if (slackSignedOut(agent, schedule.mcp ?? [])) {
        arm(name, due, next, {
          skipsSinceRun: (agent.skipsSinceRun ?? 0) + 1,
        });
        continue;
      }

      if (wake.check === 'onchange' && !hasChanged(name, agent, entries)) {
        arm(name, due, next, {
          skipsSinceRun: (agent.skipsSinceRun ?? 0) + 1,
        });
        continue;
      }

      /*
        Armed before the run, and armed whatever the run answers.

        A refusal is a wake deferred rather than a wake lost — and it is what
        keeps this tick from racing HIVE-119's deferred permission wake: both
        go through `RunTracker.run`, so whichever arrives first leaves the
        agent `working` and the other is refused. A refused tick is not a quiet
        one either, so it leaves the skip count where it is.
      */
      arm(name, due, next);
      deps.run(name, wake.everyMs === undefined ? CALENDAR_TRIGGER : INTERVAL_TRIGGER);
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

    const started = deps.run(name, triggerFor(queued), describeEntries(queued));

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

  /** Whether the entry was taken. `false` means the queue was full. */
  const enqueue = (name: string, entry: PendingWakeEntry): boolean => {
    const queued = deps.state.read(name).pendingWake ?? [];

    /*
      A full queue refuses the newcomer rather than evicting the entry that has
      waited longest — the oldest is the one most at risk of being forgotten.
      For a ledger entry nothing is lost by that refusal: this list exists to
      cause *one* wake, and the agent reads its own inbox on it.

      For a manual entry it is a real loss — those words exist nowhere else —
      which is why this answers whether it took the entry rather than returning
      void. `route()` ignores the answer, correctly: the log still holds what it
      was carrying. {@link Scheduler.manualWake} must not, or the console would
      print "queued" about a run that was dropped on the floor.
    */
    if (queued.length >= AGENT_PENDING_WAKE_MAX) return false;

    deps.state.patch(name, {
      pendingWake: [
        ...queued,
        {
          kind: entry.kind,
          id: entry.id,
          from: entry.from,
          // Field by field, deliberately — it is what keeps an unrelated key
          // from a caller reaching `agents.json`.
          ...(entry.text === undefined ? {} : { text: entry.text }),
        },
      ],
    });

    return true;
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

    manualWake(name, extra) {
      /*
        Gated on `stopped` like every other entry point, and the reason is not
        the one this comment first gave. It claimed a tracker on its way down
        refuses on its own account — it does not: `RunTracker` holds only
        `running`, and `closeAll` empties it, so there is no shutdown flag for
        `run` to consult. The `agents:run` handler awaits `mcp.start()`, and a
        quit landing on that await would otherwise resume here after
        `closeAll` had finished iterating and spawn the orphan that
        `scheduler.stop()` before `runs.closeAll()` exists to prevent. The
        queue is no safer at that moment: `agentState.flush()` has already run,
        and a `patch` after it rides a debounced timer that quit will not.
      */
      if (stopped) {
        return {
          started: false,
          refused: 'unknown',
          reason: 'The Hive is shutting down.',
        };
      }

      const started = deps.run(name, MANUAL_TRIGGER, extra);

      if (started.started) return started;

      /*
        Only the two refusals that end on their own.

        A run in flight closes and a pause gets lifted, and `flush` is already
        wired to both moments. `invalid` is a definition the user has to go and
        fix — `route()` queues it because at boot it means `mcp.start()` has not
        finished, which the `agents:run` handler awaits before reaching here —
        so queueing it would be a promise nothing is going to keep.
      */
      if (started.refused !== 'working' && started.refused !== 'paused') {
        return started;
      }

      const took = enqueue(name, {
        kind: MANUAL_KIND,
        id: 'run',
        from: OVERMIND,
        ...(extra === undefined ? {} : { text: extra }),
      });

      /*
        A full queue is reported as the refusal it is.

        `enqueue` drops the newcomer when `pendingWake` is at
        `AGENT_PENDING_WAKE_MAX`, and for a ledger entry that is harmless — the
        log still holds it. Here it would mean printing "queued" in dim about a
        run that went nowhere, and a *paused* agent never flushes, so every
        later run would print the same lie. The original refusal is the honest
        answer: the agent is working or paused, and this is one to try again.
      */
      if (!took) return started;

      return { started: false, queued: true, behind: started.refused };
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

      /*
        One tick now, so a restart does not wait a full period to notice an
        agent whose time passed while the app was closed. After the flush
        above, because a queue standing from the last launch is older news than
        a schedule that has merely come round.
      */
      tickSchedules();

      /*
        One timer, two jobs (HIVE-121). The sweep retires asks a day old and
        the tick starts scheduled wakes; both want the same minute, and a
        second interval would be a second thing for `stop()` to get right.
      */
      sweeping = setIntervalFn(() => {
        sweep();
        tickSchedules();
      }, LEDGER_SWEEP_MS);
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
