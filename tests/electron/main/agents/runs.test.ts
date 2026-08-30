import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  childInstances,
  resetChildProcessMock,
  spawn,
  spawnCalls,
} from '../../../../__mocks__/child-process';
import { createAgentState } from '../../../../electron/main/agents/state';
import { createRunTracker } from '../../../../electron/main/agents/runs';
import { AGENT_KILL_GRACE_MS } from '../../../../electron/shared/agent-contract';

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
  let ledger: { kind: string; body?: string; meta?: Record<string, unknown> }[];
  let statuses: string[];
  let lines: { name: string; count: number }[];
  let openAsks: boolean;
  let commandCalls: number;
  let commandArgs: { name: string; trigger: string; extra?: string }[];
  let tracker: ReturnType<typeof createRunTracker>;
  let state: ReturnType<typeof createAgentState>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetChildProcessMock();
    ledger = [];
    statuses = [];
    lines = [];
    openAsks = false;
    commandCalls = 0;
    commandArgs = [];
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
        };
      },
      state,
      appendLedger: (entry) => ledger.push(entry),
      openAsksFor: () => openAsks,
      pushStatus: (name) => statuses.push(name),
      pushLines: (name, pushed) => lines.push({ name, count: pushed.length }),
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
      }),
      state,
      appendLedger: (entry) => ledger.push(entry),
      openAsksFor: () => false,
      pushStatus: (name) => statuses.push(name),
      pushLines: () => {},
      now: () => 1_000,
      newRunId: () => 'run-1',
    });

    const start = throwing.run('a', 'ledger');

    expect(start).toEqual({ started: true, run: 'run-1' });
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
    vi.advanceTimersByTime(AGENT_KILL_GRACE_MS * 2);

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

  it('kills a stalled run when Stop arrives and the process does not exit', () => {
    tracker.run('a', 'ledger');
    tracker.noteTurnEnded('a', 'sess-1');

    vi.advanceTimersByTime(AGENT_KILL_GRACE_MS);

    expect(childInstances[0]?.killSignals).toContain('SIGTERM');

    childInstances[0]?.emitClose(null, 'SIGTERM');

    expect(state.read('a').runs.at(-1)).toMatchObject({
      outcome: 'failed',
      reason: 'stalled',
    });
  });

  it("ignores a Stop whose session uuid belongs to a prior, already-closed run of the same agent", () => {
    tracker.run('a', 'ledger'); // run 1, sess-1
    childInstances[0]?.emitStdout(resultLine());
    childInstances[0]?.emitClose(0);

    tracker.run('a', 'ledger'); // run 2, sess-2 — a fresh, healthy run

    tracker.noteTurnEnded('a', 'sess-1'); // stale Stop for run 1, arriving late
    vi.advanceTimersByTime(AGENT_KILL_GRACE_MS);

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

  it('closes failed when the spawn itself errors, and does not bump runsSinceRotate', () => {
    tracker.run('a', 'ledger');
    childInstances[0]?.emitError(new Error('ENOENT'));

    expect(state.read('a').runs.at(-1)?.outcome).toBe('failed');
    expect(state.read('a').runsSinceRotate).toBe(0);
  });
});
