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

  /**
   * happy-dom performs no layout, so "does it line up with the rail?" is
   * unanswerable here — `chip-alignment.spec.ts` measures the boxes in a real
   * browser. What unit tests can pin is the structure that produces the
   * alignment: two zones, and a brand wrapper that claims the rail's width so
   * the chips beside it start on the rail's edge.
   */
  describe('left-aligned chips', () => {
    it('lays out as two zones, with both chips in the left one', () => {
      useUiStore.setState({ activeTab: 'hero-refresh' });

      render(<Header />);

      const banner = screen.getByRole('banner');
      // Flex, not a grid: nothing is centred any more, so the equal-track
      // machinery that existed to find the true midpoint is gone.
      expect(banner).toHaveClass('flex');
      expect(banner).not.toHaveClass('grid');

      const [left, controls] = Array.from(banner.children);
      expect(banner.children).toHaveLength(2);
      expect(left).toHaveTextContent('The Hive');
      expect(left).toHaveTextContent(/Opus 4.5 \(1M\)/);
      expect(controls).toHaveTextContent('4 working');
    });

    it('gives the brand exactly the rail’s width, so the chips start on its edge', () => {
      useUiStore.setState({ activeTab: 'hero-refresh' });

      render(<Header />);

      // 252px = the rail's 268px minus the header's own px-4. The real
      // geometry is measured in chip-alignment.spec.ts; this pins the
      // mechanism so a refactor cannot quietly drop it.
      const [left] = Array.from(screen.getByRole('banner').children);
      expect(left.firstElementChild).toHaveClass('w-[252px]', 'shrink-0');
    });

    /**
     * The chip is conditional on a session being active. In a flex row its
     * absence simply closes the gap — there is no empty track to keep, which
     * is the simplification that dropping the grid bought.
     */
    it('closes the gap when the chip is absent instead of leaving a hole', () => {
      render(<Header />);

      const banner = screen.getByRole('banner');
      expect(banner.children).toHaveLength(2);
      expect(banner.children[0]).toHaveTextContent('The Hive');
      expect(banner.children[0]).not.toHaveTextContent(/Opus 4.5/);
      expect(banner.children[1]).toHaveTextContent('4 working');
    });
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

  describe('the settings gear (story 101)', () => {
    it('offers a way into settings', () => {
      render(<Header />);

      expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    });

    it('opens settings when pressed', async () => {
      const user = userEvent.setup();
      render(<Header />);

      await user.click(screen.getByRole('button', { name: 'Settings' }));

      expect(useUiStore.getState().settings).toBe(true);
    });

    /**
     * The header is the window drag handle on desktop, so every control in it
     * needs the no-drag escape or it cannot be clicked at all.
     */
    it('is clickable despite sitting in the drag region', () => {
      render(<Header />);

      expect(
        screen.getByRole('button', { name: 'Settings' }).className,
      ).toContain('[-webkit-app-region:no-drag]');
    });
  });
});
