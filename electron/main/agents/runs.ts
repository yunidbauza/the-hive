import {
  AGENT_KILL_GRACE_MS,
  AGENT_STALL_GRACE_MS,
  type RunLine,
  type RunOutcome,
} from '@shared/agent-contract';

import { NO_LOG, foldRunLog, type LogFold, type RunResult } from './run-log';
import type { AgentState } from './state';
import type { WakeCommand } from './waker';

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
  ) => (WakeCommand & { sessionUuid: string }) | { problem: string };
  state: AgentState;
  appendLedger: (entry: {
    from: string;
    kind: 'event';
    body: string;
    meta: Record<string, unknown>;
  }) => void;
  /** Did this run leave an ask nobody has answered? */
  openAsksFor: (name: string, run: string) => boolean;
  pushStatus: (name: string) => void;
  pushLines: (name: string, lines: RunLine[]) => void;
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
  escalation: NodeJS.Timeout | null;
  watchdog: NodeJS.Timeout | null;
  flush: NodeJS.Timeout | null;
}

interface FinalizeInfo {
  run: string;
  trigger: string;
  startedAt: number;
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

  const finalizeRun = (
    name: string,
    info: FinalizeInfo,
    outcome: RunOutcome,
    result: RunResult | null,
    reason: string | null,
    reachedModel: boolean,
    asking: boolean,
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

    deps.state.recordRun(name, {
      run: info.run,
      trigger: info.trigger,
      startedAt: info.startedAt,
      endedAt,
      outcome,
      ...(result?.costUsd === undefined ? {} : { costUsd: result.costUsd }),
      ...(result?.turns === undefined ? {} : { turns: result.turns }),
      ...(reason === null ? {} : { reason }),
    });

    const current = deps.state.read(name);

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
      // A run that never reached the model cost nothing and should not pull
      // session rotation forward.
      ...(reachedModel ? { runsSinceRotate: current.runsSinceRotate + 1 } : {}),
      ...(sessionUuid === undefined ? {} : { sessionUuid }),
    });

    deps.appendLedger({
      from: name,
      kind: 'event',
      body: `run.ended — ${outcome}`,
      meta: { run: info.run, outcome, ...(reason === null ? {} : { reason }) },
    });

    deps.pushStatus(name);
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
      if (step.lines.length > 0) deps.pushLines(name, step.lines);
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
          { run, trigger, startedAt },
          'failed',
          null,
          message,
          false,
          false,
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
        escalation: null,
        watchdog: null,
        flush: null,
      };

      running.set(name, live);
      deps.state.patch(name, { status: 'working' });
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
        if (step.lines.length > 0) deps.pushLines(name, step.lines);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        if (live.closed) return;

        const text = chunk.toString('utf8').trim();

        if (text !== '') deps.pushLines(name, [{ text, color: 'dim' }]);
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
