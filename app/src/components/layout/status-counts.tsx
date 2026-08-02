import { useCounts } from '@stores/hive-store';

/**
 * Fleet-wide session counts — the one place the whole hive's health is visible
 * at a glance.
 *
 * The numbers are derived in the `useCounts()` selector, never stored, so a
 * status change anywhere updates this and nothing else re-renders. Working and
 * waiting are coloured because they are the two that want the user's attention;
 * idle and done stay muted on purpose.
 */
export function StatusCounts() {
  const { working, waiting, idle, done } = useCounts();

  return (
    <p className="font-mono text-xs text-muted">
      <span className="text-green">{working} working</span>
      {' · '}
      <span className="text-amber">{waiting} waiting</span>
      {` · ${idle} idle · ${done} done`}
    </p>
  );
}
