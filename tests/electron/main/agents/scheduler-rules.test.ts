// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { decide } from '../../../../electron/main/agents/scheduler-rules';
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
