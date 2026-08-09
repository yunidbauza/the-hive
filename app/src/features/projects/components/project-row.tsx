import type { Project } from '@/types/entity';

import { Icon } from '@components/ui/icon';
import { Tag } from '@components/ui/tag';
import { NewSessionLink } from '@features/projects/components/new-session-link';
import { SessionRow } from '@features/projects/components/session-row';
import { useProjectAccess } from '@hooks/use-project-config';
import { useProjectSessions } from '@stores/hive-store';
import { useProjectCollapsed, useToggleProject } from '@stores/ui-store';

interface ProjectRowProps {
  project: Project;
}

/**
 * One project and, when expanded, its live sessions.
 *
 * The whole row is the toggle — a `<button>` rather than a div with an onClick,
 * so it is reachable by keyboard and `aria-expanded` tells a screen reader which
 * way the tree is pointing.
 *
 * Collapse state lives in the ui-store, not here: the panel unmounts every time
 * the user visits another left-rail tab, and a `useState` would forget the tree
 * on the way back.
 */
export function ProjectRow({ project }: ProjectRowProps) {
  const sessionIds = useProjectSessions(project.id);
  const collapsed = useProjectCollapsed(project.id);
  const toggleProject = useToggleProject();
  const access = useProjectAccess(project.id);

  const expanded = !collapsed;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => toggleProject(project.id)}
        aria-expanded={expanded}
        className="mt-2.5 flex items-center gap-2 rounded-lg px-2.5 pt-[var(--cc-row-py)] pb-0.5 hover:bg-hover"
      >
        <Icon
          name={expanded ? 'ph-caret-down' : 'ph-caret-right'}
          size={11}
          className="shrink-0 text-subtle"
        />
        <Icon name={project.icon} size={15} className="shrink-0 text-subtle" />

        <span className="flex-1 truncate text-left font-mono text-[12.5px]">
          {project.id}
        </span>

        {/*
          The project has no real directory behind it, so no session can open
          here (story 090). Muted when it is simply not in the config — a thing
          the user has not done yet — and amber when the entry exists but does
          not resolve, which is a thing they did wrong. The tooltip carries the
          reason and names the file to edit.
        */}
        {access.reason ? (
          <Tag
            tone={access.invalid ? 'amber' : 'subtle'}
            title={access.reason}
            className="shrink-0"
          >
            unmapped
          </Tag>
        ) : null}

        {/*
          A plain span, not `Badge`: `Badge` renders nothing at zero, and a
          project with no live sessions must still show its `0` (the story's
          empty state) rather than losing the pill entirely.
        */}
        <span className="shrink-0 rounded-full bg-chip px-2 py-0.5 font-mono text-[11px] text-muted">
          {sessionIds.length}
          <span className="sr-only">
            {sessionIds.length === 1 ? ' active session' : ' active sessions'}
          </span>
        </span>
      </button>

      {/*
        Sessions, then the way to start another — last child of the expanded
        region either way, so it sits directly under the folder when nothing is
        running and under the final session when something is.

        Only when expanded: a collapsed project is a summary, and its count pill
        already says what is happening inside it. Hanging a control off a closed
        row would put an action where the user asked for silence.
      */}
      {expanded ? (
        <>
          {sessionIds.map((id) => (
            <SessionRow key={id} id={id} />
          ))}
          <NewSessionLink projectId={project.id} />
        </>
      ) : null}
    </div>
  );
}
