import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '@components/layout/app-shell';
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
   * Only that they are mounted, and mounted as overlays. Their wiring belongs
   * to `rail-handles.test.tsx` — they are a leaf specifically so this shell
   * does not re-render with them, and re-testing them here would assert the
   * same behaviour through thirteen extra surfaces.
   */
  it('mounts a resize handle for each rail', () => {
    render(<AppShell />);

    expect(
      screen.getByRole('slider', { name: 'Resize the navigation rail' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('slider', { name: 'Resize the activity rail' }),
    ).toBeInTheDocument();
  });

  /**
   * The handles take no layout space, so the three regions measure exactly as
   * they did before they existed. Asserted here rather than in the leaf's own
   * suite because it is a fact about the row, not about the buttons.
   */
  it('keeps the rail row a three-item flex layout', () => {
    render(<AppShell />);

    const row = screen.getByRole('main').parentElement;
    expect(row).toHaveClass('relative', 'flex');

    /*
      The two *rail* handles, by name. The stage mounts a slider of its own —
      the overmind's fleet-table divider — which is in-flow between two panes
      by design and is not what this asserts.
    */
    for (const name of ['Resize the navigation rail', 'Resize the activity rail']) {
      expect(screen.getByRole('slider', { name })).toHaveClass('absolute');
    }
  });
});
