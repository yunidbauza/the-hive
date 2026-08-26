import { useEffect, useRef } from 'react';

import { ActivityRail } from '@components/layout/activity-rail';
import { CenterStage } from '@components/layout/center-stage';
import { Header } from '@components/layout/header';
import { LeftRail } from '@components/layout/left-rail';
import { RailHandles } from '@components/layout/rail-handles';
import { TitleBar } from '@components/layout/title-bar';
import { useProjectWatcher } from '@features/explorer/hooks/use-project-watcher';
import { useSessionStatus } from '@features/sessions/hooks/use-session-status';
import { useNotificationActivate } from '@features/settings/hooks/use-notification-activate';
import { useForegroundSession } from '@hooks/use-foreground-session';
import { useNotificationStream } from '@hooks/use-notification-stream';
import { watchSystemTheme } from '@stores/appearance-store';
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
    The ruler the rail handles measure against (HIVE-105).

    Only the ref lives here. The widths themselves are subscribed to inside
    `RailHandles`, deliberately: they change on every pointermove of a drag, and
    this component renders three unmemoized regions — one of which, by its own
    note, costs a render of every mounted surface.
  */
  const railRef = useRef<HTMLDivElement>(null);

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

        <RailHandles containerRef={railRef} />
      </div>
    </div>
  );
}
