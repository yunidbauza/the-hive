// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type {
  AgentRunState,
  AgentsSnapshot,
  AgentSummary,
} from '../../../../electron/shared/agent-contract';
import { agentsDirectoryFor } from '../../../../electron/main/agents/directory';

/**
 * The directory a peer sees (HIVE-127).
 *
 * Everything worth getting wrong here is a data decision — who is excluded,
 * which status is reported, and above all which fields cross the process
 * boundary into a model's context — so all of it is asserted here, where no
 * socket and no child process is involved.
 */

const agent = (over: Partial<AgentSummary> & { name: string }): AgentSummary => ({
  description: '',
  icon: 'ph-robot',
  status: 'sleeping',
  wake: { on: [] },
  mcp: [],
  tools: [],
  runs: [],
  rotateAfter: 20,
  ...over,
});

const snapshotOf = (...agents: AgentSummary[]): AgentsSnapshot => ({
  agents,
  agentsRoot: '/home/someone/.hive/agents',
});

const runState = (over: Partial<AgentRunState> = {}): AgentRunState => ({
  status: 'sleeping',
  runsSinceRotate: 0,
  runs: [],
  ...over,
});

describe('agentsDirectoryFor', () => {
  it('returns each peer with the fields a caller can act on', () => {
    const snapshot = snapshotOf(
      agent({
        name: 'pr-reviewer',
        description: 'Reviews open PRs for correctness and style.',
        wake: { on: ['ledger'] },
        tools: ['Bash(gh *)', 'Read'],
      }),
    );

    expect(agentsDirectoryFor('scout', snapshot, {}).agents).toEqual([
      {
        name: 'pr-reviewer',
        description: 'Reviews open PRs for correctness and style.',
        status: 'sleeping',
        accepts: ['ledger'],
        tools: ['Bash(gh *)', 'Read'],
      },
    ]);
  });

  it('excludes the caller, so an agent never finds itself', () => {
    const snapshot = snapshotOf(agent({ name: 'scout' }), agent({ name: 'pr-reviewer' }));

    expect(agentsDirectoryFor('scout', snapshot, {}).agents.map((a) => a.name)).toEqual([
      'pr-reviewer',
    ]);
  });

  /*
    An answer, not a failure. "There is nobody else here" is something a model
    can act on — do the work itself, or report that there is nobody to delegate
    to — and conflating it with an error would make both unreadable.
  */
  it('is empty, not an error, when the caller is the only agent', () => {
    expect(agentsDirectoryFor('scout', snapshotOf(agent({ name: 'scout' })), {})).toEqual({
      agents: [],
    });
  });

  it('sorts by name, so the output is stable for the model and the tests', () => {
    const snapshot = snapshotOf(
      agent({ name: 'zergling' }),
      agent({ name: 'drone' }),
      agent({ name: 'mutalisk' }),
    );

    expect(agentsDirectoryFor('overmind', snapshot, {}).agents.map((a) => a.name)).toEqual([
      'drone',
      'mutalisk',
      'zergling',
    ]);
  });

  /*
    `registry.list()` hard-codes `sleeping` because it has no way to tell —
    only `agents.json` has ever seen a process. A directory that skipped the
    join would confidently report every peer as asleep, which is worse than
    reporting nothing: a caller would queue behind an agent it believes idle.
  */
  it('reports the live status, not the registry placeholder', () => {
    const [peer] = agentsDirectoryFor('scout', snapshotOf(agent({ name: 'pr-reviewer' })), {
      'pr-reviewer': runState({ status: 'working' }),
    }).agents;

    expect(peer?.status).toBe('working');
  });

  it('lists a broken definition with its problem rather than hiding it', () => {
    const snapshot = snapshotOf(agent({ name: 'scout', invalid: "wake.on: unknown event 'ledgr'" }));

    expect(agentsDirectoryFor('pr-reviewer', snapshot, {}).agents[0]).toEqual({
      name: 'scout',
      description: '',
      status: 'sleeping',
      accepts: [],
      tools: [],
      invalid: "wake.on: unknown event 'ledgr'",
    });
  });

  it('omits invalid entirely when the definition parsed', () => {
    const snapshot = snapshotOf(agent({ name: 'pr-reviewer' }));

    expect(agentsDirectoryFor('scout', snapshot, {}).agents[0]).not.toHaveProperty('invalid');
  });

  /**
   * The guard that matters.
   *
   * `AgentSummary` carries a live conversation id and a spend figure. This
   * asserts the projection is a whitelist, so a field added to that type later
   * cannot silently ride along into a peer's context.
   */
  it('never leaks a field a peer has no business seeing', () => {
    const snapshot = snapshotOf(
      agent({
        name: 'pr-reviewer',
        sessionUuid: '11111111-2222-3333-4444-555555555555',
        cost: '$1.23',
        dailyUsd: 4.5,
        today: { day: '2026-09-01', runs: 9, usd: 4.5 },
        lastRunAt: 1_756_000_000_000,
      }),
    );

    const [peer] = agentsDirectoryFor('scout', snapshot, {}).agents;

    expect(Object.keys(peer ?? {}).sort()).toEqual([
      'accepts',
      'description',
      'name',
      'status',
      'tools',
    ]);
    expect(JSON.stringify(peer)).not.toContain('11111111');
    expect(JSON.stringify(peer)).not.toContain('.hive/agents');
  });

  it('copies the lists rather than aliasing the snapshot', () => {
    const source = agent({ name: 'pr-reviewer', wake: { on: ['ledger'] }, tools: ['Read'] });

    const [peer] = agentsDirectoryFor('scout', snapshotOf(source), {}).agents;

    expect(peer?.accepts).not.toBe(source.wake.on);
    expect(peer?.tools).not.toBe(source.tools);
  });
});
