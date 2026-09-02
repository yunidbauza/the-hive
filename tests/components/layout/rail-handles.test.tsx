import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { RailHandles } from '@components/layout/rail-handles';
import { RAIL_MIN } from '@lib/rail-width';
import { useAppearanceStore } from '@stores/appearance-store';
import { useUiStore } from '@stores/ui-store';

/**
 * The rail drag handles (HIVE-105).
 *
 * Rendered on their own rather than through `AppShell`: they are a leaf
 * precisely so the shell does not re-render with them, and testing them through
 * the shell would mount thirteen surfaces to exercise two buttons.
 *
 * The container is stubbed the way `split-handle.test.tsx` stubs its own —
 * happy-dom performs no layout, so a real ref would measure zero and no drag
 * could be reported.
 */

const COMFORTABLE = RAIL_MIN.comfortable;

function renderHandles(rect = { left: 0, top: 0, width: 1920, height: 900 }) {
  const containerRef = createRef<HTMLElement>();
  const container = document.createElement('div');
  container.getBoundingClientRect = () =>
    ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }) as DOMRect;
  (containerRef as { current: HTMLElement | null }).current = container;

  render(<RailHandles containerRef={containerRef} />);

  return {
    left: () => screen.getByRole('slider', { name: 'Resize the navigation rail' }),
    right: () => screen.queryByRole('slider', { name: 'Resize the activity rail' }),
  };
}

beforeEach(() => {
  document.body.style.removeProperty('--cc-rail-w-left');
  document.body.style.removeProperty('--cc-rail-w-right');
  useAppearanceStore.getState().reset();
  useUiStore.setState({ showActivityRail: true });
  /*
    happy-dom reports 1024px, where 30% of the window is below the right rail's
    own minimum and neither rail can grow at all. A width the app would never
    open at is the wrong stage for testing the wiring.
  */
  window.innerWidth = 1920;
});

describe('RailHandles', () => {
  it('gives each rail a handle', () => {
    const handles = renderHandles();

    expect(handles.left()).toBeInTheDocument();
    expect(handles.right()).toBeInTheDocument();
  });

  /** No rail, nothing to resize. */
  it('drops the activity rail handle along with the rail', () => {
    useUiStore.setState({ showActivityRail: false });

    const handles = renderHandles();

    expect(handles.left()).toBeInTheDocument();
    expect(handles.right()).not.toBeInTheDocument();
  });

  it('announces each rail current width in pixels', () => {
    const handles = renderHandles();

    expect(handles.left()).toHaveAttribute('aria-valuenow', String(COMFORTABLE.left));
    expect(handles.left()).toHaveAttribute('aria-valuemin', String(COMFORTABLE.left));
  });

  /**
   * Overlays, not flex siblings — a handle in the flow would take a pixel from
   * the stage and shift every measurement in the shell by two, which is how a
   * browser test caught it.
   */
  it('positions itself on the rail edge without taking layout space', () => {
    const handles = renderHandles();

    expect(handles.left()).toHaveClass(
      'absolute',
      'left-[var(--cc-rail-w-left)]',
      'bg-transparent',
    );
    expect(handles.right()).toHaveClass('absolute', 'right-[var(--cc-rail-w-right)]');
  });

  it('stores a width dragged with the keyboard', async () => {
    const handles = renderHandles();

    handles.left().focus();
    await userEvent.keyboard('{ArrowRight}');

    expect(useAppearanceStore.getState().railWidthLeft).toBe(COMFORTABLE.left + 8);
  });

  /**
   * The activity rail grows leftwards, so its handle's arrows are inverted.
   * `ArrowLeft` widening it is the point — the seam moves left, the rail gets
   * bigger.
   */
  it('inverts the arrows for the activity rail', async () => {
    const handles = renderHandles();

    handles.right()?.focus();
    await userEvent.keyboard('{ArrowLeft}');

    expect(useAppearanceStore.getState().railWidthRight).toBe(COMFORTABLE.right + 8);
  });

  it('returns a rail to the stylesheet on a double-click', async () => {
    const handles = renderHandles();

    handles.left().focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(useAppearanceStore.getState().railWidthLeft).not.toBeNull();

    await userEvent.dblClick(handles.left());

    expect(useAppearanceStore.getState().railWidthLeft).toBeNull();
    expect(document.body.style.getPropertyValue('--cc-rail-w-left')).toBe('');
  });

  /**
   * Found in review. Below the window the defaults need, a rail is painted
   * under its own minimum; handing the handle the unreduced minimum made the
   * shrink key *grow* the rail and store a width nobody chose.
   */
  it('cannot be grown by the shrink key on a window too narrow for the defaults', async () => {
    /*
      Under `railFloorWindowWidth(COMFORTABLE)` — 795px — so the rail paints
      below its minimum, but not so far under that the painted width lands
      inside the 40px collapse band beneath it: at 700px the rail paints at
      281, one pixel over `collapseBelow`, and the shrink key *collapses* it,
      which is a different (and legitimate) outcome from the growth this
      guards against. 780 paints it at 313.
    */
    window.innerWidth = 780;
    const handles = renderHandles({ left: 0, top: 0, width: 780, height: 900 });

    const painted = Number(handles.left().getAttribute('aria-valuenow'));
    expect(painted).toBeLessThan(COMFORTABLE.left);

    handles.left().focus();
    await userEvent.keyboard('{ArrowLeft}');

    expect(useAppearanceStore.getState().railWidthLeft).toBeNull();
    expect(Number(handles.left().getAttribute('aria-valuenow'))).toBe(painted);
  });
});
