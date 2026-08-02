/**
 * Left rail — projects, work, and agents.
 *
 * 268px fixed: the rails never flex, so the center stage absorbs every width
 * change and the terminal is the only thing that resizes with the window.
 *
 * Placeholder until story 030 builds the tab bar and its three panels.
 */
export function LeftRail() {
  return (
    <nav
      aria-label="Projects, work, and agents"
      className="w-[268px] shrink-0 overflow-y-auto border-r border-border-soft bg-panel"
    />
  );
}
