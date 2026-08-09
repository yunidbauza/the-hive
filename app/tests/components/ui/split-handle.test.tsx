import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SplitHandle } from '@components/ui/split-handle';

/**
 * The draggable seam.
 *
 * The container's geometry is stubbed rather than laid out — happy-dom performs
 * no layout, so every `getBoundingClientRect` is zero and a drag would divide by
 * it. What is under test is the arithmetic and the listener lifecycle, both of
 * which are independent of real measurement.
 */

function renderHandle(
  axis: 'horizontal' | 'vertical',
  onRatio = vi.fn(),
  rect = { left: 100, top: 50, width: 400, height: 200 },
) {
  const containerRef = createRef<HTMLElement>();
  const container = document.createElement('div');
  container.getBoundingClientRect = () =>
    ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }) as DOMRect;
  (containerRef as { current: HTMLElement | null }).current = container;

  render(
    <SplitHandle axis={axis} containerRef={containerRef} ratio={0.5} onRatio={onRatio} />,
  );

  return { onRatio, handle: screen.getByRole('slider') };
}

describe('SplitHandle', () => {
  /**
   * `aria-orientation` on a slider names the direction the **value moves**, not
   * the direction the divider is drawn. A vertical divider is dragged left and
   * right, so it announces `horizontal` — the opposite of the prop name, and
   * the same direction as the arrow keys that actually work.
   */
  it('announces the axis its value moves along, not the line it draws', () => {
    const { handle } = renderHandle('vertical');

    expect(handle).toHaveAttribute('aria-orientation', 'horizontal');
    expect(handle).toHaveAttribute('aria-valuenow', '50');
    expect(handle).toHaveAttribute('aria-valuemin', '0');
    expect(handle).toHaveAttribute('aria-valuemax', '100');
  });

  it('announces the other way round for a stacked split', () => {
    const { handle } = renderHandle('horizontal');
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('reports the ratio along X for a vertical divider', () => {
    const { handle, onRatio } = renderHandle('vertical');

    fireEvent.pointerDown(handle);
    fireEvent.pointerMove(window, { clientX: 300, clientY: 0 });

    // (300 - 100) / 400
    expect(onRatio).toHaveBeenCalledWith(0.5);
  });

  it('reports the ratio along Y for a horizontal divider', () => {
    const { handle, onRatio } = renderHandle('horizontal');

    fireEvent.pointerDown(handle);
    fireEvent.pointerMove(window, { clientX: 0, clientY: 100 });

    // (100 - 50) / 200
    expect(onRatio).toHaveBeenCalledWith(0.25);
  });

  /**
   * The gesture ends with the pointer, not with the element. A move after
   * `pointerup` that still resized would mean the window kept following the
   * cursor after the user let go.
   */
  it('stops tracking on pointerup', () => {
    const { handle, onRatio } = renderHandle('vertical');

    fireEvent.pointerDown(handle);
    fireEvent.pointerUp(window);
    onRatio.mockClear();
    fireEvent.pointerMove(window, { clientX: 300 });

    expect(onRatio).not.toHaveBeenCalled();
  });

  /**
   * The OS takes the pointer away on a three-finger swipe or a window drag.
   * Without this the move listener survives the gesture and keeps resizing on
   * the next unrelated mouse movement.
   */
  it('stops tracking on pointercancel', () => {
    const { handle, onRatio } = renderHandle('vertical');

    fireEvent.pointerDown(handle);
    fireEvent.pointerCancel(window);
    onRatio.mockClear();
    fireEvent.pointerMove(window, { clientX: 300 });

    expect(onRatio).not.toHaveBeenCalled();
  });

  it('does nothing when the container has no size', () => {
    const { handle, onRatio } = renderHandle('vertical', vi.fn(), {
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });

    fireEvent.pointerDown(handle);
    fireEvent.pointerMove(window, { clientX: 300 });

    expect(onRatio).not.toHaveBeenCalled();
  });

  /**
   * A split a mouse can move and a keyboard cannot is a setting only some users
   * have.
   */
  it('moves with the arrow keys along its own axis', async () => {
    const onRatio = vi.fn();
    const { handle } = renderHandle('vertical', onRatio);

    handle.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onRatio).toHaveBeenLastCalledWith(0.52);

    await userEvent.keyboard('{ArrowLeft}');
    expect(onRatio).toHaveBeenLastCalledWith(0.48);
  });

  it('uses up and down for a horizontal divider', async () => {
    const onRatio = vi.fn();
    const { handle } = renderHandle('horizontal', onRatio);

    handle.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(onRatio).toHaveBeenLastCalledWith(0.52);

    await userEvent.keyboard('{ArrowUp}');
    expect(onRatio).toHaveBeenLastCalledWith(0.48);
  });

  it('ignores the perpendicular arrows', async () => {
    const onRatio = vi.fn();
    const { handle } = renderHandle('vertical', onRatio);

    handle.focus();
    await userEvent.keyboard('{ArrowUp}{ArrowDown}');

    expect(onRatio).not.toHaveBeenCalled();
  });
});
