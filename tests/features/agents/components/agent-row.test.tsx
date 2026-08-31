import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { AgentRow } from '@features/agents/components/agent-row';
import type { AgentSummary } from '@shared/agent-contract';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

/**
 * The row's right-hand meta (HIVE-116).
 *
 * Its whole job is to answer "should I look at this one?" without opening it,
 * which is why every assertion here is about a *word* being on screen rather
 * than a colour: the status may never be carried by the dot alone.
 */
const summary = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  name: 'watcher',
  description: 'Watches #incorp-dev and my mentions.',
  icon: 'ph-robot',
  status: 'sleeping',
  wake: { on: [] },
  rotateAfter: 50,
  runs: [],
  ...over,
});

const hydrate = (over: Partial<AgentSummary> = {}) => {
  useHiveStore.getState().hydrateAgents([summary(over)]);
};

describe('AgentRow', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
  });

  it('renders nothing for an id that is not an agent', () => {
    const { container } = render(<AgentRow id="nobody" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('names the status on screen, so it is never colour-only', () => {
    hydrate({ status: 'sleeping' });

    render(<AgentRow id="watcher" />);

    expect(screen.getByText('sleeping')).toBeInTheDocument();
  });

  it.each([
    ['asking', 'asking'],
    ['working', 'working'],
    ['paused', 'paused'],
    ['failed', 'failed'],
  ] as const)('says %s in words', (status, word) => {
    hydrate({ status });

    render(<AgentRow id="watcher" />);

    expect(screen.getByText(new RegExp(word))).toBeInTheDocument();
  });

  it('puts the open ask’s ref beside the word, so it can be answered by name', () => {
    hydrate({ status: 'asking' });
    useHiveStore.getState().hydrateLedger([
      {
        id: '20260830-140000-0001',
        ts: Date.now(),
        from: 'watcher',
        to: 'overmind',
        kind: 'ask',
        ref: 'a71',
        body: 'Retry the deploy?',
      },
    ]);

    render(<AgentRow id="watcher" />);

    expect(screen.getByText(/asking a71/)).toBeInTheDocument();
  });

  /**
   * `entity.cost` is the *last finished* run's spend — `pushAgentStatus` reads
   * `runs[last]`, and a run only joins `runs` when it finalizes. Drawing it
   * beside a running agent presents the previous run's money as this one's,
   * and nothing on the wire carries an in-flight cost.
   */
  it('does not show a cost while working — it would be the previous run’s', () => {
    hydrate({ status: 'working', cost: '$0.08' });

    render(<AgentRow id="watcher" />);

    expect(screen.queryByText(/\$0\.08/)).not.toBeInTheDocument();
  });

  it('shows the last run’s cost on a resting row, where it is unambiguous', () => {
    hydrate({ status: 'sleeping', cost: '$0.08' });

    render(<AgentRow id="watcher" />);

    expect(screen.getByText(/next manual · \$0\.08/)).toBeInTheDocument();
  });

  it('shows when a sleeping agent wakes next', () => {
    hydrate({ status: 'sleeping', nextRunAt: new Date().setHours(8, 30, 0, 0) });

    render(<AgentRow id="watcher" />);

    expect(screen.getByText(/next /)).toBeInTheDocument();
  });

  /*
    The rail is where "why has this done nothing all day?" gets asked, so it is
    where the answer belongs (HIVE-121) — between the next wake and the cost,
    and in the meta's own subtle colour rather than amber, because the count
    reports the scheduler working exactly as asked.
  */
  it('names skipped ticks between the next wake and the cost', () => {
    hydrate({ status: 'sleeping', skipsSinceRun: 3, cost: '$0.03' });

    render(<AgentRow id="watcher" />);

    expect(screen.getByText('next manual · skipped 3 · $0.03')).toBeInTheDocument();
  });

  it('leaves the meta as it was when nothing has been skipped', () => {
    hydrate({ status: 'sleeping', skipsSinceRun: 0, cost: '$0.03' });

    render(<AgentRow id="watcher" />);

    expect(screen.queryByText(/skipped/)).not.toBeInTheDocument();
  });

  it('reads manual for a sleeping agent nothing schedules', () => {
    hydrate({ status: 'sleeping' });

    render(<AgentRow id="watcher" />);

    expect(screen.getByText('next manual')).toBeInTheDocument();
  });

  it('renders the reason instead of the description when the file will not parse', () => {
    hydrate({ invalid: 'name: Required.', description: '' });

    render(<AgentRow id="watcher" />);

    expect(screen.getByText('name: Required.')).toBeInTheDocument();
    expect(screen.getByText('invalid')).toBeInTheDocument();
  });

  it('never claims a broken definition is waiting on an ask', () => {
    // `invalid` wins over every other state: the row's job is to say the file
    // cannot be read, and an ask ref beside it would suggest it is running.
    hydrate({ status: 'asking', invalid: 'model: Unknown.' });
    useHiveStore.getState().hydrateLedger([
      {
        id: '20260830-140000-0001',
        ts: Date.now(),
        from: 'watcher',
        to: 'overmind',
        kind: 'ask',
        ref: 'a71',
        body: 'Retry?',
      },
    ]);

    render(<AgentRow id="watcher" />);

    expect(screen.queryByText(/a71/)).not.toBeInTheDocument();
  });

  it('marks the row it is looking at', () => {
    hydrate();
    useUiStore.getState().openTab('watcher');

    render(<AgentRow id="watcher" />);

    expect(screen.getByRole('button')).toHaveAttribute('aria-current', 'true');
  });
});
