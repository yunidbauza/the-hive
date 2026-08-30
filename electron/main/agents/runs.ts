import { AGENT_KILL_GRACE_MS, type RunLine, type RunOutcome } from '@shared/agent-contract';

import { NO_LOG, foldRunLog, type LogFold } from './run-log';
import type { AgentState } from './state';
import type { WakeCommand } from './waker';

/**
 * One headless turn per wake, tracked as a run (HIVE-115).
 *
 * ## Why exit closes a run, and Stop does not
 *
 * The story specified "whichever of Stop and exit comes second is a no-op",
 * which makes whichever arrives *first* decide the outcome. But the outcome
 * depends on the exit code, and Stop does not carry one — closing on Stop
 * means guessing at a number that is seconds away. Exit is authoritative, and
 * the `result` event has already delivered subtype, cost, turns and session id
 * before it.
 *
 * So Stop arms a watchdog instead: if the turn has ended and the process has
 * not gone within {@link AGENT_KILL_GRACE_MS}, the run is killed by the same
 * escalation `kill` uses and closes `failed (stalled)`. The Stop-then-exit /
 * exit-then-Stop race the story worried about stops existing, rather than
 * being handled.
 */

export type RunStart =
  | { started: true; run: string }
  | { started: false; refused: 'working' | 'unknown' | 'invalid'; reason?: string };

export interface RunTrackerDeps {
  spawn: (
    file: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => ChildLike;
  /** The command for this agent, or why it cannot be built. */
  command: (name: string) => WakeCommand | { problem: string };
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
  /** The Stop hook fired for this agent. Arms the stall watchdog. */
  noteTurnEnded(name: string): void;
  killAll(reason: string): void;
  live(): string[];
}

interface LiveRun {
  run: string;
  trigger: string;
  startedAt: number;
  child: ChildLike;
  fold: LogFold;
  closed: boolean;
  reason: string | null;
  escalation: NodeJS.Timeout | null;
  watchdog: NodeJS.Timeout | null;
}

export function createRunTracker(deps: RunTrackerDeps): RunTracker {
  const grace = deps.killGraceMs ?? AGENT_KILL_GRACE_MS;
  const running = new Map<string, LiveRun>();

  const clearTimers = (live: LiveRun) => {
    if (live.escalation !== null) clearTimeout(live.escalation);
    if (live.watchdog !== null) clearTimeout(live.watchdog);
    live.escalation = null;
    live.watchdog = null;
  };

  const escalate = (live: LiveRun, reason: string) => {
    if (live.closed) return;

    live.reason = live.reason ?? reason;
    live.child.kill('SIGTERM');

    if (live.escalation !== null) return;

    live.escalation = setTimeout(() => {
      if (!live.closed) live.child.kill('SIGKILL');
    }, grace);
  };

  const close = (name: string, live: LiveRun, code: number | null) => {
    if (live.closed) return;

    live.closed = true;
    clearTimers(live);
    running.delete(name);

    const result = live.fold.result;
    const asking = deps.openAsksFor(name, live.run);

    let outcome: RunOutcome;

    if (live.reason !== null || code !== 0 || result === null) {
      outcome = 'failed';
    } else if (asking) {
      outcome = 'asking';
    } else if (result.subtype === 'error_max_turns') {
      outcome = 'turns';
    } else if (result.subtype.includes('budget')) {
      outcome = 'budget';
    } else {
      outcome = 'done';
    }

    const endedAt = deps.now();

    deps.state.recordRun(name, {
      run: live.run,
      trigger: live.trigger,
      startedAt: live.startedAt,
      endedAt,
      outcome,
      ...(result?.costUsd === undefined ? {} : { costUsd: result.costUsd }),
      ...(result?.turns === undefined ? {} : { turns: result.turns }),
      ...(live.reason === null ? {} : { reason: live.reason }),
    });

    const current = deps.state.read(name);

    deps.state.patch(name, {
      status: outcome === 'asking' ? 'asking' : 'sleeping',
      lastRunAt: endedAt,
      runsSinceRotate: current.runsSinceRotate + 1,
      ...(result?.sessionUuid === undefined
        ? {}
        : { sessionUuid: result.sessionUuid }),
    });

    deps.appendLedger({
      from: name,
      kind: 'event',
      body: `run.ended — ${outcome}`,
      meta: {
        run: live.run,
        outcome,
        ...(live.reason === null ? {} : { reason: live.reason }),
      },
    });

    deps.pushStatus(name);
  };

  return {
    run(name, trigger, extra) {
      if (running.has(name)) return { started: false, refused: 'working' };

      const command = deps.command(name);

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

      const child = deps.spawn(command.file, command.args, {
        cwd: command.cwd,
        env: command.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const live: LiveRun = {
        run,
        trigger,
        startedAt,
        child,
        fold: NO_LOG,
        closed: false,
        reason: null,
        escalation: null,
        watchdog: null,
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
        live.reason = live.reason ?? error.message;
        close(name, live, null);
      }) as never);

      child.on('exit', ((code: number | null) => {
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

    noteTurnEnded(name) {
      const live = running.get(name);

      if (live === undefined || live.closed || live.watchdog !== null) return;

      live.watchdog = setTimeout(() => {
        const still = running.get(name);

        if (still !== undefined && !still.closed) {
          escalate(still, 'stalled');
        }
      }, grace);
    },

    killAll(reason) {
      for (const live of running.values()) escalate(live, reason);
    },

    live: () => [...running.keys()],
  };
}
