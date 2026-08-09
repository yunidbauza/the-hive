import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ActivityRail } from '@components/layout/activity-rail';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

/** Panels are identified by `data-panel`, as in the left rail's tests. */
const panel = (container: HTMLElement, name: string) =>
  container.querySelector(`[data-panel="${name}"]`);

beforeEach(() => {
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
});

describe('ActivityRail', () => {
  it('opens on the inbox', () => {
    const { container } = render(<ActivityRail />);

    expect(panel(container, 'inbox')).toBeInTheDocument();
  });

  it('swaps the panel when a tab is selected', async () => {
    const user = userEvent.setup();
    const { container } = render(<ActivityRail />);

    await user.click(screen.getByRole('tab', { name: /PRs/ }));
    expect(panel(container, 'prs')).toBeInTheDocument();
    expect(panel(container, 'inbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Explorer/ }));
    expect(panel(container, 'explorer')).toBeInTheDocument();
    expect(panel(container, 'prs')).not.toBeInTheDocument();
  });

  it('follows railTab from the store', async () => {
    const { container } = render(<ActivityRail />);

    await act(async () => {
      useUiStore.getState().setRailTab('prs');
    });

    expect(panel(container, 'prs')).toBeInTheDocument();
  });

  it('labels the panel with its tab, for screen readers', () => {
    render(<ActivityRail />);

    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      'tab-inbox',
    );
  });

  /** Louder than the left rail's neutral count: it means agents are blocked. */
  it('badges the inbox tab in red with the unread count', () => {
    render(<ActivityRail />);

    expect(screen.getByText('3').parentElement).toHaveClass('bg-danger-solid');
  });

  it('drops the badge when everything is read', async () => {
    render(<ActivityRail />);

    await act(async () => {
      useHiveStore.getState().markAllRead();
    });

    expect(screen.queryByText('3')).not.toBeInTheDocument();
  });

  it('updates the badge live when a notification arrives', async () => {
    render(<ActivityRail />);

    await act(async () => {
      useHiveStore.getState().markAllRead();
      useHiveStore.getState().pushNotif({
        icon: 'ph-hand-palm',
        tone: 'amber',
        title: 'nplusone needs approval',
        sub: 'drop the index?',
        time: 'now',
        unread: true,
        target: 'nplusone',
      });
    });

    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('badges only the inbox tab', () => {
    render(<ActivityRail />);

    expect(screen.getByRole('tab', { name: /Inbox/ })).toHaveTextContent('3');
    expect(screen.getByRole('tab', { name: /PRs/ })).not.toHaveTextContent(/\d/);
  });
});
