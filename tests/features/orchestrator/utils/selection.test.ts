import { describe, expect, it } from 'vitest';

import { effectiveSelId } from '@features/orchestrator/utils/selection';

/**
 * The two "no caret" states, which are not the same state.
 *
 * The fleet's selection is an entity id rather than a position, because
 * `useNavOrder` is sorted by recency and an index is therefore a fact about the
 * current fleet rather than about the caret. This is the one place that has to
 * decide what an *absent* id means.
 */
describe('effectiveSelId', () => {
  const fleet = ['hero-refresh', 'lead-form', 'webhooks'];

  it('keeps a chosen row', () => {
    expect(effectiveSelId('webhooks', fleet)).toBe('webhooks');
  });

  /**
   * Nothing chosen yet is the first row — what the index-based selection
   * expressed by defaulting to `0`, and what makes the documented `→` shortcut
   * work on a fresh launch instead of doing nothing until an arrow was pressed.
   */
  it('resolves an unset caret to the first row', () => {
    expect(effectiveSelId(null, fleet)).toBe('hero-refresh');
  });

  /**
   * A chosen row that has since aged out of the fleet gets **no** fallback. The
   * user did choose something and it is gone; moving their selection to a row
   * they never picked would be the quieter version of the bug this whole change
   * exists to remove.
   */
  it('does not rehome a selection whose row has gone', () => {
    expect(effectiveSelId('retired-01', fleet)).toBe('retired-01');
  });

  it('answers null for an empty fleet', () => {
    expect(effectiveSelId(null, [])).toBeNull();
  });
});
