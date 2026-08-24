import { useMemo, useState } from 'react';

import {
  chooseProjectDirectory,
  removeProjectFromConfig,
  renameProjectInConfig,
  reorderProjectsInConfig,
  repointProjectInConfig,
  setProjectKeyInConfig,
} from '@/lib/project-config';

import { ProjectKeyEditor } from '@features/settings/components/project-key-editor';
import { ProjectNameEditor } from '@features/settings/components/project-name-editor';
import { ProjectRemoveConfirm } from '@features/settings/components/project-remove-confirm';
import { ProjectRow } from '@features/settings/components/project-row';
import { ProjectRowMenu } from '@features/settings/components/project-row-menu';
import { projectAliases, type ProjectConfig } from '@shared/config-contract';
import { useLiveSessionCounts } from '@stores/hive-store';

interface ProjectsListProps {
  /** The config's own entries, in file order. */
  entries: readonly ProjectConfig[];
}

/** Which row, if any, has replaced its resting state with something else. */
type RowMode = {
  id: string;
  kind: 'rename' | 'change-key' | 'confirm-remove';
} | null;

/**
 * Everything the other projects already answer to, mapped to who holds it.
 *
 * Keys **and ids and names** (HIVE-94), because that is exactly what main
 * refuses: `resolveProjectRef` searches one address space and tries key first,
 * so a key equal to another project's id would silently take that id's spawns.
 * Checking only keys here would show a green hint for a value main is about to
 * reject — the worst version of a live validator.
 *
 * This project's own handles are excluded, so re-opening the editor and pressing
 * Enter is a no-op rather than a refusal against itself — the same allowance
 * `setProjectKey` makes when it skips the entry being edited.
 */
function keysTakenBy(
  entries: readonly ProjectConfig[],
  exclude: string,
): ReadonlyMap<string, string> {
  return new Map(
    entries
      .filter((project) => project.id !== exclude)
      .flatMap((project) =>
        projectAliases(project).map(
          (alias) => [alias, project.name] as [string, string],
        ),
      ),
  );
}

/**
 * The ordered list of the user's projects (story 103).
 *
 * Extracted from `projects-section.tsx` because the drag state has to live
 * above the rows, and because a row that grew a grip, a menu, an inline editor
 * and an inline confirmation would have been doing far too much alone. The
 * section keeps what it was always about: the panes, the action row, errors and
 * the footer.
 *
 * Every piece of state here is **local**, following the rule story 101 used for
 * `choosing` and 102 for `view`: it is scoped to this list and dies with it, so
 * promoting it to `ui-store` would put view state nobody else reads into a
 * store shared with thirteen live terminals.
 */
