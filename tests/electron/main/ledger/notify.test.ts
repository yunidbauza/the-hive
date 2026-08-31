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
      subject: 'drone',
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

  /**
   * HIVE-118 self-review, finding 7. `meta.quote === undefined` and the card's
   * own `text()` helper disagreed about two values `mcp-host/tools.ts` can
   * actually produce: it admits `quote: ''` outright, and any non-string
   * reaches `meta` through the passthrough. One ask then had two
   * presentations — this notification titled "Send this reply?" with the whole
   * body under it, and a card next to it drawing the ordinary title and no
   * quote block at all.
   */
  it.each([
    ['an empty string', ''],
    ['a non-string', 42],
  ])('treats %s quote as no quote, exactly as the card does', (_label, quote) => {
    const { raise, onEntry } = harness();
    onEntry(
      entry({ to: OVERMIND, kind: 'ask', body: 'ok?\nwhy not', meta: { quote } }),
    );
    expect(raise.mock.calls[0][0]).toMatchObject({ title: 'ok?', body: 'why not' });
  });

  /**
   * HIVE-118 self-review, finding 10: without a subject every ask toasted
   * under its bare title, so three agents asking at once gave three toasts
   * reading "Send this reply?" with nothing to tell them apart.
   *
   * The **party**, not a name pasted in — `hub.ts` resolves it at presentation
   * time, which is the only way a session that titles itself after the row was
   * raised ever toasts under the name the user can see.
   */
  it('carries the asker as the subject, for both a session and an agent', () => {
    const { raise, onEntry } = harness();
    onEntry(entry({ from: 'sess-01', to: OVERMIND, kind: 'ask', body: 'ok?' }));
    onEntry(entry({ id: 'x9', from: 'drone', to: OVERMIND, kind: 'ask', body: 'ok?' }));

    expect(raise.mock.calls[0][0].subject).toBe('sess-01');
    expect(raise.mock.calls[1][0].subject).toBe('drone');
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

  /**
   * HIVE-118 self-review, finding 6. A `failed` naming a thread used not to
   * dismiss, so the user kept a live, button-bearing card for a question the
   * asker had already abandoned — and since `openAsks` now closes the thread,
   * every one of those buttons would have been refused by `Ledger.append`.
   *
   * Symmetric with `done` in both directions: the card goes whoever sent the
   * `failed`, and only an agent's is also news.
   */
  it('dismisses the card when the asker abandons the ask', () => {
    const { dismiss, raise, onEntry } = harness();
    onEntry(entry({ id: 'x4', kind: 'failed', thread: 'a41', body: 'Gave up.' }));
    expect(dismiss).toHaveBeenCalledWith('a41');
    expect(raise.mock.calls[0][0]).toMatchObject({
      kind: 'agent.failed',
      title: 'Gave up.',
      action: { type: 'agent', name: 'drone' },
    });
  });

  it('dismisses the card for a session failed too, and mints nothing', () => {
    const { dismiss, raise, onEntry } = harness();
    onEntry(
      entry({ id: 'x5', from: 'sess-01', kind: 'failed', thread: 'a41', body: 'no' }),
    );
    expect(dismiss).toHaveBeenCalledWith('a41');
    expect(raise).not.toHaveBeenCalled();
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

  /**
   * Whole-branch review, finding 2. The shape production actually emits: an
   * agent's own `ledger_failed` carries no `meta.run` at all — nothing in
   * `mcp-host/tools.ts` stamps one — so the dedup this proves has to key off
   * the party (`entry.from`), not a run id that never arrives.
   */
  it('does not mint a second card when the agent already said it failed', () => {
    const { raise, onEntry } = harness();
    onEntry(entry({ from: 'drone', kind: 'failed', body: 'gave up' }));
    onEntry(
      entry({
        from: 'drone',
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

  /**
   * The stale-flag case the whole-branch review named directly: a `failed`
   * report must be consumed by the very next `event` from that party, no
   * matter how that run ended, or a later run's genuine failure would find
   * the flag already set and be silently swallowed.
   */
  it('clears the flag on a run that ended done, so the next run can still fail loudly', () => {
    const { raise, onEntry } = harness();
    onEntry(entry({ from: 'drone', kind: 'failed', body: 'gave up' }));
    onEntry(
      entry({
        from: 'drone',
        kind: 'event',
        body: 'run.ended — done',
        meta: { run: 'r-1', outcome: 'done' },
      }),
    );
    raise.mockClear();

    onEntry(
      entry({
        from: 'drone',
        kind: 'event',
        body: 'run.ended — failed',
        meta: { run: 'r-2', outcome: 'failed' },
      }),
    );

    expect(raise).toHaveBeenCalledTimes(1);
  });

  /** Two different agents' own failures must not shadow one another. */
  it('does not let one agent’s report suppress another agent’s receipt', () => {
    const { raise, onEntry } = harness();
    onEntry(entry({ from: 'drone', kind: 'failed', body: 'gave up' }));
    onEntry(
      entry({
        from: 'other-drone',
        kind: 'event',
        body: 'run.ended — failed',
        meta: { run: 'r-9', outcome: 'failed' },
      }),
    );

    expect(raise).toHaveBeenCalledTimes(2);
  });
});
