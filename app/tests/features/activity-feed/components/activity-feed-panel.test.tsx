import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ActivityFeedPanel } from '@features/activity-feed/components/activity-feed-panel';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

beforeEach(() => {
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
});

describe('ActivityFeedPanel', () => {
  it('renders the seven seeded items in order, newest first', () => {
    render(<ActivityFeedPanel />);

    const times = screen
      .getAllByText(/^\d{2}:\d{2}$/)
      .map((node) => node.textContent);
    expect(times).toEqual([
      '14:37',
      '14:36',
      '14:34',
      '14:32',
      '14:28',
      '14:21',
      '14:12',
    ]);
  });

  it('renders each item text', () => {
    render(<ActivityFeedPanel />);

    expect(
      screen.getByText('Loop: polled 4 open PRs — no new feedback'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('lead-form paused — permission needed'),
    ).toBeInTheDocument();
  });

  /** A log, not navigation — nothing here is clickable. */
  it('has no interactive rows', () => {
    render(<ActivityFeedPanel />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('prepends a routed message with the next fake-clock stamp', async () => {
    render(<ActivityFeedPanel />);

    await act(async () => {
      useHiveStore.getState().sendToEntity('lead-form', 'y');
    });

    expect(screen.getByText('Routed your reply to lead-form')).toBeInTheDocument();
    expect(screen.getAllByText(/^\d{2}:\d{2}$/)[0]).toHaveTextContent('14:38');
  });

  it('never renders more than twenty-four items', async () => {
    render(<ActivityFeedPanel />);

    await act(async () => {
      for (let i = 0; i < 30; i += 1) {
        useHiveStore.getState().pushFeed({
          time: '15:00',
          txt: `event ${i}`,
          tone: 'brand',
          icon: 'ph-plus-circle',
        });
      }
    });

    expect(screen.getAllByText(/^\d{2}:\d{2}$/)).toHaveLength(24);
  });
});
