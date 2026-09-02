import {
  AGENT_KILL_GRACE_MS,
  AGENT_STALL_GRACE_MS,
  type RunLine,
  type RunOutcome,
} from '@shared/agent-contract';
import { OVERMIND } from '@shared/ledger-contract';
import { SLACK_SERVER_KEY } from '@shared/slack-contract';

import {
  NO_LOG,
  foldRunLog,
  type LogFold,
  type McpServerStatus,
  type RunResult,
} from './run-log';
import type { AgentState } from './state';
import type { WakeCommand } from './waker';

/**
 * What this run's `init` event said about Slack, in `RunSummary`'s two words
 * (HIVE-123).
 *
 * `undefined` covers three cases the scheduler treats alike: the agent's `mcp:`
 * never named `slack`, the run never reached an `init` event at all (a spawn
 * failure), and the server reported a status this app does not recognise.
 *
 * That third case is why both words are matched exactly rather than reading
 * "anything that is not `needs-auth`" as connected. A server answering
 * `failed` is not a working connection, and the earlier form claimed it was —
 * while `integrations/slack/status.ts`, reading the very same server through
 * `claude mcp get`, calls an unrecognised status an **error**. The two halves
 * of the same story disagreeing about the same server is the bug; this is the
 * side that was wrong, because it was the side claiming health it had not
 * observed.
 *
 * `undefined` rather than a third word: nothing here consumes `'connected'` —
 * the scheduler and the chip tooltip both only ask whether this says
 * `needs-auth` — so an unrecognised status has no skip to justify and no claim
 * to make. The wake runs, and the run log shows what actually happened, which
 * is strictly more information than a skip would have given.
 */
const slackStatus = (
  servers: McpServerStatus[] | null,
): 'connected' | 'needs-auth' | undefined => {
  const slack = servers?.find((server) => server.name === SLACK_SERVER_KEY);

  if (slack?.status === 'needs-auth') return 'needs-auth';
  if (slack?.status === 'connected') return 'connected';

  return undefined;
};

/**
 * One headless turn per wake, tracked as a run (HIVE-115).
 *
 * ## Why 'close' finalizes a run, and 'exit' only backstops it
 *
 * Node's `'exit'` can fire before stdio is drained — and the `result` JSON is
 * the LAST thing `claude` writes, exactly the bytes at risk of still being in
 * flight. Finalizing on `'exit'` risks reading `fold.result` before it has
 * been folded, recording a healthy run as `failed` with no cost, no turns and
 * no session uuid persisted, which silently breaks `--resume` continuity on
 * the agent's next wake.
 *
 * `'close'` fires once every stdio stream has ended, which is what actually
 * guarantees the fold saw everything. So `'close'` is the finalizer. `'exit'`
 * still arms a short flush-window timer as a backstop, in case a grandchild
 * inherits a pipe and holds it open — `'close'` would then never come. The
 * `closed` flag makes whichever fires first the one that counts and the
 * other a no-op.
 *
 * ## Why Stop does not close a run either
 *
 * The outcome depends on the exit code, and Stop does not carry one — closing
 * on Stop means guessing at a number that is seconds away. So Stop
 * ({@link RunTracker.noteTurnEnded}) arms a *different* watchdog: if the turn
 * has ended and the process has not gone within {@link AGENT_STALL_GRACE_MS},
 * the run is killed by the same escalation `kill` uses and closes
 * `failed (stalled)`. That budget is its own constant and not the kill grace:
 * one is how long a process told to die gets, the other is how long a healthy
 * run gets to emit its `result` and reap its MCP child. See the two doc
 * comments in `agent-contract.ts`.
 *
 * Because the Stop hook is keyed by agent name only, a Stop delivered late —
 * after this run exited and a new one started under the same name — could
 * otherwise arm the wrong run's watchdog and SIGTERM a healthy process. The
 * caller building the command always knows which session uuid it is invoking
 * (minted for `--session-id`, or the one it is resuming), so that uuid rides
 * along on {@link RunTrackerDeps.command}'s return value and is stored on the
 * live run; a Stop whose uuid does not match the live run's is ignored.
 */

