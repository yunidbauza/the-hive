import { render, screen } from '@testing-library/react';
import { act, createRef } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  CONSOLE_SPLIT_DEFAULT,
  FLEET_FLOOR_PX,
  FleetPane,
  TRANSCRIPT_FLOOR,
  consoleSplitBounds,
} from '@features/orchestrator/components/fleet-pane';
import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  useAppearanceStore,
} from '@stores/appearance-store';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

/**
 * The bounds are the part happy-dom can prove: pure arithmetic over a height.
 * What the height *is* comes from a ResizeObserver the setup file stubs to
 * silence, so the render below exercises the unmeasured branch and the
 * geometry is left to Playwright (`fleet-scroll.spec.ts`).
 */
describe('TRANSCRIPT_FLOOR', () => {
  it('spells one number two ways — the class center-stage paints, the pixels the bounds use', () => {
    // Tailwind's spacing scale: `min-h-40` is 10rem, 160px at the root size.
    expect(TRANSCRIPT_FLOOR.className).toBe('min-h-40');
    expect(TRANSCRIPT_FLOOR.px).toBe(40 * 4);
  });
});

describe('consoleSplitBounds', () => {
  it('is the store’s constants until the box has been measured', () => {
    expect(consoleSplitBounds(0, true)).toEqual({ min: MIN_SPLIT_RATIO, max: MAX_SPLIT_RATIO });
    expect(consoleSplitBounds(Number.NaN, true)).toEqual({
      min: MIN_SPLIT_RATIO,
      max: MAX_SPLIT_RATIO,
    });
  });

  it('is the store’s constants while the editor splits the stage', () => {
    // Both CSS floors are lifted there; a share is the only bound left.
    expect(consoleSplitBounds(560, false)).toEqual({ min: MIN_SPLIT_RATIO, max: MAX_SPLIT_RATIO });
  });

  it('caps the table so the transcript keeps its floor', () => {
    // A 560px box at the desktop's minimum window: 0.8 of it would leave the
    // transcript 112px against a 160px floor. The cap is where the floor is.
    const { min, max } = consoleSplitBounds(560, true);

    expect(max).toBeCloseTo((560 - TRANSCRIPT_FLOOR.px) / 560, 5);
    expect(max).toBeLessThan(MAX_SPLIT_RATIO);
    expect(min).toBe(MIN_SPLIT_RATIO);
  });

  it('floors the table at a header and two rows', () => {
    // A 400px box: 0.2 of it is 80px, under the table's 112px floor.
    const { min } = consoleSplitBounds(400, true);

    expect(min).toBeCloseTo(FLEET_FLOOR_PX / 400, 5);
    expect(min).toBeGreaterThan(MIN_SPLIT_RATIO);
  });

  it('collapses to the table’s floor rather than inverting when both cannot fit', () => {
    // 200px cannot hold 112 + 160. The range becomes a point, not a negative.
    const { min, max } = consoleSplitBounds(200, true);

    expect(max).toBe(min);
    expect(min).toBeCloseTo(FLEET_FLOOR_PX / 200, 5);
  });
});

describe('FleetPane', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    useAppearanceStore.getState().reset();
  });

  const renderPane = (floored = true) => {
    const container = createRef<HTMLDivElement>();
    const view = render(
      <div ref={container}>
        <FleetPane containerRef={container} floored={floored} />
      </div>,
    );
    return { ...view, container };
  };

  it('paints the stored share as the pane’s basis and the divider’s value', () => {
    renderPane();

    expect(screen.getByTestId('fleet-pane')).toHaveStyle({ flex: '0 1 50%' });
    const divider = screen.getByRole('slider', { name: 'Resize the fleet table' });
    expect(divider).toHaveAttribute('aria-valuenow', '50');

    act(() => useAppearanceStore.getState().setConsoleSplitRatio(0.3));

    expect(screen.getByTestId('fleet-pane')).toHaveStyle({ flex: '0 1 30%' });
    expect(divider).toHaveAttribute('aria-valuenow', '30');
  });

  it('caps the share at the content and lets it shrink to the share', () => {
    renderPane();

    expect(screen.getByTestId('fleet-pane')).toHaveClass('max-h-max', 'min-h-0');
  });

  it('puts the default back on double-click', () => {
    renderPane();
    act(() => useAppearanceStore.getState().setConsoleSplitRatio(0.7));

    act(() => {
      screen.getByRole('slider', { name: 'Resize the fleet table' }).dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }),
      );
    });

    expect(useAppearanceStore.getState().consoleSplitRatio).toBe(CONSOLE_SPLIT_DEFAULT);
  });

  it('hands the divider the unmeasured bounds under happy-dom', () => {
    // The observer stub never reports a size, so the bounds are the constants
    // — which is also the first frame in a browser.
    renderPane();

    const divider = screen.getByRole('slider', { name: 'Resize the fleet table' });
    expect(divider).toHaveAttribute('aria-valuemin', String(MIN_SPLIT_RATIO * 100));
    expect(divider).toHaveAttribute('aria-valuemax', String(MAX_SPLIT_RATIO * 100));
  });
});
