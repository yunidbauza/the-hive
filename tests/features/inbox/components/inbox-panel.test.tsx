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

/**
 * The notification rows, and only those.
 *
 * The panel is a column of buttons *plus* a header that is also a button, so
 * "every button in the inbox" stopped meaning "every card" when Clear all
 * landed. `data-notification` is the card's own identity in the DOM — see
 * `notification-card.tsx`.
 */
const cards = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-notification]'));

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

  /**
   * The header exists only when there is something to head. On the empty state
   * a "Clear all" over a sprite saying *Nothing needs you* would be a control
   * for a list that is not there — which the empty-state test above already
   * asserts by counting buttons.
   */
  it('heads the list with a count and a way to empty it', () => {
    useHiveStore
      .getState()
      .hydrateNotifs([
        notif({ id: 'a', unread: true }),
        notif({ id: 'b', unread: false }),
      ]);

    render(<InboxPanel />);

    expect(screen.getByText('2 notifications · 1 unread')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument();
  });

  it('clears every card when Clear all is pressed', async () => {
    useHiveStore
      .getState()
      .hydrateNotifs([
        notif({ id: 'a', title: 'first' }),
        notif({ id: 'b', title: 'second' }),
      ]);

    render(<InboxPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));

    expect(screen.queryByText('first')).toBeNull();
    expect(screen.queryByText('second')).toBeNull();
    // Straight to the empty state — no confirm step, and nothing left behind.
    expect(screen.getByText(/Nothing needs you\./)).toBeInTheDocument();
  });

  it('renders what the store holds, newest first', () => {
    useHiveStore
      .getState()
      .hydrateNotifs([
        notif({ id: 'a', title: 'older', createdAt: 1_000 }),
        notif({ id: 'b', title: 'newer', createdAt: 2_000 }),
      ]);

    render(<InboxPanel />);

    const titles = cards().map((b) => b.textContent);
    expect(titles[0]).toContain('newer');
    expect(titles[1]).toContain('older');
  });

  it('shows a pushed notification at the top', () => {
    useHiveStore.getState().hydrateNotifs([notif({ id: 'a', title: 'existing' })]);
    useHiveStore
      .getState()
      .pushNotif(notif({ id: 'b', title: 'just arrived', createdAt: Date.now() }));

    render(<InboxPanel />);

    expect(cards()[0]?.textContent).toContain('just arrived');
  });

  it('caps the rendered list at the shared cap', () => {
    for (let i = 0; i < NOTIFICATION_CAP + 5; i += 1) {
      useHiveStore.getState().pushNotif(notif({ id: `n${i}`, createdAt: i }));
    }

    render(<InboxPanel />);
    expect(cards()).toHaveLength(NOTIFICATION_CAP);
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
    expect(cards()).toHaveLength(2);
  });

  /** A duplicate id is one notification, however many times it arrives. */
  it('ignores a re-delivered notification', () => {
    useHiveStore.getState().pushNotif(notif({ id: 'dup' }));
    useHiveStore.getState().pushNotif(notif({ id: 'dup' }));

    render(<InboxPanel />);
    expect(cards()).toHaveLength(1);
  });

  it('jumps to the session a card names', async () => {
    const user = userEvent.setup();
    useHiveStore
      .getState()
      .hydrateNotifs([
        notif({ id: 'a', action: { type: 'session', entityId: 'call-notes' } }),
      ]);

    render(<InboxPanel />);
    await user.click(cards()[0] as HTMLElement);

    expect(useUiStore.getState().activeTab).toBe('call-notes');
  });

  it('drops the unread styling when everything is marked read', () => {
    useHiveStore
      .getState()
      .hydrateNotifs([notif({ id: 'a' }), notif({ id: 'b' })]);
    useHiveStore.getState().markAllRead();

    render(<InboxPanel />);

    for (const button of cards()) {
      expect(button).not.toHaveClass('bg-chip');
    }
  });
});
