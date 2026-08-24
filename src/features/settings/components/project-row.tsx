import { DotsSixVertical } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { Icon } from '@components/ui/icon';
import { ProjectKey } from '@components/ui/project-key';
import { Tag } from '@components/ui/tag';
import type { ProjectConfig } from '@shared/config-contract';

interface ProjectRowProps {
  project: ProjectConfig;
  /** True while this row is the one being dragged. */
  isDragging: boolean;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  /** The inline name editor, when this row is being renamed. */
  editor: ReactNode;
  /** The inline key editor, when this row's key is being changed (HIVE-94). */
  keyEditor: ReactNode;
  /** The row's overflow menu. */
  menu: ReactNode;
}

/**
 * One row in the settings projects list (stories 101, 103).
 *
 * Presentational: every decision — what the menu can do, which row is being
 * renamed, where a drop lands — belongs to `projects-list.tsx`, which is the
 * only component that can see the other rows.
 *
 * Drag is hand-rolled HTML5 rather than a library. The repo ships eleven
 * production dependencies and no drag-and-drop among them, a vertical-list
 * reorder is small, and Playwright's `dragTo` drives native HTML5 drag directly
 * where a pointer-event library would need the mouse stepped by hand. What a
 * library would have supplied for free — a keyboard path — is delivered by the
 * menu's *Move up* / *Move down* instead.
 */
export function ProjectRow({
  project,
  isDragging,
  onDragStart,
  onDragEnter,
  onDrop,
  onDragEnd,
  editor,
  keyEditor,
  menu,
}: ProjectRowProps) {
  const detail = project.path ?? 'unresolved';

  return (
    <li
      draggable
      onDragStart={onDragStart}
      /*
        `preventDefault` on **both** dragenter and dragover, which is what the
        HTML drag-and-drop model requires to declare a drop target. Doing it on
        dragover alone is the quiet failure: the row still highlights and
        dragenter still fires, but the browser never sends dragover to it, so
        `drop` never arrives and the drag ends as if it were abandoned.
      */
      onDragEnter={(event) => {
        event.preventDefault();
        onDragEnter();
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      className={`group flex items-center gap-2.5 border-b border-border-soft px-3 py-2.5 last:border-b-0 ${
        isDragging ? 'opacity-45' : ''
      }`}
    >
      {/*
        The grip is a hint, not a control: the whole row is draggable, so making
        this a button would promise a keyboard interaction it does not have —
        that is the menu's job. `aria-hidden` keeps it out of the accessibility
        tree rather than announcing a handle a keyboard user cannot use.
      */}
      <span
        aria-hidden="true"
        className="shrink-0 cursor-grab text-subtle opacity-0 group-hover:opacity-100"
      >
        <DotsSixVertical size={13} weight="bold" />
      </span>

      <Icon name={project.icon} className="shrink-0 text-muted" />

      {/*
        Between the icon and the name, and never hidden behind a hover: the key
        is only worth having if it can be read off the list and typed (HIVE-94).
      */}
      {keyEditor ?? (
        <ProjectKey
          value={project.key}
          title={`type "${project.key}" wherever a project is asked for`}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {editor ?? (
          <span className="truncate text-[13px] text-ink">{project.name}</span>
        )}
        <span className="truncate text-[11.5px] text-subtle">{detail}</span>
      </div>

      {!project.isRepo ? (
        /*
          Muted, not a warning. A PTY needs a cwd, not a repo — refusing to add
          a plain directory would be the app inventing a rule the shell does not
          have, so this reports rather than scolds.
        */
        <Tag tone="subtle" title="not a git repository — sessions still open here">
          no git
        </Tag>
      ) : null}

      {menu}
    </li>
  );
}
