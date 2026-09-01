import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  childInstances,
  resetChildProcessMock,
  spawn,
  spawnCalls,
} from '../../../../__mocks__/child-process';
import { createAgentState } from '../../../../electron/main/agents/state';
import { createRunTracker } from '../../../../electron/main/agents/runs';
import {
  AGENT_KILL_GRACE_MS,
  AGENT_STALL_GRACE_MS,
} from '../../../../electron/shared/agent-contract';
import { OVERMIND } from '../../../../electron/shared/ledger-contract';

const resultLine = (over: Record<string, unknown> = {}) =>
  `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    num_turns: 2,
    total_cost_usd: 0.02,
    session_id: 'uuid-from-result',
    ...over,
  })}\n`;

describe('createRunTracker', () => {
  let ledger: {
    from?: string;
    kind: string;
    body?: string;
    meta?: Record<string, unknown>;
  }[];
  let statuses: string[];
  let lines: { name: string; count: number }[];
  let openAsks: boolean;
  /** Did the wake ask for a handoff? Set per test (HIVE-122). */
  let lastTurn: boolean;
  /** What the run left behind as a handoff, if anything (HIVE-122). */
  let handoff: string | undefined;
  let commandCalls: number;
  let commandArgs: { name: string; trigger: string; extra?: string }[];
  let closed: string[];
  let statusWhenClosed: string | undefined;
  let tracker: ReturnType<typeof createRunTracker>;
  let state: ReturnType<typeof createAgentState>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetChildProcessMock();
    ledger = [];
    statuses = [];
    lines = [];
    openAsks = false;
    lastTurn = false;
    handoff = undefined;
    commandCalls = 0;
    commandArgs = [];
    closed = [];
    statusWhenClosed = undefined;
    state = createAgentState({ path: '/dev/null/agents.json', debounceMs: 1 });

    tracker = createRunTracker({
      spawn,
      command: (name, trigger, extra) => {
        commandCalls += 1;
        commandArgs.push({ name, trigger, ...(extra === undefined ? {} : { extra }) });

        return {
          file: '/opt/bin/claude',
          args: ['-p', 'do it'],
          env: { HIVE_AGENT: '1' },
          cwd: '/tmp/work',
          sessionUuid: `sess-${commandCalls}`,
          lastTurn,
        };
      },
      state,
      appendLedger: (entry) => ledger.push(entry),
      openAsksFor: () => openAsks,
      handoffFor: () => handoff,
      newUuid: () => 'uuid-minted',
      pushStatus: (name) => statuses.push(name),
      pushLines: (name, pushed) => lines.push({ name, count: pushed.length }),
      onRunClosed: (name) => {
        closed.push(name);
        statusWhenClosed = state.read(name).status;
      },
      now: () => 1_000,
      newRunId: () => 'run-1',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns the command it was given and reports the run started', () => {
    const start = tracker.run('a', 'ledger');

    expect(start).toEqual({ started: true, run: 'run-1' });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.file).toBe('/opt/bin/claude');
    expect(spawnCalls[0]?.options).toMatchObject({ cwd: '/tmp/work' });
  });

  /**
   * The trigger is part of the **command line**, not only a label for the log:
   * `wakePrompt` writes "You woke because: <trigger>[ — <extra>]" into the
   * prompt the process is started with. A builder handed only the name could
   * not spell the argv, so this is the assertion that keeps the dependency
   * honest — it is what a mutable slot in the composition was standing in for
   * before the signature was widened.
   */
  it('hands the builder the trigger and the extra, not only the name', () => {
    tracker.run('a', 'ledger', 'a12 was answered');

    expect(commandArgs).toEqual([
      { name: 'a', trigger: 'ledger', extra: 'a12 was answered' },
    ]);
  });

  it('omits the extra when the wake had none, rather than inventing one', () => {
    tracker.run('a', 'manual');

    expect(commandArgs).toEqual([{ name: 'a', trigger: 'manual' }]);
  });

  it('appends run.started and sets the agent working', () => {
    tracker.run('a', 'ledger');

    expect(ledger[0]).toMatchObject({
      kind: 'event',
      meta: { run: 'run-1', trigger: 'ledger' },
    });
    expect(state.read('a').status).toBe('working');
  });

  /*
    Cleared where a run *starts*, not where the scheduler's tick decides to
    start one (HIVE-121).

    Every trigger resets it: a manual `run <agent>` or a ledger wake proves the
    agent is alive exactly as well as a scheduled wake does. A count only some
    wakes cleared would be a different number from the one the label beside it
    promises — `skipped 3` next to an agent that has since run twice.
  */
  it('clears the skip count when a run starts, whatever started it', () => {
    state.patch('a', { skipsSinceRun: 3 });

    expect(tracker.run('a', 'manual').started).toBe(true);
    expect(state.read('a').skipsSinceRun).toBe(0);
  });

  it('leaves the skip count alone when the run is refused', () => {
    state.patch('a', { skipsSinceRun: 3, status: 'paused' });

    expect(tracker.run('a', 'manual')).toEqual({ started: false, refused: 'paused' });
    expect(state.read('a').skipsSinceRun).toBe(3);
  });

  it('refuses a second run while one is live', () => {
    tracker.run('a', 'ledger');

    expect(tracker.run('a', 'ledger')).toEqual({
      started: false,
      refused: 'working',
    });
    expect(spawnCalls).toHaveLength(1);
  });

  it('refuses to start when the command cannot be built', () => {
    const refusing = createRunTracker({
      spawn,
      command: (_name: string) => ({ problem: 'claude was not found on PATH.' }),
      state,
      appendLedger: () => {},
      openAsksFor: () => false,
      handoffFor: () => undefined,
      newUuid: () => 'uuid-minted',
      pushStatus: () => {},
      pushLines: () => {},
      now: () => 1,
      newRunId: () => 'run-x',
    });

    expect(refusing.run('a', 'ledger')).toEqual({
      started: false,
      refused: 'invalid',
      reason: 'claude was not found on PATH.',
    });
  });

  it('closes failed when spawn itself throws synchronously, without orphaning the ledger entry or bumping runsSinceRotate', () => {
    const throwing = createRunTracker({
      spawn: () => {
        throw new Error('EMFILE: too many open files');
      },
      command: (_name: string) => ({
        file: '/opt/bin/claude',
        args: [],
        env: {},
        cwd: '/tmp/work',
        sessionUuid: 'sess-1',
        lastTurn: false,
      }),
      state,
      appendLedger: (entry) => ledger.push(entry),
      openAsksFor: () => false,
      handoffFor: () => undefined,
      newUuid: () => 'uuid-minted',
      pushStatus: (name) => statuses.push(name),
      pushLines: () => {},
      now: () => 1_000,
      newRunId: () => 'run-1',
    });

    const start = throwing.run('a', 'ledger');

    // Refused, not started: there is no process, so a renderer told `started`
    // would draw a working row and a stop button for nothing.
    expect(start).toEqual({
      started: false,
      refused: 'invalid',
      reason: 'EMFILE: too many open files',
    });
    // The run is still recorded, because `run.started` is already written.
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({ body: 'run.started — ledger' });
    expect(ledger[1]).toMatchObject({
      body: 'run.ended — failed',
      meta: { outcome: 'failed', reason: 'EMFILE: too many open files' },
    });
    expect(state.read('a').runs.at(-1)?.outcome).toBe('failed');
    expect(state.read('a').runsSinceRotate).toBe(0);
  });

  it('pushes folded lines as the child writes', () => {
    tracker.run('a', 'ledger');
    childInstances[0]?.emitStdout(
      `${JSON.stringify({
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] },
      })}\n`,
    );

    expect(lines).toEqual([{ name: 'a', count: 1 }]);
  });

  it('folds stderr into a run line', () => {
    tracker.run('a', 'ledger');
    childInstances[0]?.emitStderr('warning: something noisy\n');

    expect(lines).toEqual([{ name: 'a', count: 1 }]);
  });

  it('folds a result line split across two stdout writes, and still captures the result', () => {
    tracker.run('a', 'ledger');

    const whole = resultLine();
    const splitAt = Math.floor(whole.length / 2);

    childInstances[0]?.emitStdout(whole.slice(0, splitAt));
    childInstances[0]?.emitStdout(whole.slice(splitAt));
    childInstances[0]?.emitClose(0);

    const persisted = state.read('a');

    expect(persisted.runs.at(-1)?.outcome).toBe('done');
    expect(persisted.sessionUuid).toBe('uuid-from-result');
  });

  it('closes done on close and persists the session uuid, pushing status on start and on close', () => {
    tracker.run('a', 'ledger');
    childInstances[0]?.emitStdout(resultLine());
    childInstances[0]?.emitClose(0);

    const persisted = state.read('a');

    expect(persisted.status).toBe('sleeping');
    expect(persisted.sessionUuid).toBe('uuid-from-result');
    expect(persisted.runsSinceRotate).toBe(1);
    expect(persisted.runs.at(-1)).toMatchObject({
      outcome: 'done',
      costUsd: 0.02,
    });
    expect(statuses).toEqual(['a', 'a']);
  });

  it('persists the slack status the init event reported (HIVE-123)', () => {
    const init = `${JSON.stringify({
      type: 'system',
      subtype: 'init',
      mcp_servers: [{ name: 'slack', status: 'needs-auth' }],
    })}\n`;

    tracker.run('a', 'ledger');
    childInstances[0]?.emitStdout(init);
    childInstances[0]?.emitStdout(resultLine());
    childInstances[0]?.emitClose(0);

    expect(state.read('a').runs.at(-1)?.slack).toBe('needs-auth');
  });

  it('records slack connected when the init event names it without needs-auth', () => {
    const init = `${JSON.stringify({
      type: 'system',
      subtype: 'init',
      mcp_servers: [{ name: 'slack', status: 'connected' }],
    })}\n`;

    tracker.run('a', 'ledger');
    childInstances[0]?.emitStdout(init);
    childInstances[0]?.emitStdout(resultLine());
    childInstances[0]?.emitClose(0);

    expect(state.read('a').runs.at(-1)?.slack).toBe('connected');
  });

  /**
   * The two halves of the story have to agree about the same server.
   * `integrations/slack/status.ts` calls an unrecognised status an error, so
   * this side must not call it connected — the earlier form read "anything
   * that is not needs-auth" as a working connection.
   */
  it('claims nothing when the init event reports a status it does not recognise', () => {
    const init = `${JSON.stringify({
      type: 'system',
      subtype: 'init',
      mcp_servers: [{ name: 'slack', status: 'failed' }],
    })}\n`;

    tracker.run('a', 'ledger');
    childInstances[0]?.emitStdout(init);
    childInstances[0]?.emitStdout(resultLine());
    childInstances[0]?.emitClose(0);

    expect(state.read('a').runs.at(-1)?.slack).toBeUndefined();
  });

  it('leaves slack unset when the run never named it', () => {
    tracker.run('a', 'ledger');
    childInstances[0]?.emitStdout(resultLine());
    childInstances[0]?.emitClose(0);

    expect(state.read('a').runs.at(-1)?.slack).toBeUndefined();
  });

  it('reports a closed run, after the status is on disk', () => {
    // The scheduler reads the status back inside this callback to decide
    // whether to flush its queue, so it has to run after the patch.
    tracker.run('a', 'ledger');
    childInstances[0]?.emitStdout(resultLine());
    childInstances[0]?.emitClose(0);

    expect(closed).toEqual(['a']);
    expect(statusWhenClosed).toBe('sleeping');
  });

  it('reports a run that closed into paused, so the scheduler can hold', () => {
    /*
      HIVE-117 lets a pause land mid-run and `finalizeRun` holds it. The
      callback still fires — the scheduler is what decides that a paused agent
      keeps its queue, and it cannot decide that without being told.
    */
    tracker.run('a', 'ledger');
    state.patch('a', { status: 'paused' });
    childInstances[0]?.emitStdout(resultLine());
    childInstances[0]?.emitClose(0);

    expect(closed).toEqual(['a']);
    expect(statusWhenClosed).toBe('paused');
  });

  it('reports a run that never reached a process', () => {
    // The spawn-failure path finalizes too, and a queue filed against that
    // agent would otherwise wait for a close that is never coming.
    const throwing = createRunTracker({
      spawn: () => {
        throw new Error('EMFILE: too many open files');
      },
      command: () => ({
        file: '/opt/bin/claude',
        args: [],
        env: {},
        cwd: '/tmp/work',
        sessionUuid: 'sess-1',
        lastTurn: false,
      }),
      state,
      appendLedger: (entry) => ledger.push(entry),
      openAsksFor: () => false,
      handoffFor: () => undefined,
      newUuid: () => 'uuid-minted',
      pushStatus: () => {},
      pushLines: () => {},
      onRunClosed: (name) => closed.push(name),
      now: () => 1_000,
      newRunId: () => 'run-1',
    });

    throwing.run('a', 'ledger');

    expect(closed).toEqual(['a']);
  });

  it('a result that arrives after exit but before close still counts (close is authoritative)', () => {
    tracker.run('a', 'ledger');
    childInstances[0]?.emitExit(0);
    childInstances[0]?.emitStdout(resultLine());
    childInstances[0]?.emitClose(0);

    const persisted = state.read('a');

    expect(persisted.runs.at(-1)?.outcome).toBe('done');
    expect(persisted.sessionUuid).toBe('uuid-from-result');
  });

  it('finalizes on the flush-window fallback when close never fires after exit', () => {
    tracker.run('a', 'ledger');
    childInstances[0]?.emitStdout(resultLine());
    childInstances[0]?.emitExit(0);

    expect(state.read('a').runs).toHaveLength(0);

    vi.advanceTimersByTime(2_000);

    expect(state.read('a').runs.at(-1)?.outcome).toBe('done');
  });

  it('closes failed on a non-zero close', () => {
    tracker.run('a', 'ledger');
    childInstances[0]?.emitClose(1);

    expect(state.read('a').runs.at(-1)?.outcome).toBe('failed');
    expect(state.read('a').status).toBe('sleeping');
  });

  it('closes turns when the turn cap stopped it, even though the process exits non-zero', () => {
    tracker.run('a', 'ledger');
    childInstances[0]?.emitStdout(resultLine({ subtype: 'error_max_turns' }));
    childInstances[0]?.emitClose(1);

    expect(state.read('a').runs.at(-1)?.outcome).toBe('turns');
  });

  it('closes budget when the budget cap stopped it, even though the process exits non-zero', () => {
    tracker.run('a', 'ledger');
    childInstances[0]?.emitStdout(resultLine({ subtype: 'error_max_budget_usd' }));
    childInstances[0]?.emitClose(1);

    expect(state.read('a').runs.at(-1)?.outcome).toBe('budget');
  });

  it('closes asking when the run left an open ask, and says so in the status', () => {
    openAsks = true;
    tracker.run('a', 'ledger');
    childInstances[0]?.emitStdout(resultLine());
    childInstances[0]?.emitClose(0);

    expect(state.read('a').runs.at(-1)?.outcome).toBe('asking');
    expect(state.read('a').status).toBe('asking');
  });

  it('closes exactly once, and a late Stop is harmless', () => {
    tracker.run('a', 'ledger');
    childInstances[0]?.emitStdout(resultLine());
    childInstances[0]?.emitClose(0);

    const runsAfterClose = state.read('a').runs.length;

    tracker.noteTurnEnded('a');
    vi.advanceTimersByTime(AGENT_STALL_GRACE_MS * 2);

    expect(state.read('a').runs).toHaveLength(runsAfterClose);
  });

  it('does not double-record a run on a repeated exit/close after it has already closed', () => {
    tracker.run('a', 'ledger');
    childInstances[0]?.emitStdout(resultLine());
    childInstances[0]?.emitClose(0);

    const runsAfterClose = state.read('a').runs.length;
    const rotateAfterClose = state.read('a').runsSinceRotate;

    childInstances[0]?.emitExit(0);
    childInstances[0]?.emitClose(0);

    expect(state.read('a').runs).toHaveLength(runsAfterClose);
    expect(state.read('a').runsSinceRotate).toBe(rotateAfterClose);
  });

  it('killAll after a run has already closed is a no-op', () => {
    tracker.run('a', 'ledger');
    childInstances[0]?.emitStdout(resultLine());
    childInstances[0]?.emitClose(0);

    const runsAfterClose = state.read('a').runs.length;
    const rotateAfterClose = state.read('a').runsSinceRotate;

    tracker.killAll('app-closed');

    expect(state.read('a').runs).toHaveLength(runsAfterClose);
    expect(state.read('a').runsSinceRotate).toBe(rotateAfterClose);
    expect(childInstances[0]?.killSignals).toEqual([]);
  });

  /**
   * The uuid is known at spawn, so a run that ends without a `result` must
   * still persist it. Without this the first wake of an agent — interrupted by
   * a quit, a kill, a stall or a crash — left `agents.json` with no uuid, the
   * next wake minted a fresh one, and the conversation was orphaned.
   */
  it('persists the session uuid it invoked even when no result ever arrived', () => {
    tracker.run('a', 'ledger');
    tracker.kill('a');
    childInstances[0]?.emitClose(null, 'SIGTERM');

    expect(state.read('a').sessionUuid).toBe('sess-1');
  });

  it('prefers the uuid the result reported over the one it invoked', () => {
    tracker.run('a', 'ledger');
    childInstances[0]?.emitStdout(resultLine());
    childInstances[0]?.emitClose(0);

    expect(state.read('a').sessionUuid).toBe('uuid-from-result');
  });

  it('persists no uuid for a run that never reached the model', () => {
    tracker.run('a', 'ledger');
    childInstances[0]?.emitError(new Error('spawn ENOENT'));

    // Nothing started a conversation, so `--resume` would have nothing to find
    // and the next wake must mint its own.
    expect(state.read('a').sessionUuid).toBeUndefined();
  });

  /**
   * `result` is the LAST thing `claude` writes, which makes it the line most
   * likely to be sitting in `partial` with no `\n` behind it when the process
   * dies. Dropping it recorded a healthy run `failed`, with no cost and no
   * uuid — the exact loss `'close'`-over-`'exit'` was chosen to prevent.
   */
  it('folds an unterminated final line before reading the result', () => {
    tracker.run('a', 'ledger');
    childInstances[0]?.emitStdout(resultLine().trimEnd());
    childInstances[0]?.emitClose(0);

    expect(state.read('a').runs.at(-1)).toMatchObject({
      outcome: 'done',
      costUsd: 0.02,
    });
    expect(state.read('a').sessionUuid).toBe('uuid-from-result');
  });

  /**
   * `close()` cannot remove the listeners — the child object outlives it — so a
   * grandchild holding the pipe would otherwise fold output into a finalized
   * run, and the renderer would see it interleaved with the next run's lines.
   */
  it('ignores stdout and stderr that arrive after the run has closed', () => {
    tracker.run('a', 'ledger');
    childInstances[0]?.emitStdout(resultLine());
    childInstances[0]?.emitClose(0);

    const pushedByTheRun = lines.length;

    childInstances[0]?.emitStdout(
      `${JSON.stringify({
        type: 'assistant',
        message: { id: 'm2', content: [{ type: 'text', text: 'still here' }] },
      })}\n`,
    );
    childInstances[0]?.emitStderr('a grandchild still holds the pipe\n');

    expect(lines).toHaveLength(pushedByTheRun);
  });

  /**
   * The outcome stays honest — the run *was* killed — but the status is about
   * what the user has to do next, and an unanswered question is that.
   */
  it('reports asking when a killed run left a question open, without softening the outcome', () => {
    openAsks = true;
    tracker.run('a', 'ledger');
    tracker.kill('a');
    childInstances[0]?.emitClose(null, 'SIGTERM');

    expect(state.read('a').runs.at(-1)).toMatchObject({
      outcome: 'failed',
      reason: 'killed',
    });
    expect(state.read('a').status).toBe('asking');
  });

  it('kills a stalled run when Stop arrives and the process does not exit', () => {
    tracker.run('a', 'ledger');
    tracker.noteTurnEnded('a', 'sess-1');

    vi.advanceTimersByTime(AGENT_STALL_GRACE_MS);

    expect(childInstances[0]?.killSignals).toContain('SIGTERM');

    childInstances[0]?.emitClose(null, 'SIGTERM');

    expect(state.read('a').runs.at(-1)).toMatchObject({
      outcome: 'failed',
      reason: 'stalled',
    });
  });

  /**
   * The two graces are separate constants, and this is the assertion that
   * keeps them from quietly becoming one again. A healthy run gets longer
   * after `Stop` than a run that was told to die: it still has to emit
   * `result` — the only carrier of cost, turns and uuid — and reap its MCP
   * child.
   */
  it('gives a stalling run longer than the kill grace before SIGTERM', () => {
    tracker.run('a', 'ledger');
    tracker.noteTurnEnded('a', 'sess-1');

    vi.advanceTimersByTime(AGENT_KILL_GRACE_MS);

    expect(childInstances[0]?.killSignals).toEqual([]);

    vi.advanceTimersByTime(AGENT_STALL_GRACE_MS - AGENT_KILL_GRACE_MS);

    expect(childInstances[0]?.killSignals).toContain('SIGTERM');
  });

  it("ignores a Stop whose session uuid belongs to a prior, already-closed run of the same agent", () => {
    tracker.run('a', 'ledger'); // run 1, sess-1
    childInstances[0]?.emitStdout(resultLine());
    childInstances[0]?.emitClose(0);

    tracker.run('a', 'ledger'); // run 2, sess-2 — a fresh, healthy run

    tracker.noteTurnEnded('a', 'sess-1'); // stale Stop for run 1, arriving late
    vi.advanceTimersByTime(AGENT_STALL_GRACE_MS);

    expect(childInstances[1]?.killSignals).toEqual([]);
  });

  it('escalates SIGTERM to SIGKILL after the grace', () => {
    tracker.run('a', 'ledger');
    tracker.kill('a');

    expect(childInstances[0]?.killSignals).toEqual(['SIGTERM']);

    vi.advanceTimersByTime(AGENT_KILL_GRACE_MS);

    expect(childInstances[0]?.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('records a killed run as failed (with the reason in the ledger) and frees the agent for the next one', () => {
    tracker.run('a', 'ledger');
    tracker.kill('a');
    childInstances[0]?.emitClose(null, 'SIGTERM');

    expect(state.read('a').runs.at(-1)).toMatchObject({
      outcome: 'failed',
      reason: 'killed',
    });
    expect(ledger.at(-1)).toMatchObject({
      kind: 'event',
      body: 'run.ended — failed',
      meta: { run: 'run-1', outcome: 'failed', reason: 'killed' },
    });
    expect(tracker.run('a', 'ledger')).toMatchObject({ started: true });
  });

  it('records every live run as failed when the app closes, for every agent', () => {
    tracker.run('a', 'ledger');
    tracker.run('b', 'ledger');
    tracker.killAll('app-closed');
    childInstances[0]?.emitClose(null, 'SIGTERM');
    childInstances[1]?.emitClose(null, 'SIGTERM');

    expect(state.read('a').runs.at(-1)).toMatchObject({
      outcome: 'failed',
      reason: 'app-closed',
    });
    expect(state.read('b').runs.at(-1)).toMatchObject({
      outcome: 'failed',
      reason: 'app-closed',
    });
  });

  it('records every live run on closeAll, with no close event at all', () => {
    tracker.run('a', 'ledger');
    tracker.run('b', 'ledger');

    tracker.closeAll('app-closed');

    /*
      Deliberately no `emitClose()`. The quit path awaits a synchronous hook, so
      the child's 'close' cannot arrive before the process is gone — a test that
      hand-fires it (as the `killAll` case above does) is proving something the
      real path never gets to do.
    */
    for (const name of ['a', 'b']) {
      expect(state.read(name).runs.at(-1)).toMatchObject({
        outcome: 'failed',
        reason: 'app-closed',
      });
      expect(state.read(name).status).toBe('sleeping');
      // Rotation must not drift: a run that reached the model counts.
      expect(state.read(name).runsSinceRotate).toBe(1);
    }

    // Both ends of both runs are in the log — no orphaned `run.started`.
    expect(
      ledger.filter((entry) => entry.body === 'run.ended — failed'),
    ).toHaveLength(2);
    expect(childInstances[0]?.killSignals).toEqual(['SIGTERM']);
    expect(childInstances[1]?.killSignals).toEqual(['SIGTERM']);
    expect(tracker.live()).toEqual([]);
  });

  it('ignores a close that arrives after closeAll already recorded the run', () => {
    tracker.run('a', 'ledger');
    tracker.closeAll('app-closed');
    childInstances[0]?.emitClose(0, null);

    expect(state.read('a').runs).toHaveLength(1);
    expect(
      ledger.filter((entry) => entry.body?.startsWith('run.ended')),
    ).toHaveLength(1);
  });

  it('closes failed when the spawn itself errors, and does not bump runsSinceRotate', () => {
    tracker.run('a', 'ledger');
    childInstances[0]?.emitError(new Error('ENOENT'));

    expect(state.read('a').runs.at(-1)?.outcome).toBe('failed');
    expect(state.read('a').runsSinceRotate).toBe(0);
  });

  /**
   * HIVE-117. `paused` is a status, not a second field, so the tracker is what
   * has to honour it: the two places a run's status is decided are the only
   * two places a pause could be lost.
   */
  describe('paused (HIVE-117)', () => {
    it('refuses to wake a paused agent, and never reaches the command builder', () => {
      state.patch('a', { status: 'paused' });

      expect(tracker.run('a', 'manual')).toEqual({
        started: false,
        refused: 'paused',
      });
      /*
        Refused *before* `deps.command`, not after: building the argv reads the
        definition off disk and mints a session uuid, and a refusal that did
        that work first would rotate a paused agent's session by being asked.
      */
      expect(commandCalls).toBe(0);
      expect(spawnCalls).toHaveLength(0);
      // No `run.started` for a run that never started.
      expect(ledger).toEqual([]);
    });

    it('leaves a run that was live at pause time paused when it ends', () => {
      tracker.run('a', 'ledger');
      // The pause lands mid-turn — the design lets the turn finish rather than
      // killing it, so this is the ordering that actually happens.
      state.patch('a', { status: 'paused' });
      childInstances[0]?.emitStdout(resultLine());
      childInstances[0]?.emitClose(0);

      const persisted = state.read('a');

      /*
        Without the guard in `finalizeRun`, this reads `sleeping` a few seconds
        after the user paused it — the pause silently undone by the turn it was
        careful not to kill.
      */
      expect(persisted.status).toBe('paused');
      // The run itself is still recorded honestly; only the status is held.
      expect(persisted.runs.at(-1)?.outcome).toBe('done');
      expect(persisted.runsSinceRotate).toBe(1);
    });

    it('holds paused even when the finished run left an open ask', () => {
      openAsks = true;
      tracker.run('a', 'ledger');
      state.patch('a', { status: 'paused' });
      childInstances[0]?.emitStdout(resultLine());
      childInstances[0]?.emitClose(0);

      /*
        `asking` outranks the outcome for an agent that is awake; it does not
        outrank an explicit pause. The ask is not lost — `resume` recomputes and
        finds it — but until then the row says what the user did last.
      */
      expect(state.read('a').status).toBe('paused');
    });
  });

  /**
   * HIVE-122. The wake that crosses the threshold only *asks* for a handoff;
   * the close is what decides whether the rotation happens. An agent that was
   * cut off by its turn cap, or that simply ignored the instruction, keeps its
   * conversation rather than losing it silently.
   */
  describe('rotation at close (HIVE-122)', () => {
    const runToClose = (name: string) => {
      const index = childInstances.length;

      tracker.run(name, 'ledger');
      childInstances[index]?.emitStdout(resultLine());
      childInstances[index]?.emitClose(0);
    };

    const runThatFailsToSpawn = (name: string) => {
      const index = childInstances.length;

      tracker.run(name, 'ledger');
      childInstances[index]?.emitError(new Error('spawn ENOENT'));
    };

    it('mints a pending session when the agent posted a handoff', () => {
      lastTurn = true;
      handoff = 'I watch #ops.';
      state.patch('drone', { runsSinceRotate: 50 });

      runToClose('drone');

      const after = state.read('drone');

      expect(after.pendingSession).toEqual({
        uuid: 'uuid-minted',
        handoff: 'I watch #ops.',
      });
      expect(after.runsSinceRotate).toBe(0);
      expect(after.rotateFailures).toBe(0);
      // The uuid the agent is still on is untouched until that session runs.
      expect(after.sessionUuid).not.toBe('uuid-minted');
    });

    it('does not rotate when no handoff was posted, and takes a strike', () => {
      lastTurn = true;
      handoff = undefined;
      state.patch('drone', { runsSinceRotate: 50 });

      runToClose('drone');

      const after = state.read('drone');

      expect(after.pendingSession).toBeUndefined();
      expect(after.runsSinceRotate).toBe(51);
      expect(after.rotateFailures).toBe(1);
    });

    it('asks a human to look on the third failure, exactly once', () => {
      lastTurn = true;
      handoff = undefined;
      state.patch('drone', { runsSinceRotate: 50, rotateFailures: 2 });

      runToClose('drone');

      expect(state.read('drone').rotateFailures).toBe(3);
      expect(ledger).toContainEqual(
        expect.objectContaining({
          from: OVERMIND,
          kind: 'event',
          meta: expect.objectContaining({ rotateFailed: 3, agent: 'drone' }),
        }),
      );

      ledger.length = 0;
      runToClose('drone');

      expect(state.read('drone').rotateFailures).toBe(4);
      expect(
        ledger.filter((entry) => entry.meta?.['rotateFailed'] !== undefined),
      ).toEqual([]);
    });

    /*
      The invariant behind `const failures = strike ? … : null`.

      `rotateFailures + 1` is only a meaningful number on a close that is a
      strike: an agent already sitting at `rotateFailures: 2` reaches 3 on its
      very next close even when that close is a *successful* rotation. Sizing
      it unconditionally and guarding both readers with `strike &&` worked, but
      one forgotten guard raised a spurious "could not rotate" card on a run
      that had just rotated fine. This test is what says so out loud, whichever
      shape the code takes.
    */
    it('does not raise the card on a successful rotation, even at rotateFailures 2', () => {
      lastTurn = true;
      handoff = 'I watch #ops.';
      state.patch('drone', { runsSinceRotate: 50, rotateFailures: 2 });

      runToClose('drone');

      const after = state.read('drone');

      expect(after.pendingSession).toEqual({
        uuid: 'uuid-minted',
        handoff: 'I watch #ops.',
      });
      expect(after.rotateFailures).toBe(0);
      expect(
        ledger.filter((entry) => entry.meta?.['rotateFailed'] !== undefined),
      ).toEqual([]);
    });

    /*
      A strike is an accusation, and main must not level it at the agent for
      something main did. `kill`, the stall watchdog, `killAll` and the
      `closeAll` on quit all end the run before the agent could post anything —
      three app quits landing mid-handoff-wake would otherwise raise a card
      reading "three handoff wakes ended without a handoff", which is a claim
      about the agent that describes main's own behaviour.
    */
    it('does not take a strike when main killed the handoff wake', () => {
      lastTurn = true;
      handoff = undefined;
      state.patch('drone', { runsSinceRotate: 50 });

      const index = childInstances.length;

      tracker.run('drone', 'ledger');
      tracker.kill('drone');
      childInstances[index]?.emitClose(null, 'SIGTERM');

      const after = state.read('drone');

      expect(after.rotateFailures).toBeUndefined();
      expect(after.pendingSession).toBeUndefined();
    });

    it('does not take a strike when the app quit mid-handoff-wake', () => {
      lastTurn = true;
      handoff = undefined;
      state.patch('drone', { runsSinceRotate: 50, rotateFailures: 2 });

      tracker.run('drone', 'ledger');
      tracker.closeAll('app-closed');

      expect(state.read('drone').rotateFailures).toBe(2);
      expect(
        ledger.filter((entry) => entry.meta?.['rotateFailed'] !== undefined),
      ).toEqual([]);
    });

    it('does not take a strike when the run never reached the model', () => {
      lastTurn = true;
      handoff = undefined;
      state.patch('drone', { runsSinceRotate: 50 });

      runThatFailsToSpawn('drone');

      const after = state.read('drone');

      expect(after.rotateFailures).toBeUndefined();
      expect(after.runsSinceRotate).toBe(50);
    });

    it('ignores a handoff on an ordinary wake', () => {
      lastTurn = false;
      handoff = 'I watch #ops.';
      state.patch('drone', { runsSinceRotate: 3 });

      runToClose('drone');

      const after = state.read('drone');

      expect(after.pendingSession).toBeUndefined();
      expect(after.runsSinceRotate).toBe(4);
    });

    it('records the session uuid the run ran on', () => {
      runToClose('drone');

      expect(state.read('drone').runs.at(-1)?.sessionUuid).toBe(
        'uuid-from-result',
      );
    });
  });
});
