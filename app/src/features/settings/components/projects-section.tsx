import { Plus } from '@phosphor-icons/react';
import { useState } from 'react';

import {
  addProjectToConfig,
  chooseProjectDirectory,
  removeProjectFromConfig,
} from '@/lib/project-config';

import { ProjectRow } from '@features/settings/components/project-row';
import { useProjectConfig } from '@hooks/use-project-config';
import { useHiveStore, useProjects } from '@stores/hive-store';


/**
 * The Projects section of settings (story 101).
 *
 * The list is a bordered card in **both** states. The empty state is the one
 * that matters — a fresh install is the entire reason this story exists — and a
 * bordered box saying "No projects yet" reads as a furnished, empty place,
 * where a bare heading above a button reads as a broken render.
 */
export function ProjectsSection() {
  const projects = useProjects();
  const snapshot = useProjectConfig();
  const entities = useHiveStore((state) => state.entities);

  /**
   * Whether a dialog is open, so the button cannot be double-fired.
   *
   * Not a loading spinner: the native dialog is modal to the window, so there
   * is nothing to spin *over*. This exists only to stop a second `invoke`
   * racing the first, which would open two dialogs and write twice.
   */
  const [choosing, setChoosing] = useState(false);

  /** Ids of projects that own a session that is not done. */
  const owningLiveSessions = new Set(
    Object.values(entities)
      .filter(
        (entity) => entity.kind === 'session' && entity.status !== 'done',
      )
      .map((entity) => (entity as { project: string }).project),
  );

  const byId = new Map(snapshot?.projects.map((entry) => [entry.id, entry]));

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

  /** What the row shows beneath the name, and why removal may be refused. */
  const describe = (id: string, source: 'config' | 'demo') => {
    const entry = byId.get(id);
    if (source === 'demo') {
      return {
        detail: 'not a real directory',
        isRepo: true,
        // A demo project has no config entry to remove. Saying so is more
        // useful than a disabled button with no explanation.
        removeBlockedBy: 'demo projects come from the sample data',
      };
    }
    return {
      detail: entry?.path ?? 'unresolved',
      isRepo: entry?.isRepo ?? true,
      removeBlockedBy: owningLiveSessions.has(id)
        ? // Story 103 owns the confirmation flow that lifts this.
          'this project has live sessions — close them first'
        : null,
    };
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[14px] text-ink">Projects</h2>
        <p className="text-[11.5px] text-subtle">
          Repositories The Hive can open a session in
        </p>
      </div>

      {projects.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-[7px] border border-dashed border-border px-4 py-6 text-center">
          <span className="text-[13px] text-muted">No projects yet.</span>
          <span className="text-[11.5px] text-subtle">
            Add a folder to start a session in it.
          </span>
        </div>
      ) : (
        <div className="overflow-hidden rounded-[7px] border border-border">
          {projects.map((project) => {
            const { detail, isRepo, removeBlockedBy } = describe(
              project.id,
              project.source,
            );
            return (
              <ProjectRow
                key={project.id}
                project={project}
                detail={detail}
                isRepo={isRepo}
                removeBlockedBy={removeBlockedBy}
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

      <button
        type="button"
        onClick={() => void onAdd()}
        disabled={choosing}
        className="flex w-fit items-center gap-1.5 rounded-md bg-brand-fill px-3 py-1.5 text-[12.5px] text-on-brand hover:bg-brand-fill-hover disabled:opacity-60"
      >
        <Plus size={12} weight="bold" />
        Add project
      </button>

      {snapshot ? (
        <p className="mt-auto pt-2 text-[11px] text-subtle">
          Config file: {snapshot.configPath}
        </p>
      ) : null}
    </div>
  );
}
