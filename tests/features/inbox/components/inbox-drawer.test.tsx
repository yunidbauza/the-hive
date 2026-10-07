import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InboxDrawer } from '@features/inbox/components/inbox-drawer';
import { LEAVE_MS } from '@features/inbox/hooks/use-leaving-asks';
import { useAppearanceStore } from '@stores/appearance-store';
import { useHiveStore } from '@stores/hive-store';
import { NEWS_SECTION, useUiStore } from '@stores/ui-store';

import { seedLedger } from '@tests/support/ledger';
import { notif, resetNotifIds } from '@tests/support/notifications';
import { expectNoHexColour, inLight } from '@tests/support/light';

const askEntry = (id: string) => ({
  id,
  ts: Date.now(),
  from: 'builder',
  to: 'overmind',
  kind: 'ask' as const,
  body: 'Run the ledger tests?',
  meta: { options: ['yes', 'no'] },
});

const askRow = (id: string) =>
  notif({ id, kind: 'agent.ask', title: 'Run the ledger tests?', action: { type: 'ask', thread: id } });

beforeEach(() => {
  resetNotifIds();
  useUiStore.getState().reset();
  seedLedger(['a1', 'a2'].map(askEntry));
  useHiveStore.getState().hydrateNotifs([
    askRow('a1'),
    askRow('a2'),
    notif({ id: 's1', kind: 'session.blocked', action: { type: 'session', entityId: 'nova' } }),
    notif({ id: 'e1', kind: 'clone.done', action: { type: 'none' } }),
  ]);
});

afterEach(() => {
  act(() => useAppearanceStore.getState().setTheme('dark'));
});

