import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRow } from '@features/agents/components/agent-row';
import type { AgentSummary } from '@shared/agent-contract';
import type { LedgerEntry } from '@shared/ledger-contract';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

const NOW = 1_790_000_000_000;

/**
 * The row (HIVE-204): a hexagon tile, the name with its age, and the agent's
 * last word on the ledger. The state is said in words in the accessible name,
 * so the tile's colour is never the only carrier.
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

const said = (over: Partial<LedgerEntry>) => {
  useHiveStore.getState().hydrateLedger([
    {
      id: '20261002-140000-0001',
      ts: NOW - 2 * 60_000,
      from: 'watcher',
      kind: 'post',
      body: '',
      ...over,
    },
  ]);
};

const live = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    run: `r${String(index)}`,
    kind: 'standing' as const,
    trigger: 'interval',
    startedAt: 1,
  }));

const tile = () => document.querySelector('[aria-hidden="true"]') as HTMLElement;

describe('AgentRow', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('centres the tile against one line or two, and levels the actions with the name', () => {
    hydrate();
    const { unmount } = render(<AgentRow id="watcher" />);
    const row = () => screen.getByRole('button', { name: /^watcher, / });
    const actions = () => screen.getByRole('button', { name: 'Pause watcher' }).parentElement!;
    // One line: the actions sit in the middle of the row, beside the name.
    expect(row()).toHaveClass('items-center');
    expect(actions()).toHaveClass('top-1/2');
    unmount();

    said({ kind: 'event', body: 'run.ended — done' });
    render(<AgentRow id="watcher" />);
    // Two lines: the tile still centres, and the actions keep to the first line.
    expect(row()).toHaveClass('items-center');
    expect(actions()).toHaveClass('top-2');
  });

  it('sets the name semibold, as the Projects list sets a project (HIVE-229)', () => {
    hydrate();
    render(<AgentRow id="watcher" />);

    expect(screen.getByText('watcher', { selector: 'b' })).toHaveClass('font-semibold');
  });

  it('renders nothing for an id that is not an agent', () => {
    const { container } = render(<AgentRow id="nobody" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('names an asking agent’s ask by its ref, in amber', () => {
    hydrate({ status: 'asking' });
    said({ kind: 'ask', ref: 'a3', body: 'Retry the deploy?\nIt failed twice.' });

    render(<AgentRow id="watcher" />);

    expect(screen.getByText('ask a3')).toHaveClass('text-amber-text');
    expect(screen.getByText('Retry the deploy?')).toBeInTheDocument();
    expect(screen.queryByText(/failed twice/)).not.toBeInTheDocument();
    expect(tile()).toHaveClass('text-amber-text');
  });

  it.each([
    ['failed', 'text-red'],
    ['working', 'text-green'],
    ['sleeping', 'text-subtle'],
    ['paused', 'text-subtle'],
  ] as const)('draws a %s agent’s tile in %s', (status, colour) => {
    hydrate({ status });

    render(<AgentRow id="watcher" />);

    expect(tile()).toHaveClass(colour);
  });

  it.each([
    ['failed', 'text-red'],
    ['event', 'text-brand'],
    ['post', 'text-subtle'],
    ['done', 'text-green'],
  ] as const)('colours a %s keyword %s', (kind, colour) => {
    hydrate();
    said({ kind, body: 'something happened' });

    render(<AgentRow id="watcher" />);

    expect(screen.getByText(kind)).toHaveClass(colour);
  });

  it('shows the age of its last word in the slot', () => {
    hydrate();
    said({ kind: 'done', body: 'Shipped' });

    render(<AgentRow id="watcher" />);

    expect(screen.getByText('2m')).toHaveClass('w-[44px]');
  });

  it('renders the reason, in amber, when the file will not parse', () => {
    hydrate({ status: 'asking', invalid: 'name: Required.', description: '' });
    said({ kind: 'ask', ref: 'a71', body: 'Retry?' });

    render(<AgentRow id="watcher" />);

    expect(screen.getByText('invalid')).toHaveClass('text-amber-text');
    expect(screen.getByText('name: Required.')).toBeInTheDocument();
    // `invalid` wins: an ask ref beside it would suggest it is running.
    expect(screen.queryByText(/a71/)).not.toBeInTheDocument();
    expect(tile()).toHaveClass('text-amber-text');
  });

  it('says paused for a paused agent that has never written', () => {
    hydrate({ status: 'paused' });

    render(<AgentRow id="watcher" />);

    expect(screen.getByText('paused')).toHaveClass('text-amber-text');
    expect(screen.getByRole('button', { name: /^watcher, paused/ })).toBeInTheDocument();
  });

  it('says paused for a paused agent that has written, beside its last word', () => {
    hydrate({ status: 'paused' });
    said({ kind: 'done', body: 'Shipped #303' });

    render(<AgentRow id="watcher" />);

    expect(screen.getByText('paused')).toHaveClass('text-amber-text');
    expect(screen.getByText('Shipped #303')).toBeInTheDocument();
    expect(screen.queryByText('done')).not.toBeInTheDocument();
  });

  it('says the state, the live runs and the last word in its accessible name', () => {
    useHiveStore
      .getState()
      .hydrateAgents([summary({ name: 'shipper', status: 'working', live: live(2) })]);
    said({ from: 'shipper', kind: 'event', body: '#303 CI green, handing to acr' });

    render(<AgentRow id="shipper" />);

    expect(
      screen.getByRole('button', {
        name: 'shipper, working, 2 runs live. Last: event, #303 CI green, handing to acr, 2m',
      }),
    ).toBeInTheDocument();
    expect(tile().querySelector('b')).toHaveTextContent('2');
  });

  it('opens the agent when clicked', async () => {
    hydrate();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<AgentRow id="watcher" />);
    await user.click(screen.getByRole('button', { name: /^watcher/ }));

    expect(useUiStore.getState().agentPage).toEqual({ name: 'watcher', view: 'activity' });
  });

  it('marks the row whose page is open', () => {
    hydrate();
    useUiStore.getState().openAgentPage('watcher', 'definition');

    render(<AgentRow id="watcher" />);

    expect(screen.getByRole('button', { name: /^watcher/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /^watcher/ })).toHaveClass('bg-active');
  });

  it('marks nothing while another agent’s page is open', () => {
    hydrate();
    useUiStore.getState().openAgentPage('other', 'activity');

    render(<AgentRow id="watcher" />);

    expect(screen.getByRole('button', { name: /^watcher/ })).not.toHaveAttribute('aria-current');
  });
});

/**
 * The row's slot (HIVE-204): Run now and Pause show over the age on hover or
 * focus, and an answer that is not a start takes line 2 for five seconds.
 */
