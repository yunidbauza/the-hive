import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SplitHandle, type SplitScale } from '@components/ui/split-handle';

/**
 * The draggable seam.
 *
 * The container's geometry is stubbed rather than laid out — happy-dom performs
 * no layout, so every `getBoundingClientRect` is zero and a drag would divide by
 * it. What is under test is the arithmetic and the listener lifecycle, both of
 * which are independent of real measurement.
 */

interface Options {
  scale?: SplitScale;
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  onReset?: () => void;
  rect?: { left: number; top: number; width: number; height: number };
}

function renderHandle(
  axis: 'horizontal' | 'vertical',
  onValue = vi.fn(),
  {
    scale,
    value = scale && scale !== 'ratio' ? 200 : 0.5,
    min,
    max,
    step,
    onReset,
    rect = { left: 100, top: 50, width: 400, height: 200 },
  }: Options = {},
) {
  const containerRef = createRef<HTMLElement>();
  const container = document.createElement('div');
  container.getBoundingClientRect = () =>
    ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }) as DOMRect;
  (containerRef as { current: HTMLElement | null }).current = container;

  render(
    <SplitHandle
      axis={axis}
      containerRef={containerRef}
      label="Resize the editor"
      value={value}
      onValue={onValue}
      scale={scale}
      min={min}
      max={max}
      step={step}
      onReset={onReset}
    />,
  );

  return { onValue, handle: screen.getByRole('slider') };
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

  it('labels itself with what it resizes', () => {
    const { handle } = renderHandle('vertical');
    expect(handle).toHaveAccessibleName('Resize the editor');
  });

  it('reports the ratio along X for a vertical divider', () => {
    const { handle, onValue } = renderHandle('vertical');

    fireEvent.pointerDown(handle);
    fireEvent.pointerMove(window, { clientX: 300, clientY: 0 });

    // (300 - 100) / 400
    expect(onValue).toHaveBeenCalledWith(0.5);
  });

  it('reports the ratio along Y for a horizontal divider', () => {
    const { handle, onValue } = renderHandle('horizontal');

    fireEvent.pointerDown(handle);
    fireEvent.pointerMove(window, { clientX: 0, clientY: 100 });

    // (100 - 50) / 200
    expect(onValue).toHaveBeenCalledWith(0.25);
  });

  /**
   * The gesture ends with the pointer, not with the element. A move after
   * `pointerup` that still resized would mean the window kept following the
   * cursor after the user let go.
   */
  it('stops tracking on pointerup', () => {
    const { handle, onValue } = renderHandle('vertical');

    fireEvent.pointerDown(handle);
    fireEvent.pointerUp(window);
    onValue.mockClear();
    fireEvent.pointerMove(window, { clientX: 300 });

    expect(onValue).not.toHaveBeenCalled();
  });

  /**
   * The OS takes the pointer away on a three-finger swipe or a window drag.
   * Without this the move listener survives the gesture and keeps resizing on
   * the next unrelated mouse movement.
   */
  it('stops tracking on pointercancel', () => {
    const { handle, onValue } = renderHandle('vertical');

    fireEvent.pointerDown(handle);
    fireEvent.pointerCancel(window);
    onValue.mockClear();
    fireEvent.pointerMove(window, { clientX: 300 });

    expect(onValue).not.toHaveBeenCalled();
  });

  it('does nothing when the container has no size', () => {
    const { handle, onValue } = renderHandle('vertical', vi.fn(), {
      rect: { left: 0, top: 0, width: 0, height: 0 },
    });

    fireEvent.pointerDown(handle);
    fireEvent.pointerMove(window, { clientX: 300 });

    expect(onValue).not.toHaveBeenCalled();
  });

  /**
   * A split a mouse can move and a keyboard cannot is a setting only some users
   * have.
   */
  it('moves with the arrow keys along its own axis', async () => {
    const onValue = vi.fn();
    const { handle } = renderHandle('vertical', onValue);

    handle.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onValue).toHaveBeenLastCalledWith(0.52);

    await userEvent.keyboard('{ArrowLeft}');
    expect(onValue).toHaveBeenLastCalledWith(0.48);
  });

  it('uses up and down for a horizontal divider', async () => {
    const onValue = vi.fn();
    const { handle } = renderHandle('horizontal', onValue);

    handle.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(onValue).toHaveBeenLastCalledWith(0.52);

    await userEvent.keyboard('{ArrowUp}');
    expect(onValue).toHaveBeenLastCalledWith(0.48);
  });

  it('ignores the perpendicular arrows', async () => {
    const onValue = vi.fn();
    const { handle } = renderHandle('vertical', onValue);

    handle.focus();
    await userEvent.keyboard('{ArrowUp}{ArrowDown}');

    expect(onValue).not.toHaveBeenCalled();
  });

  /**
   * The pixel scales (HIVE-105).
   *
   * Same gesture, same listeners, different arithmetic — which is the whole
   * reason the rails reuse this component instead of copying it.
   */
  describe('pixel scales', () => {
    it('reports distance from the start edge for a left-pinned pane', () => {
      const { handle, onValue } = renderHandle('vertical', vi.fn(), {
        scale: 'px-from-start',
      });

      fireEvent.pointerDown(handle);
      fireEvent.pointerMove(window, { clientX: 400 });

      // 400 - 100
      expect(onValue).toHaveBeenCalledWith(300);
    });

    /**
     * The activity rail grows as the pointer moves *left*, so its width is the
     * distance from the far edge. Getting this the intuitive way round gives a
     * rail that shrinks while you drag it outwards.
     */
    it('reports distance from the end edge for a right-pinned pane', () => {
      const { handle, onValue } = renderHandle('vertical', vi.fn(), {
        scale: 'px-from-end',
      });

      fireEvent.pointerDown(handle);
      fireEvent.pointerMove(window, { clientX: 400 });

      // 400 wide, pointer 300 in from the left → 100 from the right
      expect(onValue).toHaveBeenCalledWith(100);
    });

    it('announces pixels rather than a percentage', () => {
      const { handle } = renderHandle('vertical', vi.fn(), {
        scale: 'px-from-start',
        value: 268,
        min: 268,
        max: 520,
      });

      expect(handle).toHaveAttribute('aria-valuenow', '268');
      expect(handle).toHaveAttribute('aria-valuemin', '268');
      expect(handle).toHaveAttribute('aria-valuemax', '520');
    });

    /** An unbounded max is no bound at all, and announcing `0` would be a lie. */
    it('omits an unbounded maximum instead of announcing it as zero', () => {
      const { handle } = renderHandle('vertical', vi.fn(), {
        scale: 'px-from-start',
      });

      expect(handle).not.toHaveAttribute('aria-valuemax');
    });

    it('holds the drag inside its bounds', () => {
      const { handle, onValue } = renderHandle('vertical', vi.fn(), {
        scale: 'px-from-start',
        min: 268,
        max: 340,
      });

      fireEvent.pointerDown(handle);

      fireEvent.pointerMove(window, { clientX: 500 });
      expect(onValue).toHaveBeenLastCalledWith(340);

      fireEvent.pointerMove(window, { clientX: 120 });
      expect(onValue).toHaveBeenLastCalledWith(268);
    });

    /**
     * Inverted with the scale, for the same reason the drag is: `ArrowRight`
     * must move the seam right, which makes a right-pinned pane narrower.
     */
    it('inverts the arrow keys for a right-pinned pane', async () => {
      const onValue = vi.fn();
      const { handle } = renderHandle('vertical', onValue, {
        scale: 'px-from-end',
        value: 316,
        min: 200,
        max: 520,
        step: 8,
      });

      handle.focus();
      await userEvent.keyboard('{ArrowRight}');
      expect(onValue).toHaveBeenLastCalledWith(308);

      await userEvent.keyboard('{ArrowLeft}');
      expect(onValue).toHaveBeenLastCalledWith(324);
    });

    it('steps in pixels rather than in hundredths', async () => {
      const onValue = vi.fn();
      const { handle } = renderHandle('vertical', onValue, {
        scale: 'px-from-start',
        value: 268,
        min: 268,
        max: 520,
        step: 8,
      });

      handle.focus();
      await userEvent.keyboard('{ArrowRight}');
      expect(onValue).toHaveBeenLastCalledWith(276);
    });
  });

  describe('reset', () => {
    it('calls back on a double-click when it has a default to return to', async () => {
      const onReset = vi.fn();
      const { handle } = renderHandle('vertical', vi.fn(), {
        scale: 'px-from-start',
        onReset,
      });

      await userEvent.dblClick(handle);

      expect(onReset).toHaveBeenCalledOnce();
    });

    /** The editor's divider passes none, and must not break on the gesture. */
    it('survives a double-click with no handler', async () => {
      const { handle } = renderHandle('vertical');

      await userEvent.dblClick(handle);

      expect(handle).toBeInTheDocument();
    });
  });
});
