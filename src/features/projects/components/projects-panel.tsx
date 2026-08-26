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
 * ## Where the way in sits, in each state
 *
 * `NewProjectLink` is the panel's one control, and both states offer it — a
 * fresh install maps its first repository from the rail it is already looking
 * at, and a full tree gains another without the control drifting down past the
 * fold. What differs is what it has to lead.
 *
 * Above a tree it leads a list: every other row in here belongs to a project,
 * this one belongs to the list. Above an *empty* state it led the sprite and
 * the line explaining the emptiness, which put the answer before the question
 * and left the copy pointing back up the column at it. So the empty branch
 * hands it to `EmptyState` as the `control` instead, and reads in the order
 * the user acts in: what the panel is, then what to press, then the one thing
 * this rail cannot do for them.
 */
export function ProjectsPanel() {
  const projects = useProjects();

  if (projects.length === 0) {
    return (
      <div data-panel="projects" className="flex flex-col gap-0.5">
        {/*
          No body sentence, on purpose. "No projects mapped." said in prose
          exactly what "No hatcheries detected." says in the swarm register one
          line above it — the same fact, twice, in two voices. The flavour line
          is the message now, and what is left below the button is the half the
          line cannot carry.

          That half is Settings, and only Settings. The sentence used to send a
          fresh install there because it was the only way to map a project; the
          button made it a detour past itself, and then had to be pointed at
          with the word "above" to repair the order. It keeps the one thing the
          rail genuinely cannot do — fetch a repository that is not on this
          machine yet — and gives up the rest to the control.
        */}
        <EmptyState
          phrase="empty.projects"
          creature="overlord"
          control={<NewProjectLink variant="cta" />}
          action={
            <>
              Or clone one in{' '}
              <EmptyStatePath>Settings → Projects</EmptyStatePath>.
            </>
          }
        />
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
