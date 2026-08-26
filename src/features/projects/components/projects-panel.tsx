import { EmptyState, EmptyStatePath } from '@components/ui/empty-state';
import { NewProjectLink } from '@features/projects/components/new-project-link';
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
 *
 * ## Why the way in leads both states
 *
 * `NewProjectLink` is the panel's one control and is rendered first either
 * way, so a fresh install can map its first repository from the rail it is
 * already looking at, and a full tree can gain another without the control
 * drifting down past the fold. Every other row in here belongs to a project;
 * this one belongs to the list.
 */
export function ProjectsPanel() {
  const projects = useProjects();

  if (projects.length === 0) {
    return (
      <div data-panel="projects" className="flex flex-col gap-0.5">
        <NewProjectLink />
        {/*
          "mapped", not "yet" — and deliberately not the same sentence the
          Settings screen uses for its own empty list. Two surfaces saying "No
          projects yet." in one app reads as one message rendered twice; this
          one names what is missing, which is a mapping.

          The action names the control directly above it. It used to send a
          fresh install to Settings, which was the only way to map a project
          and is now a detour past the button in the same panel — the sentence
          outlived the constraint that made it true. Settings stays in it for
          the one thing the rail cannot do: fetch a repository that is not on
          this machine yet.
        */}
        <EmptyState
          phrase="empty.projects"
          creature="overlord"
          action={
            <>
              Use <EmptyStatePath>+ new project</EmptyStatePath> above, or clone
              one in <EmptyStatePath>Settings → Projects</EmptyStatePath>.
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
      <NewProjectLink />
      {projects.map((project) => (
        <ProjectRow key={project.id} project={project} />
      ))}
    </div>
  );
}
