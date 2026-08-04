import { GitBranch, Plus } from '@phosphor-icons/react';
import { useState } from 'react';

import {
  addProjectToConfig,
  chooseProjectDirectory,
  removeProjectFromConfig,
} from '@/lib/project-config';
import type { ProjectRow as Row } from '@/types/entity';

import { CloneRepoView } from '@features/settings/components/clone-repo-view';
import { ProjectRow } from '@features/settings/components/project-row';
import { useProjectConfig } from '@hooks/use-project-config';
import { useProjects, useProjectsOwningLiveSessions } from '@stores/hive-store';

/**
 * The Projects section of settings (story 101).
 *
 * ## What this lists, and what it deliberately does not
 *
 * **The user's own projects — the ones the config declares.** Not the merged
 * list `useProjects()` returns.
 *
 * The merge rule exists so the *rails and the picker* keep working: a fixture
 * project that still owns live sessions stays in that list, because the work
 * panel, the orchestrator table and `resolve-transport` all reach sessions
 * through `entity.project`. That is right for the rails and wrong here.
 * Fixture projects always own sessions in this phase, so listing them would
 * mean a fresh install opens Settings on five rows the user did not add,
 * cannot remove, and did not come here for — and the empty state, which is the
 * screen this whole story exists to produce, would never appear at all.
 *
 * They are accounted for instead by one muted line beneath the list, so the
 * user can still tell where the rail's projects come from.
 *
 * The list is a bordered card in **both** states. A bordered box saying "No
 * projects yet" reads as a furnished, empty place; a bare heading above a
 * button reads as a broken render.
 */
export function ProjectsSection() {
  const merged = useProjects();
  const snapshot = useProjectConfig();
  const owningLiveSessions = useProjectsOwningLiveSessions();

  /**
   * Whether a dialog is open, so the button cannot be double-fired.
   *
   * Not a loading spinner: the native dialog is modal to the window, so there
   * is nothing to spin *over*. This exists only to stop a second `invoke`
   * racing the first, which would open two dialogs and write twice.
   */
  const [choosing, setChoosing] = useState(false);

  /**
   * Which pane this section is showing (story 102).
   *
   * Local state rather than `ui-store`: that store holds app-wide view state,
   * and this is scoped to one section and dies with it — the same reasoning as
   * `choosing` above. Cloning is also the reason the flag is not in
   * `resolve-view.ts`: settings is already the fifth view state, and a clone is
   * a step inside it, not a sixth.
   */
  const [view, setView] = useState<'list' | 'clone'>('list');

  const declared = snapshot?.projects ?? [];
  const rows: Row[] = declared.map((entry) => ({
    id: entry.id,
    name: entry.name,
    icon: entry.icon,
    source: 'config',
  }));

  /** Demo projects still on screen elsewhere, counted rather than listed. */
  const demoCount = merged.filter((project) => project.source === 'demo').length;

  const onAdd = async () => {
    if (choosing) return;
    setChoosing(true);
    try {
      const path = await chooseProjectDirectory();
      // Cancelled, or no bridge to ask. Nothing to write, and nothing to say:
      // the user closed a dialog they opened.
      if (path === null) return;
      await addProjectToConfig({ path });
    } finally {
      setChoosing(false);
    }
  };

  const onRemove = (id: string) => {
    void removeProjectFromConfig({ id });
  };

  if (view === 'clone') {
    return <CloneRepoView onDone={() => setView('list')} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[14px] text-ink">Projects</h2>
        <p className="text-[11.5px] text-subtle">
          Repositories The Hive can open a session in
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-[7px] border border-dashed border-border px-4 py-6 text-center">
          <span className="text-[13px] text-muted">No projects yet.</span>
          <span className="text-[11.5px] text-subtle">
            Add a folder to start a session in it.
          </span>
        </div>
      ) : (
        <div className="overflow-hidden rounded-[7px] border border-border">
          {rows.map((project) => {
            const entry = declared.find((item) => item.id === project.id);
            return (
              <ProjectRow
                key={project.id}
                project={project}
                detail={entry?.path ?? 'unresolved'}
                isRepo={entry?.isRepo ?? true}
                removeBlockedBy={
                  owningLiveSessions.includes(project.id)
                    ? // Story 103 owns the confirmation flow that lifts this.
                      'this project has live sessions — close them first'
                    : null
                }
                onRemove={onRemove}
              />
            );
          })}
        </div>
      )}

      {/*
        Errors from the last snapshot, verbatim. Main writes them in words the
        person editing the file can act on — "not a directory", the OS message
        from a failed write — so re-phrasing them here would lose the detail
        that makes them fixable.
      */}
      {snapshot?.errors.map((error) => (
        <p
          key={error}
          className="rounded-[5px] border border-red px-2.5 py-1.5 text-[11.5px] text-red"
        >
          {error}
        </p>
      ))}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void onAdd()}
          disabled={choosing}
          className="flex w-fit items-center gap-1.5 rounded-md bg-brand-fill px-3 py-1.5 text-[12.5px] text-on-brand hover:bg-brand-fill-hover disabled:opacity-60"
        >
          <Plus size={12} weight="bold" />
          Add project
        </button>

        {/*
          Secondary, because adding a folder you already have is the commoner
          path — cloning is the one you take once per repository.
        */}
        <button
          type="button"
          onClick={() => setView('clone')}
          className="flex w-fit items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12.5px] text-muted hover:bg-hover hover:text-ink"
        >
          <GitBranch size={12} weight="bold" />
          Clone from URL
        </button>
      </div>

      {demoCount > 0 ? (
        <p className="text-[11px] text-subtle">
          {demoCount === 1
            ? '1 demo project from the sample data also appears in the rail.'
            : `${demoCount} demo projects from the sample data also appear in the rail.`}
        </p>
      ) : null}

      {snapshot ? (
        <p className="mt-auto pt-2 text-[11px] text-subtle">
          Config file: {snapshot.configPath}
        </p>
      ) : null}
    </div>
  );
}
