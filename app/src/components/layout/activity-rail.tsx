import type { ComponentType } from 'react';

import { TabBar, tabId, type Tab } from '@components/ui/tab-bar';
import { ActivityFeedPanel } from '@features/activity-feed/components/activity-feed-panel';
import { InboxPanel } from '@features/inbox/components/inbox-panel';
import { PrsPanel } from '@features/pull-requests/components/prs-panel';
import { useUnreadCount } from '@stores/hive-store';
import { useRailState, useSetRailTab, type RailTab } from '@stores/ui-store';

/**
 * Activity rail — the attention queue: what agents need, what is shippable,
 * and what the orchestrator has been doing.
 *
 * 316px fixed, and the only region the shell can hide: `showActivityRail` in
 * the ui-store unmounts it (in `app-shell.tsx`) so the terminal reclaims the
 * width and refits.
 *
 * This file is part of `components/layout/`, the composition root — the one
 * place chrome may import feature slices (AGENTS.md → Import zones). The three
 * panels are mounted directly rather than threaded in as slots from `app.tsx`,
 * which would move the whole app's wiring into one untestable module.
 *
 * **Scroll position resets on tab switch**, which story 050 asks us to choose
 * explicitly. Preserving it per panel means either keeping all three mounted or
 * mirroring `scrollTop` into the ui-store; for three short lists neither earns
 * the complexity, and a stale offset on a list the simulation just prepended to
 * is worse than starting at the top.
 */
const PANELS: Record<RailTab, ComponentType> = {
  inbox: InboxPanel,
  prs: PrsPanel,
  activity: ActivityFeedPanel,
};

export function ActivityRail() {
  const { railTab } = useRailState();
  const setRailTab = useSetRailTab();
  const unread = useUnreadCount();

  const tabs: Tab<RailTab>[] = [
    {
      id: 'inbox',
      label: 'Inbox',
      badgeCount: unread,
      badgeLabel: 'unread notifications',
      /**
       * Red, not the left rail's neutral chip. The work count is an inventory;
       * this one means the user is the thing an agent is blocked on.
       */
      badgeTone: 'danger',
    },
    { id: 'prs', label: 'PRs' },
    { id: 'activity', label: 'Activity' },
  ];

  const Panel = PANELS[railTab];

  return (
    <aside
      aria-label="Activity"
      className="flex w-[316px] shrink-0 flex-col gap-[18px] border-l border-border-soft bg-panel px-3.5 pt-3.5 pb-5"
    >
      <TabBar
        tabs={tabs}
        active={railTab}
        onSelect={setRailTab}
        label="Activity sections"
        className="shrink-0"
      />

      <div
        role="tabpanel"
        aria-labelledby={tabId(railTab)}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <Panel />
      </div>
    </aside>
  );
}
