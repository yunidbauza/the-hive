// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { decide, decideForEvent, laneClaims, laneFor, laneOfRun } from '../../../../electron/main/agents/scheduler-rules';
import type { AgentStatus } from '../../../../electron/shared/agent-contract';
import type { LedgerEntry } from '../../../../electron/shared/ledger-contract';

const AGENT = 'pr-reviewer';

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: 'a1',
  ts: 0,
  from: 'overmind',
  to: AGENT,
  kind: 'ask',
  body: 'take a look?',
  ...over,
});

describe('decide', () => {
  it('wakes an agent that is not running', () => {
    const resting: AgentStatus[] = ['sleeping', 'asking', 'failed'];

    for (const status of resting) {
      expect(decide(status, entry())).toBe('wake');
    }
  });

  it('queues while the agent is working', () => {
    expect(decide('working', entry())).toBe('queue');
  });

  it('holds while the agent is paused', () => {
    expect(decide('paused', entry())).toBe('hold');
  });

  it('wakes on every addressed kind that is news', () => {
    for (const kind of ['ask', 'answer', 'done', 'failed', 'post'] as const) {
      expect(decide('sleeping', entry({ kind }))).toBe('wake');
    }
  });

  it('ignores an event — that is the loop guard, not a filter', () => {
    // The scheduler appends events itself (the expiry sweep), and every wake
    // it causes appends `run.started` and `run.ended`. Waking on an event
    // would make each wake cause the next one.
    expect(decide('sleeping', entry({ kind: 'event' }))).toBe('ignore');
  });

  it('ignores the bookkeeping kinds', () => {
    for (const kind of ['claim', 'release', 'handoff'] as const) {
      expect(decide('sleeping', entry({ kind }))).toBe('ignore');
    }
  });

  it('ignores a broadcast — parties read those on their next wake', () => {
    expect(decide('sleeping', entry({ to: undefined }))).toBe('ignore');
  });

  it('ignores an entry the agent addressed to itself', () => {
    expect(decide('sleeping', entry({ from: AGENT, to: AGENT }))).toBe('ignore');
  });

  it('ignores a kind it does not wake on before it reads the status', () => {
    // The kind gate is not conditional on the agent's state: a paused agent
    // receiving an `event` queues nothing, or the queue would fill with
    // entries that could never have woken it.
    expect(decide('paused', entry({ kind: 'event' }))).toBe('ignore');
    expect(decide('working', entry({ kind: 'claim' }))).toBe('ignore');
  });
});

describe('decideForEvent (HIVE-124)', () => {
  it('wakes a sleeping agent', () => {
    expect(decideForEvent('sleeping')).toBe('wake');
  });

  it('queues for a working one, so a burst becomes one wake', () => {
    expect(decideForEvent('working')).toBe('queue');
  });

  it('holds for a paused one, and resume delivers', () => {
    expect(decideForEvent('paused')).toBe('hold');
  });

  it('wakes an asking agent, which is not running', () => {
    expect(decideForEvent('asking')).toBe('wake');
  });
});