export function ProjectsList({ entries }: ProjectsListProps) {
  /*
    Counts, not membership. The confirmation says the number out loud, and the
    membership selector deduplicates by design, so counting it always gave 1 —
    "1 live session will keep running — they just stop resolving" contradicted
    itself in the same sentence.
  */
  const liveCounts = useLiveSessionCounts();

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [mode, setMode] = useState<RowMode>(null);

  /**
   * The order to paint right now.
   *
   * Derived from the drag rather than held in state. An optimistic copy of the
   * list would have to be reconciled when the write returns, and the whole
   * reason every mutating verb answers with a snapshot is that the renderer
   * never holds a list the write already invalidated.
   */
  const ordered = useMemo(() => {
    if (draggingId === null || dropIndex === null) return entries;
    const from = entries.findIndex((item) => item.id === draggingId);
    if (from === -1 || from === dropIndex) return entries;
    const next = [...entries];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return entries;
    next.splice(dropIndex, 0, moved);
    return next;
  }, [entries, draggingId, dropIndex]);

  const commitOrder = (next: readonly ProjectConfig[]): void => {
    const before = entries.map((item) => item.id);
    const after = next.map((item) => item.id);
    // Nothing moved: a drag that ended where it began, or a no-op menu click.
    // Writing anyway would churn the file and log a pointless snapshot.
    if (before.every((id, index) => id === after[index])) return;
    void reorderProjectsInConfig({ ids: after });
  };

  /** Move one row by `delta`, the keyboard and menu path for reordering. */
  const move = (id: string, delta: number): void => {
    const from = entries.findIndex((item) => item.id === id);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= entries.length) return;
    const next = [...entries];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    commitOrder(next);
  };

  const endDrag = (): void => {
    setDraggingId(null);
    setDropIndex(null);
  };

  const onRepoint = async (id: string): Promise<void> => {
    const path = await chooseProjectDirectory();
    // Cancelled, or no bridge to ask. Nothing to write, and nothing to say —
    // the user closed a dialog they opened. Same shape as the section's `onAdd`.
    if (path === null) return;
    await repointProjectInConfig({ id, path });
  };

  const onRemove = (id: string): void => {
    if ((liveCounts[id] ?? 0) > 0) {
      // Story 101 disabled this outright; the confirmation is what lifts it.
      setMode({ id, kind: 'confirm-remove' });
      return;
    }
    void removeProjectFromConfig({ id });
  };

  return (
    <ul className="overflow-hidden rounded-[7px] border border-border">
      {ordered.map((project, index) => {
        /*
          `index` is the row's **painted** position, not its position in
          `entries`, and that distinction is the whole correctness of the drag.

          The two agree until the preview moves something, and then they
          diverge: after dragging a row down, the row you are now hovering sits
          at a different original index than visual one. Feeding the original
          index back in as the drop target made a reversal lag by one — a row
          dragged down could never be dragged back to the top, because entering
          the first row asked for a position the preview had already vacated.

          Reading the painted position instead is self-correcting: `ordered`
          places the dragged row *at* `dropIndex`, so "the row I am over is at
          visual position i" and "move me to position i" are the same
          statement, in both directions.
        */
        const active = mode?.id === project.id ? mode.kind : null;

        if (active === 'confirm-remove') {
          return (
            <li key={project.id}>
              <ProjectRemoveConfirm
                projectName={project.name}
                liveSessionCount={liveCounts[project.id] ?? 0}
                onConfirm={() => {
                  setMode(null);
                  void removeProjectFromConfig({ id: project.id });
                }}
                onCancel={() => setMode(null)}
              />
            </li>
          );
        }

        return (
          <ProjectRow
            key={project.id}
            project={project}
            isDragging={draggingId === project.id}
            onDragStart={() => {
              setDraggingId(project.id);
              setDropIndex(index);
            }}
            onDragEnter={() => {
              if (draggingId !== null) setDropIndex(index);
            }}
            onDrop={() => {
              commitOrder(ordered);
              endDrag();
            }}
            onDragEnd={endDrag}
            editor={
              active === 'rename' ? (
                <ProjectNameEditor
                  initialName={project.name}
                  onCommit={(name) => {
                    setMode(null);
                    void renameProjectInConfig({ id: project.id, name });
                  }}
                  onCancel={() => setMode(null)}
                />
              ) : null
            }
            keyEditor={
              active === 'change-key' ? (
                <ProjectKeyEditor
                  initialKey={project.key}
                  takenKeys={keysTakenBy(entries, project.id)}
                  onCommit={(key) => {
                    setMode(null);
                    void setProjectKeyInConfig({ id: project.id, key });
                  }}
                  onCancel={() => setMode(null)}
                />
              ) : null
            }
            menu={
              <ProjectRowMenu
                projectName={project.name}
                canMoveUp={index > 0}
                canMoveDown={index < entries.length - 1}
                onMoveUp={() => move(project.id, -1)}
                onMoveDown={() => move(project.id, 1)}
                onRename={() => setMode({ id: project.id, kind: 'rename' })}
                onChangeKey={() =>
                  setMode({ id: project.id, kind: 'change-key' })
                }
                onRepoint={() => void onRepoint(project.id)}
                onRemove={() => onRemove(project.id)}
              />
            }
          />
        );
      })}
    </ul>
  );
}
