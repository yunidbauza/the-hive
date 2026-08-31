import { describe, expect, it, vi } from 'vitest';

import { OVERMIND, type LedgerEntry } from '@shared/ledger-contract';

import { createLedgerNotifier } from '../../../../electron/main/ledger/notify';

const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
  id: '20260830-101500-0001',
  ts: 1_756_500_000_000,
  from: 'drone',
  kind: 'post',
  body: '',
  ...over,
});

const harness = () => {
  const raise = vi.fn();
  const markRead = vi.fn();
  const dismiss = vi.fn();
  const onEntry = createLedgerNotifier({
    raise,
    markRead,
    dismiss,
    isAgent: (id: string) => id !== OVERMIND && !id.startsWith('sess-'),
  });
  return { raise, markRead, dismiss, onEntry };
};

describe('createLedgerNotifier', () => {
  it('raises agent.ask for an ask addressed to the overmind, keyed by the entry id', () => {
    const { raise, onEntry } = harness();
    onEntry(
      entry({
        to: OVERMIND,
        kind: 'ask',
        body: 'ship it?\nTests are green.',
        meta: { options: ['yes', 'no'] },
      }),
    );
    expect(raise).toHaveBeenCalledWith({
      kind: 'agent.ask',
      id: '20260830-101500-0001',
      title: 'ship it?',
      body: 'Tests are green.',
      action: { type: 'ask', thread: '20260830-101500-0001' },
      createdAt: 1_756_500_000_000,
    });
  });

  it('titles a quoted ask Send this reply?', () => {
    const { raise, onEntry } = harness();
    onEntry(
      entry({ to: OVERMIND, kind: 'ask', body: 'ok?', meta: { quote: 'hello' } }),
    );
    expect(raise.mock.calls[0][0].title).toBe('Send this reply?');
  });

  it('raises agent.permission when meta.kind says so', () => {
    const { raise, onEntry } = harness();
    onEntry(
      entry({
        to: OVERMIND,
        kind: 'ask',
        body: 'Allow Bash?',
        meta: { kind: 'permission', tool: 'Bash' },
      }),
    );
    expect(raise.mock.calls[0][0]).toMatchObject({
      kind: 'agent.permission',
      title: 'Allow Bash?',
    });
  });

  it('ignores an ask addressed to somebody else', () => {
    const { raise, onEntry } = harness();
    onEntry(entry({ to: 'sess-01', kind: 'ask', body: 'ping' }));
    expect(raise).not.toHaveBeenCalled();
  });

  it('marks the ask read when its answer lands', () => {
    const { markRead, onEntry } = harness();
    onEntry(entry({ id: 'x2', kind: 'answer', thread: 'a41', body: 'yes' }));
    expect(markRead).toHaveBeenCalledWith('a41');
  });

  it('dismisses the answered card when the asker reports done', () => {
    const { dismiss, raise, onEntry } = harness();
    onEntry(entry({ id: 'x3', kind: 'done', thread: 'a41', body: 'Sent.' }));
    expect(dismiss).toHaveBeenCalledWith('a41');
    expect(raise.mock.calls[0][0]).toMatchObject({
      kind: 'agent.done',
      title: 'Sent.',
      action: { type: 'agent', name: 'drone' },
    });
  });

  it('mints nothing for a session done — only the ask card goes', () => {
    const { dismiss, raise, onEntry } = harness();
    onEntry(entry({ from: 'sess-01', kind: 'done', thread: 'a41', body: 'ok' }));
    expect(dismiss).toHaveBeenCalledWith('a41');
    expect(raise).not.toHaveBeenCalled();
  });

  it('raises agent.failed for an agent failed', () => {
    const { raise, onEntry } = harness();
    onEntry(entry({ kind: 'failed', body: 'Could not reach the API.' }));
    expect(raise.mock.calls[0][0]).toMatchObject({
      kind: 'agent.failed',
      title: 'Could not reach the API.',
    });
  });

  it.each([
    ['turns', 'Ran out of turns'],
    ['budget', 'Hit its budget'],
    ['failed', 'Run failed'],
  ])('raises agent.failed for a run that ended %s', (outcome, title) => {
    const { raise, onEntry } = harness();
    onEntry(
      entry({
        kind: 'event',
        body: `run.ended — ${outcome}`,
        meta: { run: 'r-1', outcome, reason: 'stalled' },
      }),
    );
    expect(raise.mock.calls[0][0]).toMatchObject({ kind: 'agent.failed', title });
  });

  it('shows the reason verbatim for a plain failure and nothing else', () => {
    const { raise, onEntry } = harness();
    onEntry(
      entry({
        kind: 'event',
        body: 'run.ended — failed',
        meta: { run: 'r-1', outcome: 'failed', reason: 'stalled' },
      }),
    );
    expect(raise.mock.calls[0][0].body).toBe('stalled');
  });

  it('does not mint a second card when the agent already said it failed', () => {
    const { raise, onEntry } = harness();
    onEntry(entry({ kind: 'failed', body: 'gave up', meta: { run: 'r-1' } }));
    onEntry(
      entry({
        kind: 'event',
        body: 'run.ended — failed',
        meta: { run: 'r-1', outcome: 'failed' },
      }),
    );
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it.each(['done', 'asking'])('mints nothing for a run that ended %s', (outcome) => {
    const { raise, onEntry } = harness();
    onEntry(
      entry({
        kind: 'event',
        body: `run.ended — ${outcome}`,
        meta: { run: 'r-2', outcome },
      }),
    );
    expect(raise).not.toHaveBeenCalled();
  });
});
