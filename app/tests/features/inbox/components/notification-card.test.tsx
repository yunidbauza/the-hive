import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { NotificationCard } from '@features/inbox/components/notification-card';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

const notif = (overrides = {}) => ({
  icon: 'ph-hand-palm',
  tone: 'amber' as const,
  title: 'lead-form needs approval',
  sub: 'prisma migrate dev — lead_phone_idx',
  time: '4m',
  unread: true,
  target: 'lead-form',
  ...overrides,
});

beforeEach(() => {
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
});

describe('NotificationCard', () => {
  it('renders title, subtitle, and time', () => {
    render(<NotificationCard notif={notif()} index={0} />);

    expect(screen.getByText('lead-form needs approval')).toBeInTheDocument();
    expect(
      screen.getByText('prisma migrate dev — lead_phone_idx'),
    ).toBeInTheDocument();
    expect(screen.getByText('4m')).toBeInTheDocument();
  });

  /** Unread is a chip fill plus a stronger border; read is transparent. */
  it('fills an unread card and flattens a read one', () => {
    const { rerender } = render(<NotificationCard notif={notif()} index={0} />);
    expect(screen.getByRole('button')).toHaveClass('bg-chip');

    rerender(<NotificationCard notif={notif({ unread: false })} index={0} />);
    expect(screen.getByRole('button')).not.toHaveClass('bg-chip');
  });

  it('opens the target session and marks only this card read', async () => {
    const user = userEvent.setup();
    render(<NotificationCard notif={notif()} index={0} />);

    await user.click(screen.getByRole('button'));

    expect(useUiStore.getState().activeTab).toBe('lead-form');
    expect(useHiveStore.getState().notifs[0].unread).toBe(false);
    expect(useHiveStore.getState().notifs[1].unread).toBe(true);
  });

  /** The count is what the badges read; an unread card must say so out loud. */
  it('announces its unread state', () => {
    render(<NotificationCard notif={notif()} index={0} />);

    expect(screen.getByText('unread')).toBeInTheDocument();
  });

  it('says nothing extra once read', () => {
    render(<NotificationCard notif={notif({ unread: false })} index={0} />);

    expect(screen.queryByText('unread')).not.toBeInTheDocument();
  });
});
