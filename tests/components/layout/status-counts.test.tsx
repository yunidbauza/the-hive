import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { StatusCounts } from '@components/layout/status-counts';
import { useHiveStore } from '@stores/hive-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

describe('StatusCounts', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
  });

  /**
   * What the header reads on a fresh launch.
   *
   * It used to open at `4 working · 2 waiting · 2 idle · 2 ended` on a machine
   * with nothing running, because ten sessions were seeded into the store at
   * boot. Every one of these numbers now counts a real session, so all four
   * start at zero — and the zeros are the assertion, not an absence of one.
   */
  it('counts nothing when nothing is running', () => {
    useHiveStore.getState().reset();

    render(<StatusCounts />);

    expect(screen.getByText('0 working')).toBeInTheDocument();
    expect(screen.getByText('0 waiting')).toBeInTheDocument();
    expect(screen.getByText(/0 idle · 0 ended/)).toBeInTheDocument();
  });

  it('renders the seeded counts', () => {
    render(<StatusCounts />);

    expect(screen.getByText('4 working')).toBeInTheDocument();
    expect(screen.getByText('2 waiting')).toBeInTheDocument();
    expect(screen.getByText(/2 idle · 2 ended/)).toBeInTheDocument();
  });

  it('colours only the two statuses that want attention', () => {
    render(<StatusCounts />);

    expect(screen.getByText('4 working')).toHaveClass('text-green');
    expect(screen.getByText('2 waiting')).toHaveClass('text-amber');
  });

  /**
   * The counts are derived in `useCounts()`, never stored — so a status change
   * anywhere in the store has to reach the header with no wiring in between.
   */
  it('follows a status change without local state', () => {
    render(<StatusCounts />);
    expect(screen.getByText('4 working')).toBeInTheDocument();

    act(() => {
      useHiveStore
        .getState()
        .appendEntityLines('rails-upgrade', [], 'working');
    });

    expect(screen.getByText('5 working')).toBeInTheDocument();
    expect(screen.getByText(/1 idle/)).toBeInTheDocument();
  });

  /**
   * The counts are the header's shock absorber: centring the model chip makes
   * both side tracks size to the wider one, and at 1440 that is 113px more than
   * the bar has. This paragraph gives up the difference so the chip does not
   * have to. Ellipsis over wrap, because the header is one line tall — and the
   * tooltip so nothing is actually lost. `smoke.spec.ts` measures the effect;
   * happy-dom cannot, so what is pinned here is the mechanism.
   */
  it('truncates on one line rather than wrapping, and keeps the full string in its tooltip', () => {
    render(<StatusCounts />);

    const counts = screen.getByText(/2 idle · 2 ended/);
    // `min-w-0` is not decoration — without it a flex item refuses to shrink
    // below its content and `truncate` never fires.
    expect(counts).toHaveClass('min-w-0', 'truncate');
    expect(counts).toHaveAttribute(
      'title',
      '4 working · 2 waiting · 2 idle · 2 ended',
    );
  });

  /**
   * `rails-upgrade` and `e2e-quote` are the demo fleet's two idle sessions
   * (see the `2 idle · 2 ended` assertions above).
   *
   * They move to the **working** tally once something is running behind them,
   * because that is what their rows now say: every surface labels such a
   * session `working (agents)` in green, and a header reading
   * `0 working · 2 idle` beside two green `working` rows is the header and the
   * table contradicting each other about the same two sessions.
   *
   * The distinction survives in the tooltip, which is where there is room to
   * spell it out — that half is unchanged from HIVE-83.
   */
  it('counts a quiet session with something running as working', () => {
    render(<StatusCounts />);

    act(() => {
      useHiveStore
        .getState()
        .setSessionStatus('rails-upgrade', 'idle', 'agents');
      useHiveStore.getState().setSessionStatus('e2e-quote', 'idle', 'script');
    });

    const el = screen.getByTestId('status-counts');

    // 4 + these 2, and no idle session left.
    expect(el).toHaveTextContent('6 working');
    expect(el).toHaveTextContent('0 idle');
    /*
      The breakdown hangs off **working**, which is the tally those two are now
      in. Left on `idle` it read `0 idle (1 with agents, 1 with a script)` — a
      breakdown of a number those rows are not part of, which is the same
      header/table contradiction this change removes, moved into the tooltip.
    */
    expect(el.getAttribute('title')).toContain(
      '6 working (1 with agents, 1 with a script)',
    );
    expect(el.getAttribute('title')).not.toContain('0 idle (');
  });

  /** A genuinely free session — nothing running at all — is still idle. */
  it('leaves a plain idle session in the idle tally', () => {
    render(<StatusCounts />);

    act(() => {
      useHiveStore.getState().setSessionStatus('rails-upgrade', 'idle');
    });

    const el = screen.getByTestId('status-counts');
    expect(el).toHaveTextContent('2 idle');
  });

  it('counts sessions only — agents are never in the fleet totals', () => {
    render(<StatusCounts />);

    // 4 + 2 + 2 + 2 = 10 sessions; the three agents are excluded.
    const total = [4, 2, 2, 2].reduce((a, b) => a + b, 0);
    expect(total).toBe(10);
    expect(useHiveStore.getState().agentOrder).toHaveLength(3);
  });
});
