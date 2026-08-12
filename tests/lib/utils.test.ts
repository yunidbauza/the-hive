import { describe, expect, it } from 'vitest';

import { cn } from '@lib/utils';

/**
 * Reference pattern for pure-function tests (story 013). Utility modules are
 * the cheapest coverage in the repo and the natural home for logic that would
 * otherwise hide inside a component.
 */
describe('cn', () => {
  it('joins class names', () => {
    expect(cn('flex', 'items-center')).toBe('flex items-center');
  });

  it('drops falsy values so conditional classes read cleanly', () => {
    expect(cn('flex', false && 'hidden', undefined, null, 'gap-2')).toBe(
      'flex gap-2',
    );
  });

  it('lets the last conflicting Tailwind utility win', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-ink', 'text-muted')).toBe('text-muted');
  });

  it('flattens arrays and objects', () => {
    expect(cn(['flex', 'gap-2'], { 'text-brand': true, hidden: false })).toBe(
      'flex gap-2 text-brand',
    );
  });
});
