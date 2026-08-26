import { useEffect, useRef } from 'react';

import { ActivityRail } from '@components/layout/activity-rail';
import { CenterStage } from '@components/layout/center-stage';
import { Header } from '@components/layout/header';
import { LeftRail } from '@components/layout/left-rail';
import { TitleBar } from '@components/layout/title-bar';
import { SplitHandle } from '@components/ui/split-handle';
import { useProjectWatcher } from '@features/explorer/hooks/use-project-watcher';
import { useSessionStatus } from '@features/sessions/hooks/use-session-status';
import { useNotificationActivate } from '@features/settings/hooks/use-notification-activate';
import { useForegroundSession } from '@hooks/use-foreground-session';
import { useNotificationStream } from '@hooks/use-notification-stream';
import { useRailWidths } from '@hooks/use-rail-widths';
import {
  useResetRailWidth,
  useSetRailWidth,
  watchSystemTheme,
} from '@stores/appearance-store';
import { useShowActivityRail } from '@stores/ui-store';

/**
 * The fixed three-column command-center chrome.
 *
 * Header on top, then a single row that fills the rest of the viewport:
 * navigation left, terminal center, activity right. Nothing here scrolls — the
 * three regions own their own scrollbars, so the terminal keeps a stable size
 * no matter how much lands in the rails.
 *
 * Two `min-*: 0` overrides carry the whole layout:
 *
 * - `min-h-0` on the row, because a flex item's default `min-height: auto`
 *   refuses to shrink below its content and would push the rails past the
 *   viewport instead of scrolling them.
 * - `min-w-0` on the center stage, for the same reason on the inline axis. Skip
 *   it and a long unbroken terminal line widens the column, which xterm's fit
 *   addon then measures and grows into — the classic flexbox overflow trap the
 *   story calls out.
 *
 * The rails size themselves and never flex, so the center column absorbs every
 * width change and the document never gains a horizontal scrollbar. Since
 * HIVE-105 their width is also draggable — but only between bounds that
 * guarantee the stage a fifth of the window, so the sentence above still holds:
 * whatever the rails do, the stage takes the remainder and there is always a
 * remainder. See `@lib/rail-width`.
 */
export function AppShell() {
  const showActivityRail = useShowActivityRail();

  /*
    Rail widths (HIVE-105). Here rather than in either rail for the reason every
    other subscription in this file is here: it depends on facts from two stores
    and the window, it writes to `<body>`, and one writer is the whole point.
  */
  const railRef = useRef<HTMLDivElement>(null);
  const rails = useRailWidths();
  const setRailWidth = useSetRailWidth();
  const resetRailWidth = useResetRailWidth();

  /**
   * One subscription for every real session's status (story 096).
   *
   * Here rather than per session: `session:status` is a single broadcast
   * channel, so a per-session hook would mean thirteen listeners racing to
   * ignore twelve messages each.
   */
  useSessionStatus();

  /**
   * Open the session a clicked OS notification was about (story 106).
   *
   * Here for the same reason as above — one broadcast channel, one listener —
   * and at the composition root because the tab it opens can be any of them.
   */
  useNotificationActivate();
  /*
    The inbox's feed (HIVE-75). Mounted here rather than in the panel: the
    unread badge on the rail's tab has to be right whether or not the Inbox tab
    has ever been opened, and a subscription that only exists while the panel is
    mounted would leave the count at zero until someone looked.
  */
  useNotificationStream();

  /*
    Which terminal is on the stage (HIVE-81). Here for the same reason as the
    three above — one fact about the whole shell, one publisher — and here
    rather than in `center-stage` because the stage re-renders for reasons that
    have nothing to do with which tab is open, and this should not.
  */
  useForegroundSession();

  /**
   * Watch the visible project's files.
   *
   * Here, not in the explorer panel, because the panel is not the only
   * consumer: an open editor buffer reconciles against the same events and
   * outlives the rail tab that shows the tree. Same reasoning as the two
   * subscriptions above — one broadcast channel, one listener, at the
   * composition root.
   */
  useProjectWatcher();

  /**
   * Follow the OS while the app is open (story 105).
   *
   * The store already read `prefers-color-scheme` once, synchronously, when it
   * was constructed — that is what paints the right theme on the first frame.
   * This subscribes to *changes*, which is a different thing and needs a
   * lifetime to be torn down with. One listener for the app, alongside the one
   * session-status subscription, for the same reason.
   */
  useEffect(() => watchSystemTheme(), []);

  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      {/*
        The window-controls row, above the app's own bar. Renders nothing off
        macOS and nothing in the browser, so the three-region layout below is
        unchanged on every target that does not have floating traffic lights.
      */}
      <TitleBar />
      <Header />

      {/*
        `railRef` is what the two drag handles measure against: a rail's width
        is a distance from one edge of this row, so the row is the ruler
        (HIVE-105). `relative` for the same reason — it is what the handles
        below position themselves against.
      */}
      <div ref={railRef} className="relative flex min-h-0 flex-1">
        <LeftRail />
        <CenterStage />
        {showActivityRail ? <ActivityRail /> : null}

        {/*
          The rail handles (HIVE-105).

          **Overlays, not flex siblings**, and that is the whole point of them
          being here rather than in the row above. A 1px handle in the flow
          would take a pixel from the stage and shift every measurement in the
          shell by two — small, but this app has browser tests that assert
          alignment to within a pixel, and one of them caught exactly that. As
          overlays they consume no layout at all: the geometry with them is
          identical to the geometry before this feature existed.

          Each sits on the rail's own border, addressed by the same custom
          property the rail is sized with, so a handle can never drift from the
          edge it drags. `bg-transparent` because that border already draws the
          hairline — what these contribute is the hit area and the hover
          colour, not the line.
        */}
        <SplitHandle
          axis="vertical"
          containerRef={railRef}
          label="Resize the navigation rail"
          value={rails.left}
          onValue={(width) => setRailWidth('left', width)}
          onReset={() => resetRailWidth('left')}
          scale="px-from-start"
          min={rails.min.left}
          max={rails.max}
          className="absolute inset-y-0 left-[var(--cc-rail-w-left)] bg-transparent"
        />
        {showActivityRail ? (
          <SplitHandle
            axis="vertical"
            containerRef={railRef}
            label="Resize the activity rail"
            value={rails.right}
            onValue={(width) => setRailWidth('right', width)}
            onReset={() => resetRailWidth('right')}
            scale="px-from-end"
            min={rails.min.right}
            max={rails.max}
            className="absolute inset-y-0 right-[var(--cc-rail-w-right)] bg-transparent"
          />
        ) : null}
      </div>
    </div>
  );
}