/** How long 'exit' waits for 'close' before finalizing anyway. */
const FLUSH_WINDOW_MS = 500;

export type RunStart =
  | { started: true; run: string }
  | {
      started: false;
      refused: 'working' | 'invalid' | 'paused';
      reason?: string;
    };

export interface RunTrackerDeps {
  spawn: (
    file: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => ChildLike;
  /**
   * The command for this agent, and the session uuid it invokes (minted or
   * resumed) — or why the command cannot be built.
   *
   * `lastTurn` says this wake asked the agent for a handoff, which is the close's
   * cue to consider rotating (HIVE-122). It has to travel from the builder
   * because it cannot be re-derived here: the counter it was decided from is
   * left untouched at wake time, on purpose.
   *
   * It is handed the **trigger** as well as the name, because the trigger is
   * part of the command line rather than only a label for the log: `wakePrompt`
   * writes "You woke because: <trigger>[ — <extra>]" into the prompt the
   * process is started with. A builder given only a name could not spell the
   * argv at all, and the composition would have to smuggle the trigger across
   * by some other route — which is a mutable slot outside the type system, safe
   * only for as long as `run` stays synchronous. Passing it as an argument
   * makes that guarantee structural.
   */
  command: (
    name: string,
    trigger: string,
    extra?: string,
  ) =>
    | (WakeCommand & { sessionUuid: string; lastTurn: boolean })
    | { problem: string };
  state: AgentState;
  appendLedger: (entry: {
    from: string;
    kind: 'event';
    body: string;
    meta: Record<string, unknown>;
  }) => void;
  /** Did this run leave an ask nobody has answered? */
  openAsksFor: (name: string, run: string) => boolean;
  /**
   * The handoff this run posted, if it posted one (HIVE-122).
   *
   * Answered the way `openAsksFor` answers its question — by finding this run's
   * own `run.started` event and taking the entries at or after it — because the
   * ledger has no other notion of which run an entry belongs to. The last
   * handoff wins if the agent wrote several.
   */
  handoffFor: (name: string, run: string) => string | undefined;
  /** Mints the uuid a rotation's next session will start under. */
  newUuid: () => string;
  pushStatus: (name: string) => void;
  pushLines: (name: string, lines: RunLine[]) => void;
  /**
   * This agent's run is over and its status is on disk (HIVE-120).
   *
   * Called **last**, after the patch and the push, because the one thing its
   * caller needs is the status *after* finalization: the scheduler decides
   * whether to flush its queue by reading it, and a run that closed into
   * `paused` must leave the queue standing. The status the scheduler
   * remembered when it filed the entry says `working`, which by then is a lie.
   *
   * Fires on every ending, the spawn-failure path included — a queue filed
   * against an agent whose process never started would otherwise wait for a
   * close that is never coming.
   */
  onRunClosed?: (name: string) => void;
  now: () => number;
  newRunId: () => string;
  killGraceMs?: number;
  stallGraceMs?: number;
}

export interface ChildLike {
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): unknown };
  stderr: { on(event: 'data', cb: (chunk: Buffer) => void): unknown };
  on(event: string, cb: (...args: never[]) => void): unknown;
  kill(signal?: string): boolean;
}

