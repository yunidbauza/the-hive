import type { PrListState } from '@/types/pull-request';

/**
 * How a PR's state is coloured, and how its findings read.
 *
 * Pure functions over the PR's own fields, living in `features/shared` because
 * **two surfaces must agree**: the work panel's PR rows (032) and the PRs panel
 * (052). Those are separate feature slices that cannot import each other, so a
 * second copy of these rules would be a second source of truth — and the two
 * would drift the first time a state was added.
 */

const STATE_TEXT: Record<PrListState, string> = {
  // `open` and `approved` share a colour: both mean "alive and not yet landed".
  // The PRs panel (052) distinguishes them with a badge, not a hue.
  open: 'text-green',
  approved: 'text-green',
  draft: 'text-subtle',
  merged: 'text-brand',
};

/** The token utility for a PR state's label and icon. */
export function prStateText(state: PrListState): string {
  return STATE_TEXT[state];
}

/**
 * The findings flag, or `null` when there is nothing to flag.
 *
 * Returning `null` rather than an empty string keeps the caller's JSX honest —
 * `{findingsLabel(n)}` renders nothing at zero instead of an empty amber span
 * that still occupies its flex gap.
 */
export function findingsLabel(findings: number): string | null {
  return findings > 0 ? `⚠ ${findings}` : null;
}

/**
 * Screen-reader wording for the same count. The glyph above is decorative and
 * announces as "warning sign", which is not what the number means.
 */
export function findingsDescription(findings: number): string | null {
  if (findings <= 0) return null;
  return `${findings} open finding${findings === 1 ? '' : 's'}`;
}
