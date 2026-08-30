import { AGENT_KILL_GRACE_MS, type RunLine, type RunOutcome } from '@shared/agent-contract';

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
 * has ended and the process has not gone within {@link AGENT_KILL_GRACE_MS},
 * the run is killed by the same escalation `kill` uses and closes
 * `failed (stalled)`.
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
  | { started: false; refused: 'working' | 'invalid'; reason?: string };

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
  killAll(reason: string): void;
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
}

export function createRunTracker(deps: RunTrackerDeps): RunTracker {
  const grace = deps.killGraceMs ?? AGENT_KILL_GRACE_MS;
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
  ) => {
    const endedAt = deps.now();

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
      status: outcome === 'asking' ? 'asking' : 'sleeping',
      lastRunAt: endedAt,
      // A run that never reached the model cost nothing and should not pull
      // session rotation forward.
      ...(reachedModel ? { runsSinceRotate: current.runsSinceRotate + 1 } : {}),
      ...(result?.sessionUuid === undefined
        ? {}
        : { sessionUuid: result.sessionUuid }),
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

    finalizeRun(name, live, outcome, result, live.reason, live.reachedModel);
  };

  return {
    run(name, trigger, extra) {
      if (running.has(name)) return { started: false, refused: 'working' };

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
        // A synchronous throw never produced a process — the run never
        // reached the model, and it must not be left as a run.started
        // ledger entry with no run.ended.
        const message = error instanceof Error ? error.message : String(error);

        finalizeRun(name, { run, trigger, startedAt }, 'failed', null, message, false);

        return { started: true, run };
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

      child.stdout.on('data', (chunk: Buffer) => {
        const step = foldRunLog(live.fold, chunk.toString('utf8'));

        live.fold = step.state;
        if (step.lines.length > 0) deps.pushLines(name, step.lines);
      });

      child.stderr.on('data', (chunk: Buffer) => {
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
      }, grace);

      timer.unref?.();
      live.watchdog = timer;
    },

    killAll(reason) {
      for (const live of running.values()) escalate(live, reason);
    },

    live: () => [...running.keys()],
  };
}