describe('laneFor (HIVE-186)', () => {
  const at = (over: Partial<LedgerEntry>): LedgerEntry => ({
    id: 'x', ts: 0, from: 'overmind', to: 'builder', kind: 'ask', body: 'b', ...over,
  });
  const started = (run: string, lane?: string): LedgerEntry =>
    at({ id: `s-${run}`, from: 'builder', to: undefined, kind: 'event', body: 'run.started — ledger',
         meta: { run, trigger: 'ledger', kind: 'standing', ...(lane === undefined ? {} : { lane }) } });

  // thread lanes
  it('opens a thread lane for a new ask', () => {
    expect(laneFor('thread', at({ id: 'A' }), [at({ id: 'A' })])).toEqual({ lane: 'thread:A' });
  });

  it('routes the answer to a lane\'s own question back into that lane', () => {
    const answer = at({ id: 'ans', from: 'overmind', to: 'builder', kind: 'answer', thread: 'Q' });
    const log = [
      at({ id: 'A' }),
      started('r1', 'thread:A'),
      at({ id: 'Q', from: 'builder', to: 'overmind', meta: { run: 'r1' } }),
      answer,
    ];
    expect(laneFor('thread', answer, log)).toEqual({ lane: 'thread:A' });
  });

  it('routes the answer to a sibling lane\'s question into the sibling', () => {
    const answer = at({ id: 'ans', from: 'overmind', to: 'builder', kind: 'answer', thread: 'QB' });
    const log = [
      at({ id: 'A' }), at({ id: 'B' }),
      started('r1', 'thread:A'), started('r2', 'thread:B'),
      at({ id: 'QB', from: 'builder', to: 'overmind', meta: { run: 'r2' } }),
      answer,
    ];
    expect(laneFor('thread', answer, log)).toEqual({ lane: 'thread:B' });
  });

  it('routes a follow-up in the thread of the ask that opened a lane into that lane', () => {
    const post = at({ id: 'p', kind: 'post', thread: 'A' });
    const log = [at({ id: 'A' }), post];
    expect(laneFor('thread', post, log)).toEqual({ lane: 'thread:A' });
  });

  it('routes into standing once the lane\'s opening ask has closed, but not for the closing entry itself', () => {
    const closing = at({ id: 'done', kind: 'done', thread: 'A' });
    const after = at({ id: 'late', kind: 'post', thread: 'A' });
    const log = [at({ id: 'A' }), closing, after];
    expect(laneFor('thread', closing, log)).toEqual({ lane: 'thread:A' });
    expect(laneFor('thread', after, log)).toEqual({ lane: 'standing' });
  });

  it('routes into standing once the lane\'s opening ask has expired (spec §1)', () => {
    const expired = at({ id: 'e', from: 'overmind', to: 'overmind', kind: 'event', thread: 'A', body: 'ask A expired', meta: { expired: 'A' } });
    const forged = at({ id: 'f', from: 'sess-1', to: 'builder', kind: 'event', thread: 'A', body: 'x', meta: { expired: 'A' } });
    const late = at({ id: 'late', kind: 'post', thread: 'A' });
    expect(laneFor('thread', late, [at({ id: 'A' }), forged, late])).toEqual({ lane: 'thread:A' });
    expect(laneFor('thread', late, [at({ id: 'A' }), expired, late])).toEqual({ lane: 'standing' });
  });

  // repo lanes
  it('shares one lane between two asks for the same repo, and not across repos', () => {
    const a = at({ id: 'A', meta: { repo: 'a/x' } });
    const b = at({ id: 'B', meta: { repo: 'a/x' } });
    const c = at({ id: 'C', meta: { repo: 'b/y' } });
    const log = [a, b, c];
    expect(laneFor('repo', a, log)).toEqual({ lane: 'repo:a/x' });
    expect(laneFor('repo', b, log)).toEqual({ lane: 'repo:a/x' });
    expect(laneFor('repo', c, log)).toEqual({ lane: 'repo:b/y' });
  });

  it.each([undefined, '', '/abs/path', 'no-slash', 7])('refuses an ask with meta.repo %j, with a reason', (repo) => {
    const ask = at({ id: 'A', meta: repo === undefined ? {} : { repo } });
    expect(laneFor('repo', ask, [ask])).toEqual({
      refuse: 'builder lanes by repository; send meta.repo as owner/name.',
    });
  });

  // everything else
  it('sends broadcasts, laneless entries and every entry of a pre-lane agent to standing', () => {
    const ask = at({ id: 'A' });
    expect(laneFor('thread', at({ id: 'bc', to: undefined, kind: 'post' }), [])).toEqual({ lane: 'standing' });
    expect(laneFor('thread', at({ id: 'p', kind: 'post' }), [])).toEqual({ lane: 'standing' });
    expect(laneFor(undefined, ask, [ask])).toEqual({ lane: 'standing' });
  });

  it('reads a run with no run.started, or no meta.lane, as standing', () => {
    expect(laneOfRun('builder', 'r9', [])).toBe('standing');
    expect(laneOfRun('builder', 'r1', [started('r1')])).toBe('standing');
    expect(laneOfRun('builder', undefined, [])).toBe('standing');
  });

  it('only trusts the agent\'s own run.started — first one wins', () => {
    const forged = { ...started('r1', 'thread:Z'), id: 'f', from: 'other' };
    expect(laneOfRun('builder', 'r1', [forged, started('r1', 'thread:A')])).toBe('thread:A');
  });
});

describe('decide on a self-addressed entry (HIVE-186)', () => {
  const self: LedgerEntry = { id: 's', ts: 0, from: 'shipper', to: 'shipper', kind: 'ask', body: 'hand over' };

  it('ignores it on the lane that wrote it, as before', () => {
    expect(decide('sleeping', self)).toBe('ignore');
    expect(decide('sleeping', self, { sameLane: true })).toBe('ignore');
  });

  it('wakes a different lane with it', () => {
    expect(decide('sleeping', self, { sameLane: false })).toBe('wake');
    expect(decide('working', self, { sameLane: false })).toBe('queue');
  });
});

describe('laneClaims (HIVE-186)', () => {
  const e = (over: Partial<LedgerEntry>): LedgerEntry => ({ id: 'x', ts: 0, from: 'shipper', kind: 'claim', body: 'b', ...over });
  const begun = (run: string, lane: string) =>
    e({ id: `s-${run}`, kind: 'event', body: 'run.started — ledger', meta: { run, lane } });

  it('is the lanes of the agent\'s open claims, by the run that claimed', () => {
    const log = [
      begun('r1', 'repo:a/x'), begun('r2', 'repo:b/y'),
      e({ id: 'c1', meta: { task: 'a/x#1', run: 'r1' } }),
      e({ id: 'c2', meta: { task: 'b/y#2', run: 'r2' } }),
      e({ id: 'r', kind: 'release', meta: { task: 'b/y#2', run: 'r2' } }),
      e({ id: 'c3', from: 'builder', meta: { task: 'z#9', run: 'r1' } }),
    ];
    expect(laneClaims('shipper', log)).toEqual(new Set(['repo:a/x']));
  });
});
