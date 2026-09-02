import { useLayoutEffect, useState, type RefObject } from 'react';

import { SplitHandle } from '@components/ui/split-handle';
import { SessionTable } from '@features/orchestrator/components/session-table';
import {
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  useConsoleSplitRatio,
  useSetConsoleSplitRatio,
} from '@stores/appearance-store';

/** Where a double-click on the divider puts the table back. */
export const CONSOLE_SPLIT_DEFAULT = 0.5;

/**
 * The transcript's floor, in pixels and as the class `center-stage.tsx` paints
 * it with — `min-h-40` is 10rem, 160px at the root size the app never changes.
 *
 * Two spellings of one number, kept side by side so that a reader changing
 * the class sees the constant it has to move with. The class is what stops a
 * window resize squeezing the transcript out; the number is what stops the
 * *divider* from being dragged into the same place — {@link consoleSplitBounds}
 * turns it into the largest share the table may claim.
 */
export const TRANSCRIPT_FLOOR = { px: 160, className: 'min-h-40' } as const;

/**
 * The table's floor: a header and two rows at the console's type size. The
 * divider will not go under it, so the table never becomes a heading with
 * nothing to head.
 */
export const FLEET_FLOOR_PX = 112;

/**
 * The range the divider may move through, in the container it is measured
 * against.
 *
 * The stored ratio is bounded once, by `clampSplitRatio`, to `0.2–0.8` — and a
 * bound stated in shares cannot know about floors stated in pixels. At the
 * desktop's minimum window the panes' box is roughly 560px tall, so `0.8` of it
 * leaves the transcript 112px against its 160px floor: CSS holds the floor, the
 * pane simply stops growing, and a divider driven to `0.8` announces a value
 * nothing on screen reflects — with a dead zone on the way back until the
 * pointer re-crosses the height that was actually painted. `use-rail-widths.ts`
 * documents the same divergence for the rails and closes it the same way: the
 * bounds follow the paint.
 *
 * `floored` is false while the editor splits the stage. Both CSS floors are
 * lifted there — a 20% column cannot hold them — so the shares are the only
 * bounds left, and the pure constants are the honest answer. So are they for a
 * height that has not been measured yet: the first frame, and every unit test.
 *
 * When even the two floors do not fit, the range collapses to the table's
 * floor rather than inverting — the same "no room to move" answer the rails
 * give at a window too narrow for their minimums.
 */
export function consoleSplitBounds(
  height: number,
  floored: boolean,
): { min: number; max: number } {
  if (!floored || !Number.isFinite(height) || height <= 0) {
    return { min: MIN_SPLIT_RATIO, max: MAX_SPLIT_RATIO };
  }

  const min = Math.max(MIN_SPLIT_RATIO, FLEET_FLOOR_PX / height);
  const max = Math.min(MAX_SPLIT_RATIO, (height - TRANSCRIPT_FLOOR.px) / height);

  return { min, max: Math.max(min, max) };
}

interface FleetPaneProps {
  /**
   * The box the table and the transcript divide — the pane's `flex-basis` is
   * a share of it, and so is the divider's reading. Owned by `center-stage`,
   * because it also holds the terminal region this component never touches.
   */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Whether the two pixel floors are in force — false while the editor splits the stage. */
  floored: boolean;
}

/**
 * The fleet table's share of the overmind, and the divider that sets it.
 *
 * ## Why a leaf, and not markup in `center-stage.tsx`
 *
 * The ratio changes on every `pointermove` of a drag. `CenterStage` renders
 * `TerminalHost` and with it every live `TerminalSurface`, none of them
 * memoized — the file says so itself, and names that cost as the reason it
 * must not subscribe to anything that changes often. A drag that re-rendered
 * thirteen terminals per frame would have been the most expensive gesture in
 * the app. So the subscription lives here, in a component that renders one
 * table and one hairline, and the stage passes down two things that do not
 * change during a drag: the container and whether the floors apply.
 *
 * ## The basis is a share, capped at the content
 *
 * `flex: 0 1 <ratio>%` gives the table its share; `max-h-max` stops it taking
 * a share it has nothing to fill. Without the cap a fresh launch — a header
 * and one line saying the fleet is empty — painted half a column of table
 * ground over nothing, and the transcript got the other half for no reason.
 * With it a short fleet is content-sized, exactly as the table was before it
 * had a divider, and a long one stops at the ratio and scrolls. The divider
 * then means "how much the table may take", which is the only thing a reader
 * can want it to mean while the fleet is short.
 *
 * `min-h-0` stays, and is not optional: a flex item's automatic minimum is its
 * content, and this pane's content is a scroll container whose *content* is
 * the whole fleet. Without it the pane would refuse to shrink to its share and
 * the table would never scroll.
 *
 * ## What is painted is the bounded value, not the stored one
 *
 * The store keeps intent, as it does for the rails: a ratio chosen on a tall
 * window survives a short one and comes back when the window does. What the
 * pane and the divider use is that intent held to {@link consoleSplitBounds},
 * so the slider never announces a value past its own maximum and the basis
 * never asks for a share the floors would refuse.
 */
export function FleetPane({ containerRef, floored }: FleetPaneProps) {
  const ratio = useConsoleSplitRatio();
  const setRatio = useSetConsoleSplitRatio();

  /*
    The container's height, mirrored into state because nothing else will say
    when it changes. `useLayoutEffect` so the first bounded paint is the first
    paint. The observer stub in `tests/setup.ts` never calls back, so under a
    unit test this stays `0` and the bounds are the constants — which
    `consoleSplitBounds` treats as "unmeasured" on purpose.
  */
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const container = containerRef.current;

    if (container === null || typeof ResizeObserver === 'undefined') return undefined;

    const measure = () => {
      setHeight(container.getBoundingClientRect().height);
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [containerRef]);

  const { min, max } = consoleSplitBounds(height, floored);
  const painted = Math.min(max, Math.max(min, ratio));

  return (
    <>
      <div
        data-testid="fleet-pane"
        className="flex min-h-0 max-h-max flex-col bg-term-bg"
        style={{ flex: `0 1 ${painted * 100}%` }}
      >
        <SessionTable />
      </div>
      <SplitHandle
        axis="horizontal"
        containerRef={containerRef}
        label="Resize the fleet table"
        value={painted}
        onValue={setRatio}
        min={min}
        max={max}
        onReset={() => setRatio(CONSOLE_SPLIT_DEFAULT)}
      />
    </>
  );
}
