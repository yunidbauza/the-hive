import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InboxCorner } from '@components/layout/inbox-corner';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

import { seedLedger } from '@tests/support/ledger';
import { notif, resetNotifIds } from '@tests/support/notifications';

vi.mock('@hooks/use-on-stage', () => ({ useOnStage: () => null }));

beforeEach(() => {
  resetNotifIds();
  useUiStore.getState().reset();
  seedLedger([
    {
      id: 'a1',
      ts: Date.now(),
      from: 'builder',
      to: 'overmind',
      kind: 'ask',
      body: 'Run the ledger tests?',
      meta: { options: ['yes', 'no'] },
    },
  ]);
});

const stage = () => ({ current: document.createElement('main') });

describe('InboxCorner (HIVE-198)', () => {
  it('draws the pill and announces the newest arrival politely', () => {
    useHiveStore.getState().hydrateNotifs([
      notif({ id: 'a1', kind: 'agent.permission', title: 'Run the ledger tests?', action: { type: 'ask', thread: 'a1' } }),
    ]);
    useUiStore.getState().pushArrival('a1', false);
    render(<InboxCorner stage={stage()} viewKey="home" />);
    expect(screen.getByRole('button', { name: 'Inbox, 1 needs you' })).toBeInTheDocument();
    const live = screen.getByTestId('inbox-live');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('builder wants to run a command: Run the ledger tests?');
  });

  it('announces a session note by the session name', () => {
    useHiveStore.getState().hydrateNotifs([
      notif({ id: 's1', kind: 'session.blocked', action: { type: 'session', entityId: 'inbox-redesign' } }),
    ]);
    useUiStore.getState().pushArrival('s1', false);
    render(<InboxCorner stage={stage()} viewKey="home" />);
    expect(screen.getByTestId('inbox-live')).toHaveTextContent(/needs approval$/);
  });

  it('says nothing while Settings holds the stack back', () => {
    useHiveStore.getState().hydrateNotifs([
      notif({ id: 'a1', kind: 'agent.ask', title: 'Run the ledger tests?', action: { type: 'ask', thread: 'a1' } }),
    ]);
    useUiStore.getState().pushArrival('a1', false);
    useUiStore.getState().openSettings();
    render(<InboxCorner stage={stage()} viewKey="home" />);
    expect(screen.getByTestId('inbox-live')).toBeEmptyDOMElement();
  });

  it('says nothing while the stack is down, however much waits (HIVE-228)', () => {
    useHiveStore.getState().hydrateNotifs([
      notif({ id: 'a1', kind: 'agent.ask', title: 'Run the ledger tests?', action: { type: 'ask', thread: 'a1' } }),
    ]);
    render(<InboxCorner stage={stage()} viewKey="home" />);
    expect(screen.getByTestId('inbox-live')).toBeEmptyDOMElement();
  });

  it('keeps the live region mounted and silent with nothing up', () => {
    render(<InboxCorner stage={stage()} viewKey="home" />);
    expect(screen.getByTestId('inbox-live')).toBeEmptyDOMElement();
  });

  it('sits 24px in from the stage corner with no input', () => {
    const { container } = render(<InboxCorner stage={stage()} viewKey="home" />);
    expect((container.firstElementChild as HTMLElement).style.bottom).toBe('24px');
  });
});
