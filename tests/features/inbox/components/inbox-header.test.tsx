import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InboxHeader } from '@features/inbox/components/inbox-header';
import { useHiveStore } from '@stores/hive-store';

import { notif, resetNotifIds } from '../../../support/notifications';

beforeEach(() => {
  useHiveStore.getState().reset();
  resetNotifIds();
});

afterEach(() => {
  delete window.hive;
});

describe('InboxHeader', () => {
  it('counts what is in the list', () => {
    render(<InboxHeader total={7} unread={3} />);

    expect(screen.getByText('7 notifications · 3 unread')).toBeInTheDocument();
  });

  it('says notification, singular, for one row', () => {
    render(<InboxHeader total={1} unread={1} />);

    expect(screen.getByText('1 notification · 1 unread')).toBeInTheDocument();
  });

  /**
   * The tab's red badge is the surface that answers "how much is new", and it
   * is simply absent at zero. A row reading "· 0 unread" would argue with it.
   */
  it('drops the unread half when nothing is unread', () => {
    render(<InboxHeader total={4} unread={0} />);

    expect(screen.getByText('4 notifications')).toBeInTheDocument();
    expect(screen.queryByText(/unread/)).toBeNull();
  });

  it('empties the store and the hub when cleared', async () => {
    const clear = vi.fn();
    window.hive = {
      notifications: { clear },
    } as unknown as Window['hive'];

    useHiveStore
      .getState()
      .hydrateNotifs([notif({ id: 'a' }), notif({ id: 'b' })]);

    render(<InboxHeader total={2} unread={1} />);
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));

    expect(useHiveStore.getState().notifs).toEqual([]);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  /**
   * The header bell stopped marking everything read on purpose (HIVE-93). A
   * second bulk verb here would put it back through the side door, so its
   * absence is asserted rather than assumed.
   */
  it('offers exactly one bulk action', () => {
    render(<InboxHeader total={3} unread={2} />);

    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByText(/mark all/i)).toBeNull();
  });
});