export interface RunTracker {
  run(name: string, trigger: string, extra?: string): RunStart;
  kill(name: string): boolean;
  /**
   * The Stop hook fired for this agent. Arms the stall watchdog, unless
   * `sessionUuid` is given and does not match the live run's — a stale Stop
   * for a run that has already ended must not touch whatever runs next.
   */
  noteTurnEnded(name: string, sessionUuid?: string): void;
  /**
   * Signal every live run and leave it to close on its own `'close'` event.
   *
   * For a caller that stays alive to see the `'close'` land and wants the run
   * recorded from it — the live suite's teardown, which awaits the exit.
   * **Not** for quit, and not for `resetIpcHandlers`: in both of those the
   * `'close'` arrives after the state has been torn down, so the finalizer it
   * triggers arms a debounce timer against a disposed writer. Those two want
   * {@link RunTracker.closeAll}.
   */
  killAll(reason: string): void;
  /**
   * Signal every live run and finalize it **now**, without waiting for an
   * event that cannot arrive.
   *
   * `runShutdown` awaits a synchronous hook, so a SIGTERM sent from there is
   * never followed by a `'close'` this process is alive to observe. Signalling
   * alone therefore leaves a `run.started` with no `run.ended` forever, no
   * summary in `runs[]`, and a `runsSinceRotate` that under-counts until
   * session rotation drifts. This records the run against the reason it is
   * ending, so `agentState.flush()` on the next line has something true to
   * write.
   *
   * The SIGKILL escalation is armed and then cleared, which costs nothing: it
   * is an `unref`'d timer, and the event loop it would need to fire on is
   * already going away.
   */
  closeAll(reason: string): void;
  live(): string[];
}

interface LiveRun {
  run: string;
  trigger: string;
  startedAt: number;
  sessionUuid: string;
  child: ChildLike;
  fold: LogFold;
  closed: boolean;
  reason: string | null;
  /** False only for a run that never reached the model: a spawn failure. */
  reachedModel: boolean;
  lastTurn: boolean;
  escalation: NodeJS.Timeout | null;
  watchdog: NodeJS.Timeout | null;
  flush: NodeJS.Timeout | null;
  /**
   * Whether the last line this run put in the log closed a turn.
   *
   * The run log is one buffer that spans runs — nothing clears it between them
   * — so the renderer can only tell one run's output from the next by the folds
   * in it. Every run must therefore leave the buffer terminated, and this is
   * how {@link finalizeRun} knows whether it already is.
   *
   * Starts `true`: a run that pushes nothing has nothing of its own to close,
   * and terminating there would seal the *previous* run's tail into a run that
   * never spawned.
   */
  endedTurn: boolean;
}

interface FinalizeInfo {
  run: string;
  trigger: string;
  startedAt: number;
  /**
   * This wake asked the agent for a handoff, so its close may rotate (HIVE-122).
   *
   * Read off the **command** at spawn and carried, rather than re-derived from
   * state at close: by then the state has moved on — a `pendingSession` written
   * here, or a `forceRotate` consumed by the wake, would both answer the
   * question differently from the way the prompt actually asked it.
   */
  lastTurn: boolean;
  /**
   * The conversation this run invoked — absent only when there was no process.
   *
   * Carried so that a run which ends without a `result` still persists it; see
   * the comment on the `sessionUuid` line in {@link finalizeRun}.
   */
  sessionUuid?: string;
}