describe('AgentRow — the slot', () => {
  const stub = (agents: Record<string, unknown> = {}) => {
    const bridge = {
      run: vi.fn(async () => ({ started: true, run: 'r1' })),
      pause: vi.fn(async () => 'paused'),
      resume: vi.fn(async () => 'sleeping'),
      ...agents,
    };

    vi.stubGlobal('hive', { agents: bridge });

    return bridge;
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
    useHiveStore.getState().hydrateAgents([summary({ name: 'acr' })]);
    said({ from: 'acr', kind: 'done', body: 'Reviewed #303' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

  it('offers only Resume for a paused agent: one play icon, no Run now', () => {
    stub();
    useHiveStore.getState().hydrateAgents([summary({ name: 'acr', status: 'paused' })]);
    render(<AgentRow id="acr" />);

    expect(screen.queryByRole('button', { name: 'Run acr now' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Resume acr' })).toBeInTheDocument();
  });

  it('labels its actions and shows them only on hover or focus, over a fixed slot', () => {
    stub();
    render(<AgentRow id="acr" />);

    const run = screen.getByRole('button', { name: 'Run acr now' });
    const pause = screen.getByRole('button', { name: 'Pause acr' });
    const actions = run.parentElement as HTMLElement;

    expect(pause.parentElement).toBe(actions);
    expect(actions).toHaveClass('invisible', 'group-hover:visible', 'group-focus-within:visible');
    expect(screen.getByText('2m')).toHaveClass('w-[44px]');
  });

  it('offers Resume for a paused agent, and resumes it', async () => {
    useHiveStore.getState().hydrateAgents([summary({ name: 'acr', status: 'paused' })]);
    const { resume, pause } = stub();
    render(<AgentRow id="acr" />);

    await user().click(screen.getByRole('button', { name: 'Resume acr' }));

    expect(resume).toHaveBeenCalledWith({ name: 'acr' });
    expect(pause).not.toHaveBeenCalled();
  });

  it('pauses through the bridge', async () => {
    const { pause } = stub();
    render(<AgentRow id="acr" />);

    await user().click(screen.getByRole('button', { name: 'Pause acr' }));

    expect(pause).toHaveBeenCalledWith({ name: 'acr' });
  });

  it('says a refusal in line 2 for five seconds, then the last word again', async () => {
    stub({ run: vi.fn(async () => ({ started: false, refused: 'working' })) });
    render(<AgentRow id="acr" />);

    await user().click(screen.getByRole('button', { name: 'Run acr now' }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('acr is working — try again when it sleeps');
    expect(notice).toHaveClass('text-amber-text');
    expect(screen.queryByText('Reviewed #303')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('Reviewed #303')).toBeInTheDocument();
  });

  it('says a queued wake the same way', async () => {
    stub({ run: vi.fn(async () => ({ started: false, queued: true, behind: 'working' })) });
    render(<AgentRow id="acr" />);

    await user().click(screen.getByRole('button', { name: 'Run acr now' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'queued for acr — it will run when its current turn ends',
    );
  });

  it('says why a pause failed', async () => {
    stub({ pause: vi.fn(async () => Promise.reject(new Error('The agent runtime is not running.'))) });
    render(<AgentRow id="acr" />);

    await user().click(screen.getByRole('button', { name: 'Pause acr' }));

    expect(await screen.findByRole('status')).toHaveTextContent('The agent runtime is not running.');
  });

  it('says nothing when the run starts', async () => {
    const { run } = stub();
    render(<AgentRow id="acr" />);

    await user().click(screen.getByRole('button', { name: 'Run acr now' }));

    expect(run).toHaveBeenCalledWith({ name: 'acr' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
