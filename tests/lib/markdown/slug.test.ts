import { describe, expect, it } from 'vitest';

import { createSlugger } from '@lib/markdown/slug';

/** Parity with github-slugger, so `#anchors` written for GitHub work here. */
describe('createSlugger', () => {
  it('lowercases, drops punctuation and hyphenates spaces', () => {
    const slug = createSlugger();
    expect(slug('Hello World')).toBe('hello-world');
    expect(slug('What’s new?')).toBe('whats-new');
    expect(slug('Héllo & code')).toBe('héllo--code');
  });

  it('numbers duplicates, and a duplicate of a numbered one', () => {
    const slug = createSlugger();
    expect([slug('A'), slug('A'), slug('A-1')]).toEqual(['a', 'a-1', 'a-1-1']);
  });
});
