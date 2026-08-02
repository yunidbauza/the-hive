import { describe, expect, it } from 'vitest';

import {
  composeBadges,
  findingsDescription,
  findingsLabel,
  prStateText,
} from '@features/shared/pr-presentation';

/**
 * Pure rules, tested as pure functions. They live in `features/shared` because
 * the work panel (032) and the PRs panel (052) are separate slices that cannot
 * import each other, and both must colour a PR the same way.
 */
describe('prStateText', () => {
  it.each([
    ['open', 'text-green'],
    ['approved', 'text-green'],
    ['draft', 'text-subtle'],
    ['merged', 'text-brand'],
  ] as const)('colours %s as %s', (state, expected) => {
    expect(prStateText(state)).toBe(expected);
  });

  /** Both mean "alive, not yet landed"; 052 separates them with a badge. */
  it('gives open and approved the same colour', () => {
    expect(prStateText('open')).toBe(prStateText('approved'));
  });
});

describe('findingsLabel', () => {
  it('flags a positive count', () => {
    expect(findingsLabel(2)).toBe('⚠ 2');
  });

  it('is null at zero so the caller renders nothing', () => {
    expect(findingsLabel(0)).toBeNull();
  });

  it('is null for a negative count', () => {
    expect(findingsLabel(-1)).toBeNull();
  });
});

describe('findingsDescription', () => {
  it('spells out the count for screen readers', () => {
    expect(findingsDescription(2)).toBe('2 open findings');
  });

  it('uses the singular for one', () => {
    expect(findingsDescription(1)).toBe('1 open finding');
  });

  it('is null when there is nothing to describe', () => {
    expect(findingsDescription(0)).toBeNull();
  });
});

/**
 * One case per row of story 052's rule table, then the four fixture PRs. The
 * rule rows prove each condition in isolation; the fixtures prove the order and
 * the combinations the panel actually renders.
 */
describe('composeBadges', () => {
  it('badges a merged PR', () => {
    expect(
      composeBadges({ state: 'merged', findings: 0, checks: 'passing' }),
    ).toEqual([{ text: 'merged', tone: 'brand' }]);
  });

  /**
   * `approved` alone — no "no findings" beside it.
   *
   * Story 052's rule table restricts that badge to `state open`, and the
   * concept does the same. The story's own worked example contradicts both
   * ("#219 → approved + no findings"), which is why the story also says to
   * adjust the table if the concept differs. Two sources against one aside,
   * and the aside is redundant besides: `approved` already means a reviewer
   * looked and found nothing.
   */
  it('badges an approved PR without restating that it is clean', () => {
    expect(
      composeBadges({ state: 'approved', findings: 0, checks: 'passing' }),
    ).toEqual([{ text: 'approved', tone: 'green' }]);
  });

  it('badges a draft PR', () => {
    expect(
      composeBadges({ state: 'draft', findings: 0, checks: 'passing' }),
    ).toEqual([{ text: 'draft', tone: 'subtle' }]);
  });

  it('pluralises a findings count above one', () => {
    expect(
      composeBadges({ state: 'open', findings: 2, checks: 'passing' }),
    ).toEqual([{ text: '2 open findings', tone: 'amber' }]);
  });

  it('keeps a single finding singular', () => {
    expect(
      composeBadges({ state: 'open', findings: 1, checks: 'passing' }),
    ).toEqual([{ text: '1 open finding', tone: 'amber' }]);
  });

  /** "no findings" is reassurance about an *open* PR; a draft has not been reviewed. */
  it('says "no findings" only for a clean open PR', () => {
    expect(
      composeBadges({ state: 'open', findings: 0, checks: 'passing' }),
    ).toEqual([{ text: 'no findings', tone: 'subtle' }]);
    expect(
      composeBadges({ state: 'draft', findings: 0, checks: 'passing' }),
    ).not.toContainEqual({ text: 'no findings', tone: 'subtle' });
  });

  it('badges running checks', () => {
    expect(
      composeBadges({ state: 'open', findings: 1, checks: 'running' }),
    ).toEqual([
      { text: '1 open finding', tone: 'amber' },
      { text: 'checks running', tone: 'subtle' },
    ]);
  });

  it('badges failing checks in red', () => {
    expect(
      composeBadges({ state: 'open', findings: 1, checks: 'failing' }),
    ).toEqual([
      { text: '1 open finding', tone: 'amber' },
      { text: 'checks failing', tone: 'red' },
    ]);
  });

  it('says nothing about passing checks', () => {
    const texts = composeBadges({
      state: 'open',
      findings: 1,
      checks: 'passing',
    }).map((badge) => badge.text);
    expect(texts).not.toContain('checks running');
    expect(texts).not.toContain('checks failing');
  });

  /** The four fixture PRs, exactly as the panel renders them. */
  it('composes the fixture combinations', () => {
    expect(
      composeBadges({ state: 'open', findings: 2, checks: 'passing' }),
    ).toEqual([{ text: '2 open findings', tone: 'amber' }]);
    expect(
      composeBadges({ state: 'approved', findings: 0, checks: 'passing' }),
    ).toEqual([{ text: 'approved', tone: 'green' }]);
    expect(
      composeBadges({ state: 'draft', findings: 0, checks: 'running' }),
    ).toEqual([
      { text: 'draft', tone: 'subtle' },
      { text: 'checks running', tone: 'subtle' },
    ]);
    expect(
      composeBadges({ state: 'merged', findings: 0, checks: 'passing' }),
    ).toEqual([{ text: 'merged', tone: 'brand' }]);
  });
});
