import { FolderOpen, Kanban, Robot } from '@phosphor-icons/react';
import type { ComponentType } from 'react';

import { cn } from '@/lib/utils';

import { TabBar, tabId, type Tab } from '@components/ui/tab-bar';
import { AgentsPanel } from '@features/agents/components/agents-panel';
import { ProjectsPanel } from '@features/projects/components/projects-panel';
import { WorkPanel } from '@features/work/components/work-panel';
import {
  useRailWidthState,
  useSetRailCollapsed,
  useToggleRailCollapsed,
} from '@stores/appearance-store';
import {
  useAgentCount,
  useAgentFleetStatus,
  useTicketCount,
  type FleetStatus,
} from '@stores/hive-store';
import { useLeftTab, useSetLeftTab, type LeftTab } from '@stores/ui-store';

/**
 * Left rail — three views of the same fleet: by project, by work item, by agent.
 *
 * Fixed width, never flexed, so the center stage absorbs every width change and
 * the terminal is the only thing that resizes with the window. The width itself
 * is `--cc-rail-w-left` (story 105): 320px comfortable, narrower compact. A
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

/**
 * What the Agents dot means, said out loud.
 *
 * The dot carries no text, so this is the whole of its meaning for anyone not
 * reading the colour. Each phrase names the *fleet*, not the state — "an agent
 * is working" rather than "working", because the tab is a summary of several
 * rows and a bare status word beside a tab label reads as a claim about the
 * tab itself.
 */
const FLEET_PHRASE: Record<FleetStatus, string> = {
  asking: 'an agent is waiting on you',
  failed: 'an agent needs attention',
  working: 'an agent is working',
};

export function LeftRail() {
  const leftTab = useLeftTab();
  const setLeftTab = useSetLeftTab();
  const ticketCount = useTicketCount();
  const agentCount = useAgentCount();
  const fleetStatus = useAgentFleetStatus();
  const { railCollapsedLeft } = useRailWidthState();
  const setRailCollapsed = useSetRailCollapsed();
  const toggleRailCollapsed = useToggleRailCollapsed();

  const tabs: Tab<LeftTab>[] = [
    { id: 'projects', label: 'Projects', icon: FolderOpen },
    {
      id: 'work',
      label: 'Work',
      icon: Kanban,
      badgeCount: ticketCount,
      badgeLabel: 'work items',
    },
    {
      /*
        Two marks, because the tab answers two questions on two clocks.
        The badge is an inventory and reads like Work's beside it;
        the dot is the live one, and it is what survives the rail collapsing to
        a 44px strip where the label and the chip are both gone.

        The badge used to hold `useAgentAskCount()` — a real number, and zero
        almost all day, so a pane holding five agents announced nothing at all.
      */
      id: 'agents',
      label: 'Agents',
      icon: Robot,
      badgeCount: agentCount,
      // `Badge` composes `${count} ${label}`, so the noun is inflected here
      // rather than leaving a screen reader with "1 agents".
      badgeLabel: agentCount === 1 ? 'agent' : 'agents',
      ...(fleetStatus === undefined
        ? {}
        : { dotStatus: fleetStatus, dotLabel: FLEET_PHRASE[fleetStatus] }),
    },
  ];

  const Panel = PANELS[leftTab];

  return (
    <nav
      aria-label="Projects, work, and agents"
      className={cn(
        'flex w-[var(--cc-rail-w-left)] shrink-0 flex-col gap-[var(--cc-rail-gap)] border-r border-border-soft bg-panel pt-3.5 pb-5',
        railCollapsedLeft ? 'px-1.5' : 'px-2.5',
      )}
    >
      <TabBar
        tabs={tabs}
        active={leftTab}
        /*
          Selecting from the strip must expand. The rail is 44px wide; a
          click that only moved the highlight would look like nothing
          happened.
        */
        onSelect={(tab) => {
          setLeftTab(tab);
          if (railCollapsedLeft) setRailCollapsed('left', false);
        }}
        onActiveSelect={() => toggleRailCollapsed('left')}
        orientation={railCollapsedLeft ? 'strip' : 'horizontal'}
        // The left edge of the screen: a strip tooltip opens rightward, into
        // the window, rather than off the left edge.
        tooltipSide="right"
        label="Rail sections"
        className="shrink-0"
      />

      {railCollapsedLeft ? null : (
        <div
          role="tabpanel"
          aria-labelledby={tabId(leftTab)}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <Panel />
        </div>
      )}
    </nav>
  );
}
