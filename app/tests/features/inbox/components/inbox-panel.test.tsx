import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { InboxPanel } from '@features/inbox/components/inbox-panel';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

beforeEach(() => {
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
});

describe('InboxPanel', () => {
  it('renders every fixture notification, newest first', () => {
    render(<InboxPanel />);

    const cards = screen.getAllByRole('button');
    expect(cards).toHaveLength(5);
    expect(cards[0]).toHaveTextContent('lead-form needs approval');
  });

  it('drops the unread styling when everything is marked read', async () => {
    render(<InboxPanel />);
    expect(screen.getAllByText('unread')).toHaveLength(3);

    await act(async () => {
      useHiveStore.getState().markAllRead();
    });

    expect(screen.queryByText('unread')).not.toBeInTheDocument();
  });

  it('shows a pushed notification at the top', async () => {
    render(<InboxPanel />);

    await act(async () => {
      useHiveStore.getState().pushNotif({
        icon: 'ph-chat-circle-dots',
        tone: 'amber',
        title: 'nplusone asked a question',
        sub: 'index or denormalise?',
        time: 'now',
        unread: true,
        target: 'nplusone',
      });
    });

    expect(screen.getAllByRole('button')[0]).toHaveTextContent(
      'nplusone asked a question',
    );
  });

  it('caps the rendered list at eight', async () => {
    render(<InboxPanel />);

    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        useHiveStore.getState().pushNotif({
          icon: 'ph-hand-palm',
          tone: 'amber',
          title: `extra ${i}`,
          sub: 'a subtitle',
          time: 'now',
          unread: true,
          target: 'lead-form',
        });
      }
    });

    expect(screen.getAllByRole('button')).toHaveLength(8);
  });

  it('jumps to the session a card names', async () => {
    const user = userEvent.setup();
    render(<InboxPanel />);

    await user.click(screen.getByText('call-notes asked a question'));

    expect(useUiStore.getState().activeTab).toBe('call-notes');
  });
});
