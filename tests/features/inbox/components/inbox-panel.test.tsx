import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { InboxPanel } from '@features/inbox/components/inbox-panel';
import { NOTIFICATION_CAP } from '@shared/notification-contract';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

import { notif, resetNotifIds } from '../../../support/notifications';

beforeEach(() => {
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
  resetNotifIds();
});

describe('InboxPanel', () => {
  /**
   * The app boots with nothing in the inbox, which is the honest state: no
   * session has asked for the user yet. It used to open onto five seeded rows
   * naming sessions that did not exist.
   */
  it('opens empty, and says so rather than apologising', () => {
    render(<InboxPanel />);

    // `EmptyState` renders the sentence and its follow-up as sibling nodes in
    // one paragraph, so match the paragraph rather than a text node.
    expect(screen.getByText(/Nothing needs you\./)).toBeInTheDocument();
    expect(
      screen.getByText(/Sessions and pull requests will show up here\./),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders what the store holds, newest first', () => {
    useHiveStore
      .getState()
      .hydrateNotifs([
        notif({ id: 'a', title: 'older', createdAt: 1_000 }),
        notif({ id: 'b', title: 'newer', createdAt: 2_000 }),
      ]);

    render(<InboxPanel />);

    const titles = screen.getAllByRole('button').map((b) => b.textContent);
    expect(titles[0]).toContain('newer');
    expect(titles[1]).toContain('older');
  });

  it('shows a pushed notification at the top', () => {
    useHiveStore.getState().hydrateNotifs([notif({ id: 'a', title: 'existing' })]);
    useHiveStore
      .getState()
      .pushNotif(notif({ id: 'b', title: 'just arrived', createdAt: Date.now() }));

    render(<InboxPanel />);

    expect(screen.getAllByRole('button')[0].textContent).toContain(
      'just arrived',
    );
  });

  it('caps the rendered list at the shared cap', () => {
    for (let i = 0; i < NOTIFICATION_CAP + 5; i += 1) {
      useHiveStore.getState().pushNotif(notif({ id: `n${i}`, createdAt: i }));
    }

    render(<InboxPanel />);
    expect(screen.getAllByRole('button')).toHaveLength(NOTIFICATION_CAP);
  });

  /**
   * Identity is the key now, so two rows with identical copy are two rows —
   * which the previous content-plus-position key could only approximate.
   */
  it('renders two identical notifications without a key collision', () => {
    useHiveStore
      .getState()
      .hydrateNotifs([
        notif({ id: 'a', title: 'same', body: 'same' }),
        notif({ id: 'b', title: 'same', body: 'same' }),
      ]);

    render(<InboxPanel />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  /** A duplicate id is one notification, however many times it arrives. */
  it('ignores a re-delivered notification', () => {
    useHiveStore.getState().pushNotif(notif({ id: 'dup' }));
    useHiveStore.getState().pushNotif(notif({ id: 'dup' }));

    render(<InboxPanel />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('jumps to the session a card names', async () => {
    const user = userEvent.setup();
    useHiveStore
      .getState()
      .hydrateNotifs([
        notif({ id: 'a', action: { type: 'session', entityId: 'call-notes' } }),
      ]);

    render(<InboxPanel />);
    await user.click(screen.getByRole('button'));

    expect(useUiStore.getState().activeTab).toBe('call-notes');
  });

  it('drops the unread styling when everything is marked read', () => {
    useHiveStore
      .getState()
      .hydrateNotifs([notif({ id: 'a' }), notif({ id: 'b' })]);
    useHiveStore.getState().markAllRead();

    render(<InboxPanel />);

    for (const button of screen.getAllByRole('button')) {
      expect(button).not.toHaveClass('bg-chip');
    }
  });
});
