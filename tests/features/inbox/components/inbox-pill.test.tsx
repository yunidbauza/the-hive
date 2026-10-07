import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InboxPill } from '@features/inbox/components/inbox-pill';
import { useReducedMotion } from '@hooks/use-reduced-motion';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

import { notif, resetNotifIds } from '@tests/support/notifications';

vi.mock('@hooks/use-reduced-motion', () => ({ useReducedMotion: vi.fn(() => false) }));

const ask = (id: string) => notif({ id, kind: 'agent.ask', action: { type: 'ask', thread: id } });
const blocked = (id: string, terminal: string) =>
  notif({ id, kind: 'session.blocked', action: { type: 'session', entityId: terminal } });

beforeEach(() => {
  resetNotifIds();
  vi.mocked(useReducedMotion).mockReturnValue(false);
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
});

describe('InboxPill (HIVE-198)', () => {
  it('is absent with nothing waiting', () => {
    render(<InboxPill onStage={null} />);
    expect(screen.queryByRole('button', { name: /^Inbox/ })).toBeNull();
  });

  it('counts the Summons queue, the on-stage session left out', () => {
    useHiveStore.getState().hydrateNotifs([ask('a1'), blocked('s1', 'nova'), blocked('s2', 'lead')]);
    render(<InboxPill onStage="lead" />);
    expect(screen.getByRole('button', { name: 'Inbox, 2 need you' })).toHaveTextContent('2need you');
    expect(screen.getByText('2').className).toContain('text-amber-text');
  });

  it('hides while the drawer is open', () => {
    useHiveStore.getState().hydrateNotifs([ask('a1')]);
    useUiStore.getState().openInboxDrawer();
    render(<InboxPill onStage={null} />);
    expect(screen.queryByRole('button', { name: /^Inbox/ })).toBeNull();
  });

  it('the count shows and hides the stack, and says which (HIVE-228)', async () => {
    useHiveStore.getState().hydrateNotifs([ask('a1')]);
    render(<InboxPill onStage={null} />);
    const count = screen.getByRole('button', { name: 'Inbox, 1 needs you' });
    expect(count).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(count);
    expect(useUiStore.getState().stackUp).toBe(true);
    expect(count).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(count);
    expect(useUiStore.getState().stackUp).toBe(false);
    expect(useUiStore.getState().inboxDrawer.open).toBe(false);
  });

  it('is not expanded while Settings holds the stack back', () => {
    useHiveStore.getState().hydrateNotifs([ask('a1')]);
    useUiStore.getState().toggleStack();
    useUiStore.getState().openSettings();
    render(<InboxPill onStage={null} />);
    expect(screen.getByRole('button', { name: /^Inbox/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('one row: the count alone, singular, with no Open all', () => {
    useHiveStore.getState().hydrateNotifs([ask('a1')]);
    render(<InboxPill onStage={null} />);
    expect(screen.getByRole('button', { name: 'Inbox, 1 needs you' })).toHaveTextContent('1needs you');
    expect(screen.queryByRole('button', { name: 'Open all' })).toBeNull();
  });

  it('more than one: Open all opens the drawer', async () => {
    useHiveStore.getState().hydrateNotifs([ask('a1'), ask('a2')]);
    render(<InboxPill onStage={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open all' }));
    expect(useUiStore.getState().inboxDrawer).toEqual({ open: true, thread: null });
  });

  it('pulses once for a quiet arrival it counts', () => {
    useHiveStore.getState().hydrateNotifs([ask('a1')]);
    useUiStore.getState().pushArrival('a1', true);
    render(<InboxPill onStage={null} />);
    expect(screen.getByRole('button', { name: /^Inbox/ }).parentElement?.className).toContain('animate-ccpulse');
  });

  it('does not pulse for the session on stage, nor under reduced motion', () => {
    useHiveStore.getState().hydrateNotifs([ask('a1'), blocked('s1', 'lead')]);
    useUiStore.getState().pushArrival('s1', true);
    const { rerender } = render(<InboxPill onStage="lead" />);
    expect(screen.getByRole('button', { name: /^Inbox/ }).parentElement?.className).not.toContain('animate-ccpulse');

    vi.mocked(useReducedMotion).mockReturnValue(true);
    useUiStore.getState().pushArrival('a1', true);
    rerender(<InboxPill onStage="lead" />);
    expect(screen.getByRole('button', { name: /^Inbox/ }).parentElement?.className).not.toContain('animate-ccpulse');
  });
});

describe('InboxPill, a long queue (HIVE-211)', () => {
  const asks = (n: number) => Array.from({ length: n }, (_, i) => ask(`a${String(i)}`));

  it('shows 99+ past ninety-nine, and the exact number in its name', () => {
    useHiveStore.getState().hydrateNotifs(asks(140));
    render(<InboxPill onStage={null} />);
    const pill = screen.getByRole('button', { name: 'Inbox, 140 need you' });
    expect(pill).toHaveTextContent('99+need you');
  });

  it('shows 99 at ninety-nine', () => {
    useHiveStore.getState().hydrateNotifs(asks(99));
    render(<InboxPill onStage={null} />);
    expect(screen.getByRole('button', { name: 'Inbox, 99 need you' })).toHaveTextContent('99need you');
  });

  it('is singular for one', () => {
    useHiveStore.getState().hydrateNotifs(asks(1));
    render(<InboxPill onStage={null} />);
    expect(screen.getByRole('button', { name: 'Inbox, 1 needs you' })).toBeInTheDocument();
  });
});
