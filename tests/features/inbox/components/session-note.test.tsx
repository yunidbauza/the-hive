import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/types/entity';

import { SessionNote } from '@features/inbox/components/session-note';
import { useHiveStore } from '@stores/hive-store';

import { notif, resetNotifIds } from '@tests/support/notifications';

const session: Session = {
  kind: 'session',
  id: 'sess-03',
  terminalId: 'nova',
  project: 'the-hive',
  status: 'waiting',
  task: 'inbox-redesign',
  cost: '$0.00',
  lines: [],
};

const blocked = () =>
  notif({ id: 's1', kind: 'session.blocked', title: 'needs approval', action: { type: 'session', entityId: 'nova' } });

beforeEach(() => {
  resetNotifIds();
  useHiveStore.getState().reset();
  useHiveStore.setState({ entities: { 'sess-03': session }, order: ['sess-03'] });
});

describe('SessionNote (HIVE-198)', () => {
  it('a note: the name, what happened, where the answer goes, Open and Later', async () => {
    const onFold = vi.fn();
    const openEntity = vi.fn(() => true);
    useHiveStore.setState({ openEntity });
    render(<SessionNote notif={blocked()} variant="note" onFold={onFold} />);

    // The row's own words: a permission prompt is not "asked a question".
    expect(screen.getByText('needs approval')).toBeInTheDocument();
    expect(screen.getByText('the-hive · it waits in the session; the answer goes there')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open the session' }));
    expect(openEntity).toHaveBeenCalledWith('sess-03');
    await userEvent.click(screen.getByRole('button', { name: 'Later' }));
    await userEvent.click(screen.getByRole('button', { name: 'Fold into the pill' }));
    expect(onFold).toHaveBeenCalledTimes(2);
  });

  it('a session that is yours again says so, with nothing to answer', () => {
    const idle = notif({ id: 'i1', kind: 'session.idle', title: 'is yours again', action: { type: 'session', entityId: 'nova' } });
    const { unmount } = render(<SessionNote notif={idle} variant="note" />);
    expect(screen.getByRole('article', { name: 'sess-03 is yours again' })).toBeInTheDocument();
    expect(screen.getByText('the-hive · its turn is over; it waits for you')).toBeInTheDocument();
    unmount();
    render(<SessionNote notif={idle} variant="row" />);
    expect(screen.getByText('the-hive · pick it up in the session')).toBeInTheDocument();
  });

  it('a drawer row: what it wants, and the whole row opens the session', async () => {
    const openEntity = vi.fn(() => true);
    useHiveStore.setState({ openEntity });
    render(<SessionNote notif={blocked()} variant="row" />);
    expect(screen.getByText('needs approval')).toBeInTheDocument();
    expect(screen.getByText('the-hive · answer it in the session')).toBeInTheDocument();
    expect(screen.queryByText('Open ›')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('answer it', { exact: false }));
    expect(openEntity).toHaveBeenCalledWith('sess-03');
    expect(screen.getByRole('button', { name: 'Open sess-03, needs approval' })).toBeInTheDocument();
  });
});
