/**
 * Projects panel — a collapsible tree of projects and their live sessions.
 *
 * Placeholder until story 031 builds the project and session rows. The
 * `data-panel` marker is the left rail's test hook for "which panel is
 * mounted", and survives into 031.
 */
export function ProjectsPanel() {
  return <div data-panel="projects" className="flex flex-col gap-0.5" />;
}
