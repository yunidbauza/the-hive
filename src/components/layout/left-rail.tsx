import type { ComponentType } from 'react';

import { TabBar, tabId, type Tab } from '@components/ui/tab-bar';
import { AgentsPanel } from '@features/agents/components/agents-panel';
import { ProjectsPanel } from '@features/projects/components/projects-panel';
import { WorkPanel } from '@features/work/components/work-panel';
import { useAgentAskCount, useTicketCount } from '@stores/hive-store';
import { useLeftTab, useSetLeftTab, type LeftTab } from '@stores/ui-store';

/**
 * Left rail — three views of the same fleet: by project, by work item, by agent.
 *
 * Fixed width, never flexed, so the center stage absorbs every width change and
 * the terminal is the only thing that resizes with the window. The width itself
 * is `--cc-rail-w-left` (story 105): 268px comfortable, narrower compact. A
 * density change therefore resizes the terminal through exactly the path a
 * window resize already takes — `min-w-0` on the stage, then the fit addon.
 *
 * The tab bar is the first flex child and stays put; the panel below it owns
 * the scrollbar. Scrolling the whole rail instead would push the tabs
 * off-screen the moment a project tree grew, which is the one control the user
 * needs to get back out of it.
 *
 * This file is part of `components/layout/`, the composition root — the one
 * place chrome may import feature slices (AGENTS.md → Import zones). Panel
 * state lives in the stores, never in the panels, so switching tabs unmounts a
 * panel without losing what the user did in it.
 */
const PANELS: Record<LeftTab, ComponentType> = {
  projects: ProjectsPanel,
  work: WorkPanel,
  agents: AgentsPanel,
};

export function LeftRail() {
  const leftTab = useLeftTab();
  const setLeftTab = useSetLeftTab();
  const ticketCount = useTicketCount();
  const askCount = useAgentAskCount();

  const tabs: Tab<LeftTab>[] = [
    { id: 'projects', label: 'Projects' },
    {
      id: 'work',
      label: 'Work',
      badgeCount: ticketCount,
      badgeLabel: 'work items',
    },
    {
      /*
        Open asks *from agents* — not the Inbox's unread count and not
        `useOpenAskCount`, which counts a session's asks too (HIVE-116). Three
        badges on this screen, three genuinely different numbers; this one
        answers "how many of my tenants are stuck on me?".
      */
      id: 'agents',
      label: 'Agents',
      badgeCount: askCount,
      badgeLabel: 'agents waiting on an answer',
    },
  ];

  const Panel = PANELS[leftTab];

  return (
    <nav
      aria-label="Projects, work, and agents"
      className="flex w-[var(--cc-rail-w-left)] shrink-0 flex-col gap-[var(--cc-rail-gap)] border-r border-border-soft bg-panel px-2.5 pt-3.5 pb-5"
    >
      <TabBar
        tabs={tabs}
        active={leftTab}
        onSelect={setLeftTab}
        label="Rail sections"
        className="shrink-0"
      />

      <div
        role="tabpanel"
        aria-labelledby={tabId(leftTab)}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <Panel />
      </div>
    </nav>
  );
}
