import { GitBranch, Plus } from '@phosphor-icons/react';
import { useState } from 'react';

import { useSwarmPhrase } from '@/hooks/use-swarm-phrase';

import { SwarmCreature } from '@components/ui/swarm-creature';
import { CloneRepoView } from '@features/settings/components/clone-repo-view';
import { ProjectsList } from '@features/settings/components/projects-list';
import { SettingsSectionHeader } from '@features/settings/components/settings-section-header';
import { useAddProject } from '@hooks/use-add-project';
import { useProjectConfig } from '@hooks/use-project-config';

/**
 * The Projects section of settings (story 101).
 *
 * ## What this lists
 *
 * **The user's own projects — the ones the config declares**, which is now the
 * same set the rails show.
 *
 * This used to draw a distinction it no longer has to. `useProjects()` returned
 * a *merge* — the config's projects plus any seeded project still owning a live
 * seeded session — so this section read the config directly to avoid opening on
 * five rows the user never added and could not remove, and accounted for them in
 * one muted line beneath the list. With the seed gone the merge is gone: a
 * project exists because the user mapped it, both lists agree, and that line had
 * nothing left to count.
 *
 * The list is a bordered card in **both** states. A bordered box saying "No
 * projects yet" reads as a furnished, empty place; a bare heading above a
 * button reads as a broken render.
 */
export function ProjectsSection() {
  const snapshot = useProjectConfig();
  const phrase = useSwarmPhrase('empty.settingsProjects');

  /**
   * Choosing a folder and writing it — shared with the projects rail, which
   * offers the same act from `NewProjectLink` (`@hooks/use-add-project`).
   *
   * The two slices may not import each other, and the flow has three
   * guarantees worth stating once rather than twice: one dialog per click, a
   * write of exactly the path it returned, nothing at all when it is closed.
   */
  const { addProject, choosing } = useAddProject();

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

  if (view === 'clone') {
    return <CloneRepoView onDone={() => setView('list')} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4">
      <SettingsSectionHeader
        title="Projects"
        description="Repositories The Hive can open a session in"
      />

      {declared.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-[7px] border border-dashed border-border px-4 py-6 text-center">
          <SwarmCreature creature="hive" size={72} />
          <span className="text-[11.5px] text-muted">{phrase}</span>
          <span className="text-[11.5px] text-subtle">
            Add a folder to start a session in it.
          </span>
        </div>
      ) : (
        <ProjectsList entries={declared} />
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
          onClick={addProject}
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

      {snapshot ? (
        <p className="mt-auto pt-2 text-[11px] text-subtle">
          Config file: {snapshot.configPath}
        </p>
      ) : null}
    </div>
  );
}
