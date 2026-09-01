import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { AgentLedger } from '@features/agents/components/agent-ledger';
import { LEDGER_MEMORY_CAP, type LedgerEntry } from '@shared/ledger-contract';
import { useHiveStore } from '@stores/hive-store';

/**
 * One agent's side of the log.
 *
 * The mirror file CLAUDE.md requires, and it exists to hold the two bounds that
 * `agent-view.test.tsx` cannot reach with a handful of fixture entries: the
 * render cap, and the counter that reports what the cap held back. A regression
 * to `slice(THREAD_SHOWN)` — the oldest hundred instead of the newest — renders
 * a full column with a plausible count and passes every other test in the tree.
 */
const entry = (index: number, over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  /*
    Ids are fixed-width and sort as strings in write order, which is the
    property `hydrateLedger` sorts on. Padding the counter is what keeps
    `entry 9` before `entry 10` there, and an unpadded fixture would arrive in
    an order no production entry ever takes.
  */
  id: `20260901-120000-${String(index).padStart(4, '0')}`,
  ts: Date.UTC(2026, 8, 1, 12, 0, index),
  from: 'watcher',
  to: 'overmind',
  kind: 'event',
  body: `entry ${String(index)}`,
  ...over,
});

const hydrate = (entries: LedgerEntry[]): void => {
  useHiveStore.getState().hydrateLedger(entries);
};

const column = (): HTMLElement =>
  screen.getByText('Ledger').parentElement as HTMLElement;

describe('AgentLedger', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
  });

  it('says so plainly when the thread is empty', () => {
    render(<AgentLedger name="watcher" />);

    expect(screen.getByText('Nothing on the record yet.')).toBeInTheDocument();
  });

  /*
    A union of both directions, and deliberately not `matches()`: that function
    ands its fields, so `{ from, to }` would mean "from this agent AND addressed
    to it", which is nothing.
  */
  it('shows both sides of the correspondence and nobody else’s', () => {
    hydrate([
      entry(1, { from: 'watcher', to: 'overmind', body: 'I swept 4 mentions.' }),
      entry(2, { from: 'overmind', to: 'watcher', body: 'Sweep again at noon.' }),
      entry(3, { from: 'sess-01', to: 'overmind', body: 'Somebody else.' }),
    ]);

    render(<AgentLedger name="watcher" />);

    expect(within(column()).getByText('I swept 4 mentions.')).toBeInTheDocument();
    expect(within(column()).getByText('Sweep again at noon.')).toBeInTheDocument();
    expect(within(column()).queryByText('Somebody else.')).not.toBeInTheDocument();
  });

  describe('the render cap', () => {
    /*
      The bound `agent-view.test.tsx` cannot reach — it seeds a handful of
      entries, so neither the slice nor the counter is exercised there.
    */
    it('draws the newest hundred, not the oldest', () => {
      hydrate(Array.from({ length: 130 }, (_, index) => entry(index)));

      render(<AgentLedger name="watcher" />);

      const bodies = within(column())
        .getAllByText(/^entry /)
        .map((node) => node.textContent);

      expect(bodies).toHaveLength(100);
      // Newest first, and the newest is the newest that exists.
      expect(bodies[0]).toBe('entry 129');
      expect(bodies[99]).toBe('entry 30');
    });

    it('counts what it held back rather than just stopping', () => {
      hydrate(Array.from({ length: 130 }, (_, index) => entry(index)));

      render(<AgentLedger name="watcher" />);

      expect(
        within(column()).getByText('+30 older in this view'),
      ).toBeInTheDocument();
    });

    it('draws no counter when everything fits', () => {
      hydrate(Array.from({ length: 12 }, (_, index) => entry(index)));

      render(<AgentLedger name="watcher" />);

      expect(within(column()).queryByText(/older in this view/)).toBeNull();
    });

    /**
     * "in this view", and this is the test that pins the wording.
     *
     * `entries` is the renderer's mirror, capped at `LEDGER_MEMORY_CAP`, so the
     * counter can never exceed `cap - THREAD_SHOWN` however long the thread on
     * disk actually is. It said "on the record" first, which named the JSONL
     * file — a number that is wrong by construction about the thing it names.
     */
    it('never claims to count more than the store is holding', () => {
      hydrate(
        Array.from({ length: LEDGER_MEMORY_CAP + 400 }, (_, index) =>
          entry(index),
        ),
      );

      render(<AgentLedger name="watcher" />);

      expect(
        within(column()).getByText(`+${String(LEDGER_MEMORY_CAP - 100)} older in this view`),
      ).toBeInTheDocument();
      expect(within(column()).queryByText(/on the record/)).toBeNull();
    });
  });

  /*
    `reverse` mutates. The array it is called on is `useAgentThread`'s memoized
    value, so reversing in place would flip this component's own order on every
    re-render with no state change to explain it.
  */
  it('leaves the selector’s array in write order', () => {
    hydrate([entry(1), entry(2), entry(3)]);

    render(<AgentLedger name="watcher" />);

    const stored = useHiveStore
      .getState()
      .ledger.map((held) => held.body);

    expect(stored).toEqual(['entry 1', 'entry 2', 'entry 3']);
  });

  /*
    All nine kinds get a chip. `failed` and `handoff` both land in an agent's
    thread, and a kind with no chip renders as an unlabelled paragraph.
  */
  it('labels every kind it can be handed', () => {
    hydrate([
      entry(1, { kind: 'ask', ref: 'a71', body: 'Retry the deploy?' }),
      entry(2, { kind: 'handoff', body: 'Rotating.' }),
      entry(3, { kind: 'failed', body: 'The wake could not start.' }),
    ]);

    render(<AgentLedger name="watcher" />);

    expect(within(column()).getByText('ask a71')).toBeInTheDocument();
    expect(within(column()).getByText('handoff')).toBeInTheDocument();
    expect(within(column()).getByText('failed')).toBeInTheDocument();
  });
});
