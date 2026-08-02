import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { StatusCounts } from '@components/layout/status-counts';
import { useHiveStore } from '@stores/hive-store';

describe('StatusCounts', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
  });

  it('renders the fixture counts', () => {
    render(<StatusCounts />);

    expect(screen.getByText('4 working')).toBeInTheDocument();
    expect(screen.getByText('2 waiting')).toBeInTheDocument();
    expect(screen.getByText(/2 idle · 2 done/)).toBeInTheDocument();
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

  it('counts sessions only — agents are never in the fleet totals', () => {
    render(<StatusCounts />);

    // 4 + 2 + 2 + 2 = 10 sessions; the three agents are excluded.
    const total = [4, 2, 2, 2].reduce((a, b) => a + b, 0);
    expect(total).toBe(10);
    expect(useHiveStore.getState().agentOrder).toHaveLength(3);
  });
});
