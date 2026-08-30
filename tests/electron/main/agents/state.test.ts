import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentState } from '../../../../electron/main/agents/state';
import { AGENT_RUN_HISTORY } from '../../../../electron/shared/agent-contract';

const summary = (run: string) => ({
  run,
  trigger: 'ledger',
  startedAt: 1,
  endedAt: 2,
  outcome: 'done' as const,
});

describe('createAgentState', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(join(tmpdir(), 'hive-agent-state-'));
    path = join(dir, 'agents.json');
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it('reads an unknown agent as sleeping with no runs', () => {
    const state = createAgentState({ path });

    expect(state.read('nobody')).toEqual({
      status: 'sleeping',
      runsSinceRotate: 0,
      runs: [],
    });
  });

  it('coalesces writes and only touches disk once the debounce elapses', async () => {
    const state = createAgentState({ path, debounceMs: 400 });

    state.patch('a', { status: 'working' });
    state.patch('a', { lastRunAt: 99 });

    await expect(readFile(path, 'utf8')).rejects.toThrow();

    vi.advanceTimersByTime(400);

    const written = JSON.parse(await readFile(path, 'utf8'));

    expect(written['a']).toMatchObject({ status: 'working', lastRunAt: 99 });
  });

  it('flushes synchronously for shutdown', async () => {
    const state = createAgentState({ path, debounceMs: 400 });

    state.patch('a', { status: 'working' });
    state.flush();

    const written = JSON.parse(await readFile(path, 'utf8'));

    expect(written['a'].status).toBe('working');
  });

  it('cancels a pending write on dispose, leaving nothing on disk', async () => {
    const state = createAgentState({ path, debounceMs: 400 });

    state.patch('a', { status: 'working' });
    state.dispose();

    // The whole point: the debounce timer closes over the write, so dropping
    // the reference alone would still fire one `writeFileSync` at a path a
    // test stubbed and has since finished with.
    vi.advanceTimersByTime(400);

    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });

  it('seeds from an existing file', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ a: { status: 'sleeping', runsSinceRotate: 3, runs: [], sessionUuid: 'u-1' } }),
      'utf8',
    );

    const state = createAgentState({ path });

    expect(state.read('a').sessionUuid).toBe('u-1');
    expect(state.read('a').runsSinceRotate).toBe(3);
  });

  it('survives a corrupt file rather than refusing to start', async () => {
    await writeFile(path, '{ not json', 'utf8');

    const state = createAgentState({ path });

    expect(state.all()).toEqual({});
  });

  /**
   * `working` is a claim about a live child process, and every child died with
   * the app that spawned them. A force-quit or a crash runs no shutdown hook,
   * so the claim is left true on disk and nothing would ever correct it: the
   * tracker's map starts empty, no `close` is coming, and `agents:kill` answers
   * `false` for a name it does not hold.
   */
  it('wakes a persisted working agent, which no process backs any more', async () => {
    await writeFile(
      path,
      JSON.stringify({
        a: { status: 'working', runsSinceRotate: 2, runs: [], sessionUuid: 'u-1' },
      }),
      'utf8',
    );

    const state = createAgentState({ path });

    expect(state.read('a').status).toBe('sleeping');
    // Only the status is touched — the conversation and the counter are still
    // true, and losing them would cost the agent its history.
    expect(state.read('a').sessionUuid).toBe('u-1');
    expect(state.read('a').runsSinceRotate).toBe(2);
  });

  it('leaves a persisted asking agent alone — the ledger entry survived too', async () => {
    await writeFile(
      path,
      JSON.stringify({ a: { status: 'asking', runsSinceRotate: 0, runs: [] } }),
      'utf8',
    );

    expect(createAgentState({ path }).read('a').status).toBe('asking');
  });

  it('forgets an agent outright, so a reused name starts clean', () => {
    const state = createAgentState({ path });

    state.patch('a', { sessionUuid: 'u-1', runsSinceRotate: 4 });
    state.forget('a');

    expect(state.all()).toEqual({});
    expect(state.read('a').sessionUuid).toBeUndefined();
  });

  it('carries an entry to a new name, so a rename keeps the conversation', () => {
    const state = createAgentState({ path });

    state.patch('a', { sessionUuid: 'u-1', runsSinceRotate: 4 });
    state.carry('a', 'b');

    expect(state.read('b')).toMatchObject({
      sessionUuid: 'u-1',
      runsSinceRotate: 4,
    });
    expect(state.all()['a']).toBeUndefined();
  });

  it('carrying an agent that never ran writes nothing', () => {
    const state = createAgentState({ path });

    state.carry('a', 'b');

    expect(state.all()).toEqual({});
  });

  it('keeps only the most recent runs', () => {
    const state = createAgentState({ path });

    for (let i = 0; i < AGENT_RUN_HISTORY + 5; i += 1) {
      state.recordRun('a', summary(`run-${i}`));
    }

    const runs = state.read('a').runs;

    expect(runs).toHaveLength(AGENT_RUN_HISTORY);
    expect(runs[runs.length - 1]?.run).toBe(`run-${AGENT_RUN_HISTORY + 4}`);
  });
});
