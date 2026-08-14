import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { Header } from '@components/layout/header';
import { useAppearanceStore } from '@stores/appearance-store';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

import { notif } from '../../support/notifications';
import { seedDemoFleet } from '@tests/support/demo-fleet';

/**
 * The header only composes — the three sub-components are asserted in their own
 * files. What is pinned here is the wiring: which zones are present, and what
 * the four controls do to the stores.
 */
describe('Header', () => {
  beforeEach(() => {
    document.body.removeAttribute('data-theme');
    localStorage.clear();
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    /**
     * Pinned to dark rather than left on the story-105 default of `system`.
     * `system` resolves against `prefers-color-scheme`, which the test
     * environment answers for us — so leaving it would make the header's label
     * depend on happy-dom's media-query default rather than on the header.
     */
    useAppearanceStore.getState().reset();
    useAppearanceStore.getState().setTheme('dark');
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
    expect(screen.getByText(/Opus 4.5 · high/)).toBeInTheDocument();
    expect(screen.getByText('4 working')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Switch to light theme' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Inbox — nothing unread/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'New session' }),
    ).toBeInTheDocument();
  });

  /**
   * happy-dom performs no layout, so "does it line up with the rail?" is
   * unanswerable here — `chip-alignment.spec.ts` measures the boxes in a real
   * browser. What unit tests can pin is the structure that produces the
   * alignment: **three** zones since HIVE-79 — brand-and-chips, the counts,
   * and a control cluster that claims the activity rail's width so the counts
   * beside it end on the rail's edge — plus a brand wrapper that claims the
   * left rail's width so the chips start on that one.
   */
  describe('rail-aligned zones', () => {
    it('lays out as three zones, with both chips in the left one', () => {
      useUiStore.setState({ activeTab: 'hero-refresh' });

      render(<Header />);

      const banner = screen.getByRole('banner');
      // Flex, not a grid: nothing is centred any more, so the equal-track
      // machinery that existed to find the true midpoint is gone.
      expect(banner).toHaveClass('flex');
      expect(banner).not.toHaveClass('grid');

      const [left, counts, controls] = Array.from(banner.children);
      expect(banner.children).toHaveLength(3);
      expect(left).toHaveTextContent('The Hive');
      expect(left).toHaveTextContent(/Opus 4.5 · high/);

      /*
        The counts are their own zone now, and the controls no longer contain
        them. That separation is the whole mechanism: the control cluster
        claims the rail's width, so the counts' right edge is the rail's line.
      */
      expect(counts).toHaveTextContent('4 working');
      expect(controls).not.toHaveTextContent('4 working');
      expect(controls).toHaveTextContent('New session');
    });

    /**
     * The header itself must carry no row gap, or every zone boundary would sit
     * 14px away from the line it is supposed to land on.
     */
    it('spaces its zones without a row gap', () => {
      render(<Header />);

      expect(screen.getByRole('banner')).not.toHaveClass('gap-[14px]');
    });

    it('gives the controls the activity rail’s width, so the counts end on its edge', () => {
      useUiStore.setState({ activeTab: 'hero-refresh' });

      render(<Header />);

      const controls = screen.getByRole('banner').children[2];
      // A calc over the token, not a literal: the rail is 316px comfortable and
      // 276px compact, and a hardcoded number would be wrong in one of them.
      expect(controls).toHaveClass('w-[calc(var(--cc-rail-w-right)-1rem)]');
    });

    /**
     * With the rail unmounted there is no border to align to, so the cluster
     * drops its width and the counts are simply flush right — the layout this
     * header had before HIVE-79.
     */
    it('drops that width when the activity rail is hidden', () => {
      useUiStore.setState({ showActivityRail: false });

      render(<Header />);

      const controls = screen.getByRole('banner').children[2];
      expect(controls).not.toHaveClass('w-[calc(var(--cc-rail-w-right)-1rem)]');
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
      expect(banner.children).toHaveLength(3);
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

      expect(useAppearanceStore.getState().theme).toBe('light');
      expect(document.body.getAttribute('data-theme')).toBe('light');
      expect(
        screen.getByRole('button', { name: 'Switch to dark theme' }),
      ).toBeInTheDocument();
    });
  });

  describe('inbox bell', () => {
    it('shows the exact unread count, and names it on the button itself', () => {
      useHiveStore
        .getState()
        .hydrateNotifs([
          notif({ id: 'a' }),
          notif({ id: 'b' }),
          notif({ id: 'c' }),
        ]);
      render(<Header />);

      expect(screen.getByText('3')).toBeInTheDocument();
      // The badge is decoration here; the button's label carries the meaning.
      expect(
        screen.getByRole('button', { name: 'Inbox — 3 unread' }),
      ).toBeInTheDocument();
    });

    /**
     * The bell **shows** the inbox and leaves the count alone (HIVE-93).
     *
     * It used to mark everything read, which is the one action that destroys the
     * information the badge carries — from a control whose icon promises
     * navigation. A user reaching for the bell to see what happened wiped the
     * record of what happened.
     */
    it('opens the Inbox tab without touching the unread count', async () => {
      const user = userEvent.setup();
      useUiStore.setState({ railTab: 'prs', showActivityRail: false });
      useHiveStore
        .getState()
        .hydrateNotifs([
          notif({ id: 'a' }),
          notif({ id: 'b' }),
          notif({ id: 'c' }),
        ]);
      render(<Header />);

      await user.click(screen.getByRole('button', { name: 'Inbox — 3 unread' }));

      expect(useUiStore.getState().railTab).toBe('inbox');
      // And it reveals the rail, or the tab it selected would be off screen.
      expect(useUiStore.getState().showActivityRail).toBe(true);

      // Nothing was read: the badge still says 3, and every row is still unread.
      expect(
        useHiveStore.getState().notifs.every((notif) => notif.unread),
      ).toBe(true);
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('still names itself when there is nothing unread', () => {
      render(<Header />);

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
