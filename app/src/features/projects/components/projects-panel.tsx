import { ProjectRow } from '@features/projects/components/project-row';
import { useProjects } from '@stores/hive-store';

/**
 * Projects panel — a collapsible tree of projects and their live sessions.
 *
 * The panel holds no state and reads no session data: each row owns its own
 * subscription, so one session changing status repaints that row rather than
 * the whole tree.
 */
export function ProjectsPanel() {
  const projects = useProjects();

  return (
    <div data-panel="projects" className="flex flex-col gap-0.5">
      {projects.map((project) => (
        <ProjectRow key={project.id} project={project} />
      ))}
    </div>
  );
}
