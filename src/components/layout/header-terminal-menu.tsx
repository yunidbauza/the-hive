import { CaretDown } from '@phosphor-icons/react';

import type { ProjectRow } from '@/types/entity';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@components/ui/dropdown-menu';
import { Icon } from '@components/ui/icon';
import { useProjectAccess, useProjectContainerised } from '@hooks/use-project-config';
import { useProjects, useSpawnTerminal } from '@stores/hive-store';

const item =
  'flex items-center gap-2 rounded-[4px] px-2 py-1 font-mono text-[12.5px] text-muted focus:bg-hover focus:text-ink data-[disabled]:opacity-35';

/**
 * The chevron half of the header's split button (entry points).
 *
 * `New session` keeps its name and its picker; this opens a terminal in a
 * project without a screen in between, because a terminal takes exactly one
 * input and a menu of projects is that input. Every project, in config order:
 * the picker is a *session* surface — choosing a project there spawns a
 * Claude — so it is never the fall-through for the fifth project and beyond
 * (#205 review). A long config scrolls inside the menu.
 *
 * The trigger's name is `Terminal in a project`: it does not begin with "new"
 * and is not an exact `New session`, so every locator that finds the button
 * by name keeps finding exactly one.
 */
export function HeaderTerminalMenu() {
  const projects = useProjects();
  const spawnTerminal = useSpawnTerminal();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Terminal in a project"
        className="flex h-9 shrink-0 items-center rounded-r-full border-l border-border-soft bg-brand-fill px-2 text-on-brand hover:bg-brand-fill-hover [-webkit-app-region:no-drag]"
      >
        <CaretDown size={13} weight="bold" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[60vh] min-w-[13rem] overflow-y-auto rounded-[7px] border border-border bg-panel p-1 shadow-lg"
      >
        <DropdownMenuLabel className="px-2 py-1 font-mono text-[10.5px] tracking-wide text-subtle uppercase">
          New terminal in…
        </DropdownMenuLabel>
        {projects.map((project) => (
          <TerminalMenuItem key={project.id} project={project} onSelect={spawnTerminal} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Its own component because `useProjectAccess` is a hook and cannot run inside
 * a `.map()` body — the reason the picker has `PinnedProject`.
 */
function TerminalMenuItem({
  project,
  onSelect,
}: {
  project: ProjectRow;
  onSelect: (projectId: string) => void;
}) {
  const access = useProjectAccess(project.id);
  const containerised = useProjectContainerised(project.id);

  return (
    <DropdownMenuItem
      disabled={!access.spawnable}
      title={access.reason ?? undefined}
      onSelect={() => onSelect(project.id)}
      className={item}
    >
      <Icon name={project.icon} size={13} className="shrink-0 text-brand" />
      <span className="flex-1 truncate">
        {containerised ? `${project.name} · host` : project.name}
      </span>
      <span className="text-[10.5px] text-subtle">{project.key}</span>
    </DropdownMenuItem>
  );
}
