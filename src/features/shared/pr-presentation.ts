import type { Pr, PrListState } from '@/types/pull-request';

import type { TagTone } from '@components/ui/tag';

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

export interface PrBadge {
  text: string;
  tone: TagTone;
}

/**
 * Story 052's badge rule table, in render order.
 *
 * Order is part of the contract, not an accident of the `if` chain: state first
 * (what the PR *is*), then findings (what it needs), then checks (what CI is
 * doing). Reordering changes what the eye reads first in a 316px column.
 *
 * `no findings` is deliberately restricted to `open`. On a draft it would be
 * reassurance about a review that has not happened, and on a merged PR it is
 * noise about a question already settled.
 *
 * Passing checks produce no badge at all — a green tick for the expected case
 * is the kind of chrome that makes the two states that matter harder to spot.
 *
 * Unlike the three helpers above, this one is consumed by the PRs panel alone.
 * The work panel's ticket rows (032) sit in a 320px rail where four wrapping
 * badges would break the row, so they keep their compact state-plus-count form
 * and share only the *colour* rules. Same source of truth, two densities.
 */
export function composeBadges(
  pr: Pick<Pr, 'state' | 'findings' | 'checks'>,
): PrBadge[] {
  const badges: PrBadge[] = [];

  if (pr.state === 'merged') badges.push({ text: 'merged', tone: 'brand' });
  if (pr.state === 'approved') badges.push({ text: 'approved', tone: 'green' });
  if (pr.state === 'draft') badges.push({ text: 'draft', tone: 'subtle' });

  if (pr.findings > 0) {
    badges.push({
      text: `${pr.findings} open finding${pr.findings === 1 ? '' : 's'}`,
      tone: 'amber',
    });
  } else if (pr.state === 'open') {
    badges.push({ text: 'no findings', tone: 'subtle' });
  }

  if (pr.checks === 'running') {
    badges.push({ text: 'checks running', tone: 'subtle' });
  }
  if (pr.checks === 'failing') {
    badges.push({ text: 'checks failing', tone: 'red' });
  }

  return badges;
}