describe('InboxDrawer (HIVE-198)', () => {
  it('renders nothing while shut', () => {
    render(<InboxDrawer onStage={null} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('takes the title bar\'s drag strip back, so ✕ under it gets the click instead of moving the window', () => {
    // happy-dom keeps no app-region, so the class is the only witness; the drag itself is Electron's native hit test.
    useUiStore.getState().openInboxDrawer();
    render(<InboxDrawer onStage={null} />);
    expect(screen.getByRole('dialog', { name: 'Needs you' })).toHaveClass('[-webkit-app-region:no-drag]');
  });

  it('casts its shadow left, onto the stage it covers (HIVE-228)', () => {
    // happy-dom resolves no box-shadow, so the token's class is the witness; its value lives in tokens.css.
    useUiStore.getState().openInboxDrawer();
    render(<InboxDrawer onStage={null} />);
    expect(screen.getByRole('dialog', { name: 'Needs you' })).toHaveClass('shadow-drawer');
  });

  it('renders in light on tokens alone (HIVE-210)', () => {
    useUiStore.getState().openInboxDrawer();
    inLight();
    const { baseElement } = render(<InboxDrawer onStage={null} />);
    expect(screen.getByText('2 asks · 1 session')).toBeInTheDocument();
    expectNoHexColour(baseElement);
  });

  it('heads the queue and draws every card whole, then the sessions off stage', () => {
    useUiStore.getState().openInboxDrawer();
    render(<InboxDrawer onStage={null} />);
    const drawer = screen.getByRole('dialog', { name: 'Needs you' });
    expect(within(drawer).getByText('2 asks · 1 session')).toBeInTheDocument();
    expect(within(drawer).getAllByRole('button', { name: /^Open builder ›$/ })).toHaveLength(2);
    expect(within(drawer).getAllByRole('button', { name: 'yes' })).toHaveLength(2);
    expect(within(drawer).getByText('Sessions off stage')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: /^Open \S+, / })).toBeInTheDocument();
  });

  it('a review request is the plain notification card', () => {
    useHiveStore.getState().hydrateNotifs([
      notif({ id: 'r1', kind: 'pr.review_requested', title: 'Review #12', action: { type: 'none' } }),
    ]);
    useUiStore.getState().openInboxDrawer();
    render(<InboxDrawer onStage={null} />);
    expect(screen.getByText('Review #12')).toBeInTheDocument();
  });

  it('Esc and ✕ each close it', async () => {
    useUiStore.getState().openInboxDrawer();
    render(<InboxDrawer onStage={null} />);
    await userEvent.keyboard('{Escape}');
    expect(useUiStore.getState().inboxDrawer.open).toBe(false);
    act(() => useUiStore.getState().openInboxDrawer());
    await userEvent.click(screen.getByRole('button', { name: 'Close the inbox' }));
    expect(useUiStore.getState().inboxDrawer.open).toBe(false);
  });

  it('opened from the pill, focus moves into it, and goes back on close', () => {
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    useUiStore.getState().openInboxDrawer();
    render(<InboxDrawer onStage={null} />);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    act(() => useUiStore.getState().closeInboxDrawer());
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it('re-aimed at another thread while open, close still returns focus to where it began', () => {
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    useUiStore.getState().openInboxDrawer('a1');
    render(<InboxDrawer onStage={null} />);
    act(() => useUiStore.getState().openInboxDrawer('a2'));
    expect(document.activeElement?.getAttribute('data-thread')).toBe('a2');
    act(() => useUiStore.getState().closeInboxDrawer());
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it('opened on a thread, that card has focus', () => {
    useUiStore.getState().openInboxDrawer('a1');
    render(<InboxDrawer onStage={null} />);
    expect(document.activeElement?.getAttribute('data-thread')).toBe('a1');
  });

  it('lists the news under its own New heading, after what waits on you (HIVE-231)', () => {
    useUiStore.getState().openInboxDrawer();
    render(<InboxDrawer onStage={null} />);
    const news = screen.getByRole('region', { name: 'New' });
    expect(within(news).getByText('1')).toBeInTheDocument();
    expect([...news.querySelectorAll('[data-notification]')].map((el) => el.getAttribute('data-notification'))).toEqual([
      'e1',
    ]);
  });

  it('opened at New, the section has focus (HIVE-231)', () => {
    useUiStore.getState().openInboxDrawer(NEWS_SECTION);
    render(<InboxDrawer onStage={null} />);
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'New' }));
  });

  it('Clear empties New and leaves what waits on you (HIVE-231)', async () => {
    const dismiss = vi.fn((_id: string) => Promise.resolve());
    (window as { hive?: unknown }).hive = { notifications: { dismiss } };
    useHiveStore.getState().pushNotif(notif({ id: 'e2', kind: 'pr.merged', action: { type: 'none' } }));
    useUiStore.getState().openInboxDrawer();
    render(<InboxDrawer onStage={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Clear the news' }));
    expect(screen.queryByRole('region', { name: 'New' })).toBeNull();
    expect(dismiss.mock.calls.map(([id]) => id).sort()).toEqual(['e1', 'e2']);
    expect(useHiveStore.getState().notifs.map((n) => n.id).sort()).toEqual(['a1', 'a2', 's1']);
    delete (window as { hive?: unknown }).hive;
  });

  it('Clear leaves an update ready to install, the news that waits on you (HIVE-231)', async () => {
    const dismiss = vi.fn((_id: string) => Promise.resolve());
    (window as { hive?: unknown }).hive = { notifications: { dismiss } };
    useHiveStore.getState().pushNotif(notif({ id: 'r1', kind: 'app.update_ready', action: { type: 'update.install' } }));
    useUiStore.getState().openInboxDrawer();
    render(<InboxDrawer onStage={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Clear the news' }));
    expect(dismiss.mock.calls.map(([id]) => id)).toEqual(['e1']);
    const news = screen.getByRole('region', { name: 'New' });
    expect(news.querySelector('[data-notification="r1"]')).not.toBeNull();
    // Nothing left that Clear would take, so it is not offered.
    expect(within(news).queryByRole('button', { name: 'Clear the news' })).toBeNull();
    delete (window as { hive?: unknown }).hive;
  });

  it('says so when everything has been answered', () => {
    useHiveStore.setState({ notifs: [] });
    useUiStore.getState().openInboxDrawer();
    render(<InboxDrawer onStage={null} />);
    expect(screen.getByText('Nothing waits on you.')).toBeInTheDocument();
    expect(screen.getByText('0 asks · 0 sessions')).toBeInTheDocument();
  });
});

describe('a closed ask leaves with its reason (HIVE-218)', () => {
  afterEach(() => vi.useRealTimers());

  it('lets an expiring ask leave with "expired", counting only the live ones', () => {
    vi.useFakeTimers();
    useUiStore.getState().openInboxDrawer();
    render(<InboxDrawer onStage={null} />);
    act(() =>
      useHiveStore.getState().hydrateLedger([
        { id: 'x1', ts: Date.now(), from: 'overmind', kind: 'event', body: 'ask a1 expired', thread: 'a1', meta: { expired: 'a1' } },
      ]),
    );
    expect(screen.getByText('expired')).toBeInTheDocument();
    expect(screen.getByText('1 ask · 1 session')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(LEAVE_MS));
    expect(screen.queryByText('expired')).toBeNull();
  });
});
