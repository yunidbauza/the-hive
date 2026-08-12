import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { NotificationCard } from '@features/inbox/components/notification-card';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

import { notif, resetNotifIds } from '../../../support/notifications';

beforeEach(() => {
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
  resetNotifIds();
});

describe('NotificationCard', () => {
  it('renders the title, the body, and a derived time', () => {
    render(<NotificationCard notif={notif({ createdAt: Date.now() })} />);

    expect(screen.getByText('lead-form needs approval')).toBeInTheDocument();
    expect(
      screen.getByText('prisma migrate dev — lead_phone_idx'),
    ).toBeInTheDocument();
    // Derived from `createdAt`, not carried on the record.
    expect(screen.getByText('now')).toBeInTheDocument();
  });

  /** An empty body renders nothing rather than an empty line. */
  it('omits the body when there is none', () => {
    render(<NotificationCard notif={notif({ body: '' })} />);

    expect(screen.getByText('lead-form needs approval')).toBeInTheDocument();
    expect(screen.queryByText('prisma migrate dev — lead_phone_idx')).toBeNull();
  });

  /**
   * The glyph and its colour come from the kind's registry entry. Nothing on
   * the record says `amber`, and that is the point.
   */
  it('takes its tone from the kind, not from the record', () => {
    const { rerender } = render(
      <NotificationCard notif={notif({ kind: 'session.waiting' })} />,
    );
    expect(document.querySelector('.text-amber')).not.toBeNull();

    rerender(<NotificationCard notif={notif({ kind: 'pr.merged' })} />);
    expect(document.querySelector('.text-green')).not.toBeNull();
  });

  /** Unread is a chip fill plus a stronger border; read is transparent. */
  it('fills an unread card and flattens a read one', () => {
    const { rerender } = render(<NotificationCard notif={notif()} />);
    expect(screen.getByRole('button')).toHaveClass('bg-chip');

    rerender(<NotificationCard notif={notif({ unread: false })} />);
    expect(screen.getByRole('button')).not.toHaveClass('bg-chip');
  });

  it('opens the session it names and marks only this card read', async () => {
    const user = userEvent.setup();
    const first = notif({ id: 'a' });
    const second = notif({ id: 'b' });
    useHiveStore.getState().hydrateNotifs([first, second]);

    render(<NotificationCard notif={first} />);
    await user.click(screen.getByRole('button'));

    expect(useUiStore.getState().activeTab).toBe('lead-form');
    const notifs = useHiveStore.getState().notifs;
    expect(notifs.find((n) => n.id === 'a')?.unread).toBe(false);
    expect(notifs.find((n) => n.id === 'b')?.unread).toBe(true);
  });

  /**
   * The regression the id migration exists to prevent.
   *
   * A notification landing between render and click used to shift every row
   * down one, so the click dismissed the row above the one the user aimed at.
   */
  it('marks the card that was clicked even when the list changed underneath', async () => {
    const user = userEvent.setup();
    const target = notif({ id: 'target' });
    useHiveStore.getState().hydrateNotifs([target]);

    render(<NotificationCard notif={target} />);

    // Something arrives and takes position zero.
    useHiveStore.getState().pushNotif(notif({ id: 'newcomer' }));
    await user.click(screen.getByRole('button'));

    const notifs = useHiveStore.getState().notifs;
    expect(notifs.find((n) => n.id === 'target')?.unread).toBe(false);
    expect(notifs.find((n) => n.id === 'newcomer')?.unread).toBe(true);
  });

  /** A clone has nowhere to go, so the click dismisses and stays put. */
  it('marks read without navigating for an action with no destination', async () => {
    const user = userEvent.setup();
    const entry = notif({ id: 'c', kind: 'clone.done', action: { type: 'none' } });
    useHiveStore.getState().hydrateNotifs([entry]);

    render(<NotificationCard notif={entry} />);
    await user.click(screen.getByRole('button'));

    expect(useUiStore.getState().activeTab).toBe('orch');
    expect(useHiveStore.getState().notifs[0].unread).toBe(false);
  });

  /** The count is what the badges read; an unread card must say so out loud. */
  it('announces its unread state', () => {
    render(<NotificationCard notif={notif()} />);
    expect(screen.getByText('unread')).toBeInTheDocument();
  });

  it('says nothing extra once read', () => {
    render(<NotificationCard notif={notif({ unread: false })} />);
    expect(screen.queryByText('unread')).toBeNull();
  });
});
