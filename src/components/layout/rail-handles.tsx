import type { RefObject } from 'react';

import { SplitHandle } from '@components/ui/split-handle';
import { useRailWidths } from '@hooks/use-rail-widths';
import { useResetRailWidth, useSetRailWidth } from '@stores/appearance-store';
import { useShowActivityRail } from '@stores/ui-store';

interface RailHandlesProps {
  /**
   * The shell row the rails live in — the ruler a rail's width is measured
   * against, and the element these position themselves inside.
   */
  containerRef: RefObject<HTMLElement | null>;
}

/**
 * The drag handles on the two rails' inner edges (HIVE-105).
 *
 * ## Why this is its own component
 *
 * Everything here changes on every `pointermove` of a drag. `app-shell` mounts
 * `LeftRail`, `CenterStage` and `ActivityRail`, none of them memoized, and
 * `center-stage.tsx` records that a render of it "costs a render of every
 * mounted surface" — so subscribing the shell itself to a live drag would have
 * made dragging a rail the most expensive gesture in the app, and would have
 * quietly broken the promise `applyRailWidths` makes about resizing a rail
 * without re-rendering anything. Keeping the subscription in a leaf keeps that
 * promise: the shell renders once, and this re-renders while you drag.
 *
 * ## Why the handles are overlays
 *
 * A 1px handle in the flex flow takes a pixel from the stage and shifts every
 * measurement in the shell by two. That is not hypothetical — it broke a
 * browser test asserting the console input re-measures on resize. As overlays
 * they consume no layout at all, so the geometry with this feature is identical
 * to the geometry before it.
 *
 * Each is addressed by the same custom property its rail is sized with, so a
 * handle can never drift from the edge it drags. `bg-transparent` because that
 * edge already draws a hairline — the rail's own border — and what these
 * contribute is the hit area and the hover colour, not the line.
 */
export function RailHandles({ containerRef }: RailHandlesProps) {
  const rails = useRailWidths();
  const showActivityRail = useShowActivityRail();
  const setRailWidth = useSetRailWidth();
  const resetRailWidth = useResetRailWidth();

  return (
    <>
      <SplitHandle
        axis="vertical"
        containerRef={containerRef}
        label="Resize the navigation rail"
        value={rails.left.value}
        onValue={(width) => setRailWidth('left', width)}
        onReset={() => resetRailWidth('left')}
        scale="px-from-start"
        min={rails.left.min}
        max={rails.left.max}
        className="absolute inset-y-0 left-[var(--cc-rail-w-left)] bg-transparent"
      />

      {showActivityRail ? (
        <SplitHandle
          axis="vertical"
          containerRef={containerRef}
          label="Resize the activity rail"
          value={rails.right.value}
          onValue={(width) => setRailWidth('right', width)}
          onReset={() => resetRailWidth('right')}
          scale="px-from-end"
          min={rails.right.min}
          max={rails.right.max}
          className="absolute inset-y-0 right-[var(--cc-rail-w-right)] bg-transparent"
        />
      ) : null}
    </>
  );
}
