import { ActivityRail } from '@components/layout/activity-rail';
import { CenterStage } from '@components/layout/center-stage';
import { Header } from '@components/layout/header';
import { LeftRail } from '@components/layout/left-rail';
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
 * The rails are fixed-width, so the center column absorbs every width change
 * and the document never gains a horizontal scrollbar.
 */
export function AppShell() {
  const showActivityRail = useShowActivityRail();

  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      <Header />

      <div className="flex min-h-0 flex-1">
        <LeftRail />
        <CenterStage />
        {showActivityRail ? <ActivityRail /> : null}
      </div>
    </div>
  );
}
