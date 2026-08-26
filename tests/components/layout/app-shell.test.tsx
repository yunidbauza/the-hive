import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RAIL_MIN } from '@lib/rail-width';
import { AppShell } from '@components/layout/app-shell';
import { useAppearanceStore } from '@stores/appearance-store';
import { useUiStore } from '@stores/ui-store';

vi.mock('@xterm/xterm');
vi.mock('@xterm/addon-fit');

describe('AppShell', () => {
  beforeEach(() => {
    useUiStore.getState().reset();
  });

  it('renders all four regions', () => {
    render(<AppShell />);

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(
      screen.getByRole('navigation', { name: 'Projects, work, and agents' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(
      screen.getByRole('complementary', { name: 'Activity' }),
    ).toBeInTheDocument();
  });

  it('removes the activity rail from the tree when it is hidden', () => {
    useUiStore.setState({ showActivityRail: false });

    render(<AppShell />);

    expect(
      screen.queryByRole('complementary', { name: 'Activity' }),
    ).not.toBeInTheDocument();
    // The other three regions are unaffected.
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  /**
   * The `min-*: 0` overrides are the whole layout. A flex item defaults to
   * `min-height: auto` / `min-width: auto` and refuses to shrink below its
   * content, which would push the rails past the viewport and let a long
   * terminal line widen the center column — the trap story 020 calls out.
   * happy-dom does no layout, so assert the contract on the class list.
   */
  it('keeps the flex children shrinkable', () => {
    const { container } = render(<AppShell />);

    const row = container.querySelector('div > div.flex.min-h-0');
    expect(row).not.toBeNull();
    expect(row).toHaveClass('min-h-0', 'flex-1');

    expect(screen.getByRole('main')).toHaveClass('min-w-0', 'flex-1');
  });

  it('pins the rails to a fixed width so the center column absorbs resizes', () => {
    render(<AppShell />);

    // The width is a custom property from story 105 so density can change it,
    // but it is still a *fixed* width: neither rail flexes, which is what makes
    // the center column absorb every resize.
    expect(
      screen.getByRole('navigation', { name: 'Projects, work, and agents' }),
    ).toHaveClass('w-[var(--cc-rail-w-left)]', 'shrink-0');
    expect(screen.getByRole('complementary', { name: 'Activity' })).toHaveClass(
      'w-[var(--cc-rail-w-right)]',
      'shrink-0',
    );
  });

  it('gives each rail its own scrollbar rather than scrolling the page', () => {
    render(<AppShell />);

    // Both rails delegate scrolling to their tab panel — the left rail since
    // story 030, the activity rail since 050 — so neither tab bar can be
    // scrolled off-screen by a long list beneath it.
    const panels = screen.getAllByRole('tabpanel');
    expect(panels).toHaveLength(2);
    for (const panel of panels) {
      expect(panel).toHaveClass('overflow-y-auto');
    }
  });

  /**
   * The rail drag handles (HIVE-105).
   *
   * Mounted here rather than inside either rail, because a rail's width is a
   * distance from an edge of this row and the row is the only thing that can
   * measure it. The clamp itself is proved in `tests/lib/rail-width.test.ts`;
   * what these cover is that the wiring reaches the store at all.
   */
  describe('rail resize handles', () => {
    beforeEach(() => {
      document.body.style.removeProperty('--cc-rail-w-left');
      document.body.style.removeProperty('--cc-rail-w-right');
      useAppearanceStore.getState().reset();
      /*
        happy-dom reports 1024px, where 30% of the window is *below* the right
        rail's own minimum and neither rail can grow at all. A width the app
        would never open at is the wrong stage for testing the wiring.
      */
      window.innerWidth = 1920;
    });

    const handles = () => ({
      left: screen.getByRole('slider', { name: 'Resize the navigation rail' }),
      right: screen.queryByRole('slider', { name: 'Resize the activity rail' }),
    });

    it('gives each rail a handle', () => {
      render(<AppShell />);

      expect(handles().left).toBeInTheDocument();
      expect(handles().right).toBeInTheDocument();
    });

    /** No rail, nothing to resize. */
    it('drops the activity rail handle along with the rail', () => {
      useUiStore.setState({ showActivityRail: false });

      render(<AppShell />);

      expect(handles().left).toBeInTheDocument();
      expect(handles().right).not.toBeInTheDocument();
    });

    it('announces each rail current width in pixels', () => {
      render(<AppShell />);

      expect(handles().left).toHaveAttribute('aria-valuenow', String(RAIL_MIN.comfortable.left));
      expect(handles().left).toHaveAttribute('aria-valuemin', String(RAIL_MIN.comfortable.left));
    });

    it('stores a width dragged with the keyboard', async () => {
      render(<AppShell />);

      handles().left.focus();
      await userEvent.keyboard('{ArrowRight}');

      expect(useAppearanceStore.getState().railWidthLeft).toBe(
        RAIL_MIN.comfortable.left + 8,
      );
    });

    /**
     * The activity rail grows leftwards, so its handle's arrows are inverted.
     * `ArrowLeft` widening it is the point — the seam moves left, the rail gets
     * bigger.
     */
    it('inverts the arrows for the activity rail', async () => {
      render(<AppShell />);

      const right = handles().right;
      right?.focus();
      await userEvent.keyboard('{ArrowLeft}');

      expect(useAppearanceStore.getState().railWidthRight).toBe(
        RAIL_MIN.comfortable.right + 8,
      );
    });

    it('returns a rail to the stylesheet on a double-click', async () => {
      render(<AppShell />);

      handles().left.focus();
      await userEvent.keyboard('{ArrowRight}');
      expect(useAppearanceStore.getState().railWidthLeft).not.toBeNull();

      await userEvent.dblClick(handles().left);

      expect(useAppearanceStore.getState().railWidthLeft).toBeNull();
      expect(document.body.style.getPropertyValue('--cc-rail-w-left')).toBe('');
    });
  });
});