export function createRunTracker(deps: RunTrackerDeps): RunTracker {
  const grace = deps.killGraceMs ?? AGENT_KILL_GRACE_MS;
  const stallGrace = deps.stallGraceMs ?? AGENT_STALL_GRACE_MS;
  const running = new Map<string, LiveRun>();

  const clearTimers = (live: LiveRun) => {
    if (live.escalation !== null) clearTimeout(live.escalation);
    if (live.watchdog !== null) clearTimeout(live.watchdog);
    if (live.flush !== null) clearTimeout(live.flush);
    live.escalation = null;
    live.watchdog = null;
    live.flush = null;
  };

  const escalate = (live: LiveRun, reason: string) => {
    if (live.closed) return;

    live.reason = live.reason ?? reason;
    live.child.kill('SIGTERM');

    if (live.escalation !== null) return;

    const timer = setTimeout(() => {
      if (!live.closed) live.child.kill('SIGKILL');
    }, grace);

    timer.unref?.();
    live.escalation = timer;
  };

  /**
   * Every line this module puts in the run log goes through here.
   *
   * The recording is the point: `pushLines` is called from four places — the
   * stdout fold, the exit flush, stderr, and {@link finalizeRun} itself — and a
   * site that forgot to update {@link LiveRun.endedTurn} would leave the
   * terminator decision reading a stale answer.
   */
  const pushLines = (name: string, live: LiveRun | null, lines: RunLine[]): void => {
    if (lines.length === 0) return;

    deps.pushLines(name, lines);

    if (live !== null) {
      live.endedTurn = lines[lines.length - 1]?.endsTurn === true;
    }
  };

  const finalizeRun = (
    name: string,
    info: FinalizeInfo,
    outcome: RunOutcome,
    result: RunResult | null,
    reason: string | null,
    reachedModel: boolean,
    asking: boolean,
    mcpServers: McpServerStatus[] | null,
    /**
     * Whether this run's last log line already closed its turn.
     *
     * `true` for a run that pushed nothing at all — a spawn that threw has no
     * output of its own, and terminating there would seal the *previous* run's
     * tail into a run that never existed.
     */
    endedTurn: boolean,
  ) => {
    const endedAt = deps.now();
    /*
      The uuid the run actually invoked, not only the one the `result` echoed
      back.

      It is known at spawn — `wake-command.ts` decides it, either by minting one
      for `--session-id` or by choosing the one to `--resume` — and taking it
      from `result` alone meant a first wake interrupted by a quit, a kill, a
      stall or a crash persisted **nothing**. The next wake then minted a fresh
      uuid and the whole conversation was orphaned, which is exactly what the
      shutdown hook's "their `sessionUuid` is untouched, so the next wake resumes
      the conversation" claims cannot happen.

      `reachedModel` still gates it: a spawn that threw, or a child that raised
      `'error'`, never started a conversation for `--resume` to find, and
      persisting a uuid no session file backs would fail the *next* wake instead
      of this one.
    */
    const sessionUuid =
      result?.sessionUuid ?? (reachedModel ? info.sessionUuid : undefined);
    const slack = slackStatus(mcpServers);

    /*
      **Every run leaves the log terminated.** The renderer splits one
      cross-run buffer into turns on the `endsTurn` fold, so a run that ends
      without writing one has its output joined to the next run's.

      Two paths end without one, and the condition is `endedTurn` rather than
      `result === null` because only the first of them is about the result:

      - No `result` at all — a kill, the stall watchdog, `killAll` at quit, a
        child that raised `'error'`. All reach here through `escalate`, which
        sends a signal and nothing else.
      - A `result` **followed by more output**. stderr is flushed on the way
        out, so a node or CLI warning lands after the fold; the fold is then no
        longer the tail, and those bytes belong to this run rather than opening
        the next one.

      The second case is why this cannot be a renderer heuristic. A first
      attempt classified a trailing unterminated line by whether the agent was
      *currently* running — but the status flips to `working` before the next
      run writes anything, so the debris was re-classified as the new run's
      opening line and sealed there. The flag moved independently of the buffer
      it was describing. A boundary has to be written into the data by the
      writer, at the moment it is true.

      `dim` rather than `cyan`: the app noting an ending, not the agent
      reporting one, and the two should not look alike.
    */
    if (!endedTurn) {
      deps.pushLines(name, [
        {
          text: `● run ended — ${reason ?? outcome}`,
          color: 'dim',
          endsTurn: true,
        },
      ]);
    }

    deps.state.recordRun(name, {
      run: info.run,
      trigger: info.trigger,
      startedAt: info.startedAt,
      endedAt,
      outcome,
      ...(result?.costUsd === undefined ? {} : { costUsd: result.costUsd }),
      ...(result?.turns === undefined ? {} : { turns: result.turns }),
      ...(reason === null ? {} : { reason }),
      // Recorded on every run, not only the ones that rotate: "which
      // conversation did run 14 belong to" is the audit trail HIVE-122 needs.
      ...(sessionUuid === undefined ? {} : { sessionUuid }),
      ...(slack === undefined ? {} : { slack }),
    },
    /*
      The run counts against the day it *ended*, not the one it started.

      A wake that begins at 23:59 and finishes at 00:01 has spent tomorrow's
      money, and tomorrow's ceiling is the one that should feel it — the
      alternative lets a long run started before midnight spend against a day
      whose accounting is already closed.
    */
    endedAt);

    const current = deps.state.read(name);

    /*
      The rotation gate (HIVE-122). Only a handoff wake can rotate, and only if
      the agent actually left a handoff: a run that was cut off by its turn cap,
      or that simply ignored the instruction, must keep the conversation rather
      than throw it away silently.
    */
    const handoff = info.lastTurn && reachedModel ? deps.handoffFor(name, info.run) : undefined;
    /*
      A strike is the *agent's* failure to hand over, and only that.

      `reason !== null` is the tracker's own marker for "we ended this run" —
      it is set by `escalate`, which is every path main takes to stop a child:
      `kill`, the stall watchdog, `killAll`, and the `closeAll('app-closed')`
      on quit. A handoff wake cut short by any of those never got the chance
      to post one, and three app quits landing mid-handoff-wake would otherwise
      raise a card accusing the agent of something main did. Same rule as
      `reachedModel`: main's failures are not the agent's.
    */
    const strike =
      info.lastTurn && handoff === undefined && reachedModel && reason === null;
    /*
      Sized inside the strike, not beside it: `rotateFailures + 1` is only ever
      a meaningful number when this close is a strike, and computing it
      unconditionally left a live trap — an agent sitting at `rotateFailures: 2`
      reaches 3 on its very next close even when that close is a *successful*
      rotation. `null` is what makes both readers below safe by construction
      rather than by remembering to re-check `strike`.
    */
    const failures = strike ? (current.rotateFailures ?? 0) + 1 : null;

    deps.state.patch(name, {
      /*
        An unanswered ask outranks the outcome for the *status*.

        A run killed or stalled with a question still open is recorded `failed`
        — that is the honest outcome, and the reason rides with it — but the
        agent is still waiting on the user, and a row reading `sleeping` hides
        the question rather than the failure. Status is about what the user must
        do next; the outcome is about what happened.

        An explicit pause outranks both (HIVE-117).

        A pause is allowed to land while a turn is in flight — the design lets
        that turn finish rather than killing it — so this finalizer runs seconds
        after the user paused the agent, and without this guard it would write
        the pause straight back out. The ask is not lost by holding `paused`:
        `agents:resume` recomputes from the ledger and finds it.
      */
      status:
        current.status === 'paused'
          ? 'paused'
          : outcome === 'asking' || asking
            ? 'asking'
            : 'sleeping',
      lastRunAt: endedAt,
      /*
        A rotation zeroes the counter instead of advancing it — the run that
        just closed belongs to the session being left behind. A run that never
        reached the model cost nothing and should not pull rotation forward.

        Keyed off `handoff !== undefined` rather than a `rotated` boolean:
        TypeScript narrows the former and not the latter, and
        `pendingSession.handoff` is a `string`.
      */
      ...(handoff !== undefined
        ? {
            runsSinceRotate: 0,
            rotateFailures: 0,
            pendingSession: { uuid: deps.newUuid(), handoff },
          }
        : reachedModel
          ? { runsSinceRotate: current.runsSinceRotate + 1 }
          : {}),
      ...(failures === null ? {} : { rotateFailures: failures }),
      ...(sessionUuid === undefined ? {} : { sessionUuid }),
    });

    deps.appendLedger({
      from: name,
      kind: 'event',
      body: `run.ended — ${outcome}`,
      meta: { run: info.run, outcome, ...(reason === null ? {} : { reason }) },
    });

    /*
      Posted as the **overmind**, not as the agent, and gated on that at the
      other end — the same rule the daily-cap card follows. `meta` is a rider any
      party can write, so a card minted from an agent's own `from` is one any
      agent could mint for itself. Main declined to rotate; main says so.

      Fired at exactly three so it cannot repeat: the counter keeps climbing and
      rotation keeps being attempted on every later wake. The ask here is that a
      human look, not that the agent give up.
    */
    if (failures === 3) {
      deps.appendLedger({
        from: OVERMIND,
        kind: 'event',
        body: `${name} could not rotate — three handoff wakes ended without a handoff.`,
        meta: { rotateFailed: 3, agent: name },
      });
    }

    deps.pushStatus(name);
    deps.onRunClosed?.(name);
  };

  const close = (name: string, live: LiveRun, code: number | null) => {
    if (live.closed) return;

    live.closed = true;
    clearTimers(live);
    running.delete(name);

    /*
      Fold whatever is left in `partial` before reading the result.

      The fold only reads a line once a `\n` terminates it, and no `\n` is ever
      coming now. The bytes at risk are precisely the ones that matter: `result`
      is the LAST thing `claude` writes, so a SIGKILL mid-write — or the flush
      window firing with a tail still buffered — leaves it sitting here
      unterminated. Dropping it records a healthy run `failed`, with no cost, no
      turns and no uuid, which is the exact failure `'close'`-over-`'exit'` was
      chosen to prevent.

      The lines it yields are pushed like any others; `live.closed` is already
      set, so the stdout handler cannot race this.
    */
    if (live.fold.partial !== '') {
      const step = foldRunLog(live.fold, '\n');

      live.fold = step.state;
      pushLines(name, live, step.lines);
    }

    const result = live.fold.result;
    const asking = deps.openAsksFor(name, live.run);

    // A recognised terminal subtype beats the exit code: --max-turns and
    // --max-budget-usd both exit non-zero (measured against 2.1.251), so a
    // capped run would otherwise be recorded failed.
    let outcome: RunOutcome;

    if (live.reason !== null) {
      outcome = 'failed'; // killed / stalled / spawn error
    } else if (result === null) {
      outcome = 'failed'; // died before saying anything
    } else if (asking) {
      outcome = 'asking';
    } else if (result.subtype === 'error_max_turns') {
      outcome = 'turns';
    } else if (result.subtype.includes('budget')) {
      outcome = 'budget';
    } else if (code !== 0) {
      outcome = 'failed';
    } else {
      outcome = 'done';
    }

    finalizeRun(
      name,
      live,
      outcome,
      result,
      live.reason,
      live.reachedModel,
      asking,
      live.fold.mcpServers,
      live.endedTurn,
    );
  };

  return {
    run(name, trigger, extra) {
      if (running.has(name)) return { started: false, refused: 'working' };

      /*
        A paused agent does not wake, for any trigger (HIVE-117).

        Refused here rather than at the `agents:run` channel, because the channel
        is only *today's* caller: HIVE-120's ledger-addressed wakes and HIVE-121's
        timer both arrive through this same method, and a guard on the channel
        would leave a paused agent woken by a clock. The tracker is the one place
        every trigger passes through.

        Before `deps.command`, too. Building the argv reads the definition off
        disk and mints a session uuid, and a refusal that did that work first
        would let a paused agent's session rotate by being asked.
      */
      if (deps.state.read(name).status === 'paused') {
        return { started: false, refused: 'paused' };
      }

      const command = deps.command(name, trigger, extra);

      if ('problem' in command) {
        return { started: false, refused: 'invalid', reason: command.problem };
      }

      const run = deps.newRunId();
      const startedAt = deps.now();

      deps.appendLedger({
        from: name,
        kind: 'event',
        body: `run.started — ${trigger}`,
        meta: { run, trigger, ...(extra === undefined ? {} : { extra }) },
      });

      let child: ChildLike;

      try {
        child = deps.spawn(command.file, command.args, {
          cwd: command.cwd,
          env: command.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        /*
          A synchronous throw never produced a process. Two things follow, and
          they point in opposite directions:

          The run is finalized, because the `run.started` entry above is
          already written and a log that records a beginning with no end is
          worse than no record at all.

          But the caller is told the run did **not** start. `agents:run`
          answers a renderer that is about to draw a row as working and offer a
          stop button for a child that does not exist — and `{ started: false,
          refused: 'invalid' }` is already the contract's word for "the command
          could not be run", which is exactly what happened.
        */
        const message = error instanceof Error ? error.message : String(error);

        finalizeRun(
          name,
          { run, trigger, startedAt, lastTurn: command.lastTurn },
          'failed',
          null,
          message,
          false,
          false,
          null,
          /*
            Nothing was pushed for this run — the spawn threw before a child
            existed — so there is no turn of its own to close. Terminating here
            would seal the *previous* run's tail into a run that never ran.
          */
          true,
        );

        return { started: false, refused: 'invalid', reason: message };
      }

      const live: LiveRun = {
        run,
        trigger,
        startedAt,
        sessionUuid: command.sessionUuid,
        child,
        fold: NO_LOG,
        closed: false,
        reason: null,
        reachedModel: true,
        lastTurn: command.lastTurn,
        escalation: null,
        watchdog: null,
        flush: null,
        // Nothing written yet, so nothing of this run's to close. See the field.
        endedTurn: true,
      };

      running.set(name, live);
      /*
        The skip count is cleared here — at the one door every trigger passes
        through — rather than in the scheduler's tick (HIVE-121). A manual run
        or a ledger wake is just as good a proof that the agent is alive as a
        scheduled one, and `skipped 3` beside a `Next` tile whose agent has
        since run twice is a number contradicting the tile it sits in.

        Below the `paused` and unbuildable-command refusals above, so a wake
        that never happened does not clear a count that is still true.
      */
      deps.state.patch(name, { status: 'working', skipsSinceRun: 0 });
      deps.pushStatus(name);

      /*
        Both handlers are inert once the run has closed, and that guard is not
        belt-and-braces.

        `close()` deletes the run from `running` but cannot remove these
        listeners — the child object outlives them, and a grandchild holding the
        pipe (the case `FLUSH_WINDOW_MS` exists for) goes on writing. Without
        the guard that output folds into a run that is already finalized, and
        then reaches the renderer interleaved with the NEXT run's lines, because
        `appendAgentLines` keys on the agent name alone and cannot tell them
        apart.
      */
      child.stdout.on('data', (chunk: Buffer) => {
        if (live.closed) return;

        const step = foldRunLog(live.fold, chunk.toString('utf8'));

        live.fold = step.state;
        pushLines(name, live, step.lines);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        if (live.closed) return;

        const text = chunk.toString('utf8').trim();

        if (text !== '') pushLines(name, live, [{ text, color: 'dim' }]);
      });

      child.on('error', ((error: Error) => {
        // The process itself never launched — never reached the model.
        live.reachedModel = false;
        live.reason = live.reason ?? error.message;
        close(name, live, null);
      }) as never);

      child.on('exit', ((code: number | null) => {
        if (live.closed || live.flush !== null) return;

        const timer = setTimeout(() => close(name, live, code), FLUSH_WINDOW_MS);

        timer.unref?.();
        live.flush = timer;
      }) as never);

      child.on('close', ((code: number | null) => {
        close(name, live, code);
      }) as never);

      return { started: true, run };
    },

    kill(name) {
      const live = running.get(name);

      if (live === undefined) return false;

      escalate(live, 'killed');

      return true;
    },

    noteTurnEnded(name, sessionUuid) {
      const live = running.get(name);

      if (live === undefined || live.closed || live.watchdog !== null) return;
      if (sessionUuid !== undefined && sessionUuid !== live.sessionUuid) return;

      const timer = setTimeout(() => {
        if (!live.closed) escalate(live, 'stalled');
      }, stallGrace);

      timer.unref?.();
      live.watchdog = timer;
    },

    killAll(reason) {
      for (const live of running.values()) escalate(live, reason);
    },

    closeAll(reason) {
      // A copy, because `close` deletes from the map it is iterating.
      for (const [name, live] of [...running]) {
        escalate(live, reason);
        close(name, live, null);
      }
    },

    live: () => [...running.keys()],
  };
}
