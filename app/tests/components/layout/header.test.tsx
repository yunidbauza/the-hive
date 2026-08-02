import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { Header } from '@components/layout/header';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

/**
 * The header only composes — the three sub-components are asserted in their own
 * files. What is pinned here is the wiring: which zones are present, and what
 * the four controls do to the stores.
 */
describe('Header', () => {
  beforeEach(() => {
    document.body.removeAttribute('data-theme');
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
  });

  it('renders as the page banner at the fixed 56px height', () => {
    render(<Header />);

    const banner = screen.getByRole('banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveClass('h-14', 'shrink-0');
  });

  it('composes every zone', () => {
    useUiStore.setState({ activeTab: 'hero-refresh' });

    render(<Header />);

    expect(screen.getByText('The Hive')).toBeInTheDocument();
    expect(screen.getByText(/Opus 4.5 \(1M\)/)).toBeInTheDocument();
    expect(screen.getByText('4 working')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Switch to light theme' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Mark 3 unread/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'New session' }),
    ).toBeInTheDocument();
  });

  it('drops the model chip on the orchestrator tab but keeps everything else', () => {
    render(<Header />);

    expect(screen.queryByText(/Opus 4.5/)).not.toBeInTheDocument();
    expect(screen.getByText('The Hive')).toBeInTheDocument();
    expect(screen.getByText('4 working')).toBeInTheDocument();
  });

  describe('theme toggle', () => {
    it('offers the opposite theme and flips it', async () => {
      const user = userEvent.setup();
      render(<Header />);

      await user.click(
        screen.getByRole('button', { name: 'Switch to light theme' }),
      );

      expect(useUiStore.getState().theme).toBe('light');
      expect(document.body.getAttribute('data-theme')).toBe('light');
      expect(
        screen.getByRole('button', { name: 'Switch to dark theme' }),
      ).toBeInTheDocument();
    });
  });

  describe('inbox bell', () => {
    it('shows the exact unread count, and names it on the button itself', () => {
      render(<Header />);

      expect(screen.getByText('3')).toBeInTheDocument();
      // The badge is decoration here; the button's label carries the meaning.
      expect(
        screen.getByRole('button', {
          name: 'Mark 3 unread notifications as read',
        }),
      ).toBeInTheDocument();
    });

    it('marks everything read and hides the badge at zero', async () => {
      const user = userEvent.setup();
      render(<Header />);

      await user.click(screen.getByRole('button', { name: /Mark 3 unread/ }));

      expect(
        useHiveStore.getState().notifs.every((notif) => !notif.unread),
      ).toBe(true);
      expect(screen.queryByText('3')).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Inbox — nothing unread' }),
      ).toBeInTheDocument();
    });
  });

  describe('New session', () => {
    it('opens the picker', async () => {
      const user = userEvent.setup();
      render(<Header />);

      await user.click(screen.getByRole('button', { name: 'New session' }));

      expect(useUiStore.getState().picker).toBe(true);
    });

    it('clears any stale query as it opens', async () => {
      const user = userEvent.setup();
      useUiStore.setState({ pickerQuery: 'apfm' });
      render(<Header />);

      await user.click(screen.getByRole('button', { name: 'New session' }));

      expect(useUiStore.getState().pickerQuery).toBe('');
    });
  });
});
