/**
 * Activity rail — inbox, PRs, and the activity feed.
 *
 * 316px fixed, and the only region the shell can hide: `showActivityRail` in
 * the ui-store unmounts it so the terminal reclaims the width.
 *
 * Placeholder until story 050 builds the tab bar and its three panels.
 */
export function ActivityRail() {
  return (
    <aside
      aria-label="Activity"
      className="w-[316px] shrink-0 overflow-y-auto border-l border-border-soft bg-panel"
    />
  );
}
