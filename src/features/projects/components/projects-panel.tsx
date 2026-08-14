import { EmptyState, EmptyStatePath } from '@components/ui/empty-state';
import { ProjectRow } from '@features/projects/components/project-row';
import { useProjects } from '@stores/hive-store';

/**
 * Projects panel — a collapsible tree of projects and their live sessions.
 *
 * The panel holds no state and reads no session data: each row owns its own
 * subscription, so one session changing status repaints that row rather than
 * the whole tree.
 *
 * ## Empty is now a real state
 *
 * `useProjects()` used to fall back to five seeded projects whenever the config
 * had none, so this list was never empty and never had to say anything. It reads
 * the config and only the config now, which means a fresh install lands here
 * with nothing — and the panel has to explain that rather than render a blank
 * column that looks like a bug.
 */
export function ProjectsPanel() {
  const projects = useProjects();

  if (projects.length === 0) {
    return (
      <div data-panel="projects" className="flex flex-col gap-0.5">
        {/*
          "mapped", not "yet" — and deliberately not the same sentence the
          Settings screen uses for its own empty list. Two surfaces saying "No
          projects yet." in one app reads as one message rendered twice; this
          one names what is missing (a mapping) and where to make it, which is
          the thing the rail can say that Settings cannot.
        */}
        <EmptyState
          phrase="empty.projects"
          creature="overlord"
          action={
            <>
              Add one in <EmptyStatePath>Settings → Projects</EmptyStatePath>.
            </>
          }
        >
          No projects mapped.
        </EmptyState>
      </div>
    );
  }

  return (
    <div data-panel="projects" className="flex flex-col gap-0.5">
      {projects.map((project) => (
        <ProjectRow key={project.id} project={project} />
      ))}
    </div>
  );
}
