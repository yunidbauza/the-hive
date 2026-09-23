/*
  Aliased because this file exports a *component* called `ProjectRow` too, and
  the two names would collide. The type is the row's data; the component draws
  it.
*/
import type { ProjectRow as ProjectRowData } from '@/types/entity';
import { isTerminal } from '@/types/entity';

import { Icon } from '@components/ui/icon';
import { Tag } from '@components/ui/tag';
import { NewSessionLink } from '@features/projects/components/new-session-link';
import { NewTerminalLink } from '@features/projects/components/new-terminal-link';
import { SessionRow } from '@features/projects/components/session-row';
import { TerminalRow } from '@features/projects/components/terminal-row';
import { useProjectAccess } from '@hooks/use-project-config';
import { useEntity, useProjectLiveCount, useProjectSessions } from '@stores/hive-store';
import { useProjectCollapsed, useToggleProject } from '@stores/ui-store';

interface ProjectRowProps {
  /**
   * The full row, not the narrower {@link Project} (HIVE-104).
   *
   * This used to be typed `Project` — `{ id, icon }` — and the row drew
   * `project.id` as its label. That is not a stale name, it is the wrong
   * field: a rename writes `name` and deliberately leaves `id` alone, because
   * `id` is the stable key `entity.project` points at. So the rail kept
   * showing the old word forever, and `project.name` was a *type error* in
   * this file — the correct field was not merely unused, it was unreachable.
   *
   * A display surface takes the display shape. `Project` is the identity half
   * and no longer types any component — see the note on {@link ProjectRowData}.
   */
  project: ProjectRowData;
}

/**
 * One entry of a project's list, by kind (terminals).
 *
 * The list selector returns ids of both kinds in start order; the kind is read
 * here rather than returned beside the id so the selector's shape — and every
 * consumer counting its length — stays what it was.
 */
function ProjectEntryRow({ id }: { id: string }) {
  const entity = useEntity(id);
  if (!entity) return null;
  return isTerminal(entity) ? <TerminalRow id={id} /> : <SessionRow id={id} />;
}

/**
 * One project and, when expanded, its live sessions and terminals.
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
  const liveCount = useProjectLiveCount(project.id);
  const collapsed = useProjectCollapsed(project.id);
  const toggleProject = useToggleProject();
  const access = useProjectAccess(project.id);

  const expanded = !collapsed;

  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => toggleProject(project.id)}
        aria-expanded={expanded}
        className="mt-2.5 flex items-center gap-2 rounded-lg px-2.5 pt-[var(--cc-row-py)] pb-0.5 hover:bg-hover"
      >
        {/*
          The caret stays `subtle`: it is chrome, not identity. It says which
          way the tree is pointing and nothing about what the row *is*.
        */}
        <Icon
          name={expanded ? 'ph-caret-down' : 'ph-caret-right'}
          size={11}
          className="shrink-0 text-subtle"
        />
        <Icon name={project.icon} size={15} className="shrink-0 text-brand" />

        {/*
          The name, and only the name (HIVE-104). Settings and the picker each
          carry a `ProjectKey` chip; the rail deliberately carries none — it is
          the quietest of the three surfaces, which is what it is for.

          ## Why the name is `brand` and the sessions below it are not

          A project row and a session row were the same size, the same weight
          and the same colour, so the only thing marking a project was its
          indent — and the icon beside it was painted *quieter* than the
          sessions it contained. The tree read as one flat column of names.

          `brand` is what separates them, under the app's one hierarchy rule:
          brand names a container, ink names a thing inside it, subtle names
          that thing's metadata. It costs no token — every theme ships `brand`
          in both modes because the format requires it — so Honeycomb's orange,
          Graphite's lime and Cinder's magenta all arrive for free, and an
          imported theme cannot opt out of having one. The picker already drew
          its project icons this way; this is the rail catching up.

          Status colour is untouched and stays the loudest thing here: a
          session that needs the user still wins the row it is in.
        */}
        <span className="flex-1 truncate text-left font-mono text-[12.5px] text-brand">
          {project.name}
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
          {liveCount}
          {/*
            `running`, not `active session(s)` (terminals): the list holds
            sessions *and* terminals now, so a word that names one kind would
            be wrong about the other — and it needs no plural, which is the
            other reason it is the right word.
          */}
          <span className="sr-only"> running</span>
        </span>
      </button>

      {/*
        Entries, then the two ways to start another — last child of the
        expanded region either way, so it sits directly under the folder when
        nothing is running and under the final entry when something is.

        Only when expanded: a collapsed project is a summary, and its count pill
        already says what is happening inside it. Hanging a control off a closed
        row would put an action where the user asked for silence.
      */}
      {expanded ? (
        <>
          {sessionIds.map((id) => (
            <ProjectEntryRow key={id} id={id} />
          ))}
          {/*
            The split row: a session on the left, a terminal on the right, one
            rule between them. Still the last child, still under the final
            entry; the session link keeps its indent and the terminal link
            hangs off the rule.
          */}
          <div className="flex items-center">
            <NewSessionLink projectId={project.id} projectName={project.name} />
            <span
              aria-hidden="true"
              className="mx-1 h-3 w-px shrink-0 bg-border-soft"
            />
            <NewTerminalLink
              projectId={project.id}
              projectName={project.name}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
