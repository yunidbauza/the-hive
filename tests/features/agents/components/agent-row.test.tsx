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
  mcp: [],
  tools: [],
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

  it('counts the runs beside the word when more than one is live (HIVE-128)', () => {
    hydrate({
      status: 'working',
      live: [
        { run: 'a', kind: 'standing', trigger: 'interval', startedAt: 1 },
        { run: 'b', kind: 'task', trigger: 'manual', startedAt: 2 },
        { run: 'c', kind: 'task', trigger: 'manual', startedAt: 3 },
      ],
    });

    render(<AgentRow id="watcher" />);

    expect(screen.getByText('working ·3')).toBeInTheDocument();
  });

  it('says only the word for a single live run', () => {
    hydrate({ status: 'working', live: [{ run: 'a', kind: 'standing', trigger: 'interval', startedAt: 1 }] });

    render(<AgentRow id="watcher" />);

    expect(screen.getByText('working')).toBeInTheDocument();
  });

  /**
   * The meta is `shrink-0`, so every character it holds is taken out of the
   * name and description beside it — and the name is the only thing in the row
   * that identifies the agent. `next 04:46 PM · $0.04` truncated `ultralisk`
   * to `ultrali…`, which is a poor trade for a number the view's Today tile
   * already carries.
   */
  it('never shows a cost, whatever the agent is doing', () => {
    for (const status of ['working', 'sleeping'] as const) {
      hydrate({ status, cost: '$0.08' });

      const { unmount } = render(<AgentRow id="watcher" />);

      expect(screen.queryByText(/\$0\.08/)).not.toBeInTheDocument();

      unmount();
    }
  });

  it('shows when a sleeping agent wakes next', () => {
    hydrate({ status: 'sleeping', nextRunAt: new Date().setHours(8, 30, 0, 0) });

    render(<AgentRow id="watcher" />);

    expect(screen.getByText(/next /)).toBeInTheDocument();
  });

  /*
    The rail is where "why has this done nothing all day?" gets asked, so it is
    where the answer belongs (HIVE-121) — after the next wake, and in the meta's
    own subtle colour rather than amber, because the count reports the scheduler
    working exactly as asked.
  */
  it('names skipped ticks after the next wake, and ends there', () => {
    hydrate({ status: 'sleeping', skipsSinceRun: 3, cost: '$0.03' });

    render(<AgentRow id="watcher" />);

    expect(screen.getByText('next manual · skipped 3')).toBeInTheDocument();
  });

  it('leaves the meta as it was when nothing has been skipped', () => {
    hydrate({ status: 'sleeping', skipsSinceRun: 0, cost: '$0.03' });

    render(<AgentRow id="watcher" />);

    expect(screen.queryByText(/skipped/)).not.toBeInTheDocument();
  });

  /*
    HIVE-123: a scheduled skip caused by a signed-out Slack is otherwise
    indistinguishable from an `onchange` no-op skip — the row only ever shows
    a generic `skipped N`. The chip's tooltip names the reason, read straight
    off the last run's own `RunSummary.slack` rather than a second field, and
    it sits *alongside* the count rather than replacing it.
  */
  it('names slack in the chip tooltip when the last run found it signed out', () => {
    hydrate({
      status: 'sleeping',
      mcp: ['slack'],
      skipsSinceRun: 2,
      runs: [
        {
          run: 'r1',
          trigger: 'interval',
          startedAt: 0,
          endedAt: 1,
          outcome: 'done',
          slack: 'needs-auth',
        },
      ],
    });

    render(<AgentRow id="watcher" />);

    expect(screen.getByTitle('slack: not signed in')).toBeInTheDocument();
    expect(screen.getByText(/skipped 2/)).toBeInTheDocument();
  });

  it('shows no slack tooltip once the last run found it connected', () => {
    hydrate({
      status: 'sleeping',
      mcp: ['slack'],
      runs: [
        {
          run: 'r1',
          trigger: 'interval',
          startedAt: 0,
          endedAt: 1,
          outcome: 'done',
          slack: 'connected',
        },
      ],
    });

    render(<AgentRow id="watcher" />);

    expect(screen.queryByTitle('slack: not signed in')).not.toBeInTheDocument();
  });

  it('shows no slack tooltip for an agent that has never run', () => {
    hydrate({ status: 'sleeping', mcp: ['slack'], skipsSinceRun: 1 });

    render(<AgentRow id="watcher" />);

    expect(screen.queryByTitle('slack: not signed in')).not.toBeInTheDocument();
  });

  /*
    The re-review's finding: `AgentRunState.runs` is never cleared or
    invalidated when a definition is saved (`saveAgent`/`renameAgent`/
    `deleteAgent` in `state.ts` all leave run history untouched). An agent
    that removed `slack` from its `mcp:` after a `needs-auth` run must not
    keep the tooltip — the gate is the agent's *current* definition, not an
    inference from history alone.
  */
  it('shows no slack tooltip once the definition no longer names slack, even with a stale needs-auth run', () => {
    hydrate({
      status: 'sleeping',
      mcp: [],
      skipsSinceRun: 2,
      runs: [
        {
          run: 'r1',
          trigger: 'interval',
          startedAt: 0,
          endedAt: 1,
          outcome: 'done',
          slack: 'needs-auth',
        },
      ],
    });

    render(<AgentRow id="watcher" />);

    expect(screen.queryByTitle('slack: not signed in')).not.toBeInTheDocument();
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
