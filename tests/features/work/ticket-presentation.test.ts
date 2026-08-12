import { describe, expect, it } from 'vitest';

import type { Ticket } from '@/types/ticket';

import { CATEGORY_TEXT, STATUS_PILL } from '@features/work/ticket-presentation';

/**
 * Constants, but not trivia (HIVE-79).
 *
 * These two exist because the status lozenge is painted by **two** components
 * now — `ticket-card.tsx` for a fixture with no Jira behind it, and
 * `ticket-transition-menu.tsx` for a real issue, where it doubles as the
 * dropdown's trigger. A second copy of either value is exactly the drift that
 * would make the same ticket render at two different sizes, or the same status
 * in two different colours, depending on where it came from.
 */
describe('CATEGORY_TEXT', () => {
  /**
   * Three buckets is the whole set, because `statusCategory` is
   * `new | indeterminate | done` at the source. A fourth key would mean someone
   * had started mapping status *names*, which is the thing HIVE-69 removed.
   */
  it('covers every category and nothing else', () => {
    const categories: Ticket['statusCategory'][] = ['todo', 'in-progress', 'done'];

    expect(Object.keys(CATEGORY_TEXT).sort()).toEqual([...categories].sort());
  });

  it('resolves each to a token-backed utility, never a literal colour', () => {
    for (const value of Object.values(CATEGORY_TEXT)) {
      expect(value).toMatch(/^text-[a-z-]+$/);
      expect(value).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
  });

  it('gives the three buckets three distinct colours', () => {
    expect(new Set(Object.values(CATEGORY_TEXT)).size).toBe(3);
  });
});

describe('STATUS_PILL', () => {
  /**
   * Layout only — no colour. The two callers compose it with
   * {@link CATEGORY_TEXT} and, in the interactive case, a hover fill. A colour
   * baked in here would override the category on one of them.
   */
  it('carries shape but not colour', () => {
    expect(STATUS_PILL).toContain('rounded-full');
    expect(STATUS_PILL).toContain('bg-chip');
    expect(STATUS_PILL).not.toMatch(/\btext-(brand|green|subtle|amber|red)\b/);
  });

  /**
   * `shrink-0` is what stops the lozenge collapsing when the Jira key is long —
   * the defect this whole change exists to fix, from the other side.
   */
  it('refuses to shrink', () => {
    expect(STATUS_PILL).toContain('shrink-0');
  });
});
