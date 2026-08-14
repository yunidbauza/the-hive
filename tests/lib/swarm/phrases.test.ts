import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PHRASES, type PhraseKey, pickPhrase } from '@lib/swarm/phrases';

const KEYS = Object.keys(PHRASES) as PhraseKey[];

/**
 * The phrase bank, and the one function that reads it.
 *
 * The interesting property is not "does it return a string" — it is that the
 * app gained its first randomness here, and randomness that is not pinned down
 * turns every other test in the suite into a coin flip.
 */
describe('PHRASES', () => {
  it('carries every pool the surfaces ask for', () => {
    expect(KEYS.length).toBeGreaterThanOrEqual(17);
  });

  it('has at least two phrases in every pool', () => {
    /**
     * A pool of one is a constant wearing a pool's clothes: the surface would
     * look randomised in the source and never vary on screen, which is the
     * failure mode this whole change exists to remove.
     */
    const singletons = KEYS.filter((key) => PHRASES[key].length < 2);

    expect(singletons).toEqual([]);
  });

  it('carries the whole approved vocabulary', () => {
    const total = KEYS.reduce((sum, key) => sum + PHRASES[key].length, 0);

    expect(total).toBeGreaterThanOrEqual(55);
  });

  it('has no duplicate phrase inside a pool', () => {
    /**
     * A duplicate is invisible in review and doubles that line's odds forever.
     */
    for (const key of KEYS) {
      const pool = PHRASES[key];

      expect(new Set(pool).size, `${key} repeats a phrase`).toBe(pool.length);
    }
  });

  it('writes every phrase in the house register', () => {
    for (const key of KEYS) {
      for (const phrase of PHRASES[key]) {
        expect(phrase.trim(), `${key}: "${phrase}" has stray whitespace`).toBe(
          phrase,
        );
        /**
         * An empty list is not an emergency. The design system reserves amber
         * and red for things that went wrong, and an exclamation mark is the
         * typographic version of the same claim.
         */
        expect(phrase, `${key}: "${phrase}" shouts`).not.toContain('!');
      }
    }
  });
});

describe('pickPhrase', () => {
  it('only ever returns a phrase from the pool it was asked for', () => {
    for (const key of KEYS) {
      const pool: readonly string[] = PHRASES[key];

      for (let i = 0; i < pool.length * 4; i += 1) {
        expect(pool).toContain(pickPhrase(key));
      }
    }
  });

  /**
   * The property that matters: every line in the bank is reachable. A pool the
   * user can never see the last entry of is a pool that quietly shipped dead
   * copy, and `Math.floor(rng() * len)` is exactly the expression that gets
   * that wrong by one.
   */
  it('can reach every index of every pool', () => {
    for (const key of KEYS) {
      const pool: readonly string[] = PHRASES[key];
      const seen = pool.map((_, index) =>
        pickPhrase(key, () => index / pool.length),
      );

      expect(seen).toEqual([...pool]);
    }
  });

  it('survives an rng that returns exactly 1', () => {
    /**
     * `Math.random` never returns 1, but a stub written by hand routinely does.
     * Unclamped, that indexes past the end and returns `undefined`, which
     * reaches the screen as a blank line rather than as a failure.
     */
    for (const key of KEYS) {
      const pool: readonly string[] = PHRASES[key];

      expect(pool).toContain(pickPhrase(key, () => 1));
    }
  });

  it('survives an rng pinned at 0', () => {
    for (const key of KEYS) {
      expect(pickPhrase(key, () => 0)).toBe(PHRASES[key][0]);
    }
  });
});

/**
 * Every pool has a caller.
 *
 * The brief promised no dead pools, and a pool nobody reads is copy that was
 * written, reviewed and shipped to nowhere. Walking the source is cruder than a
 * type-level check but catches the thing a type cannot: a key that was wired up
 * and then quietly orphaned when a surface was rewritten.
 */
describe('every pool is referenced by application code', () => {
  const SRC = join(process.cwd(), 'src');

  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.tsx?$/.test(entry) && !full.endsWith(join('swarm', 'phrases.ts'))) {
        sources.push(readFileSync(full, 'utf8'));
      }
    }
  };
  walk(SRC);

  const haystack = sources.join('\n');

  it.each(KEYS)('%s is used somewhere in src/', (key) => {
    /**
     * Both quote styles, because a JSX attribute is written `phrase="x"` and a
     * plain call is written `pickPhrase('x')`. Checking only one of them would
     * have passed while half the pools were unreferenced.
     */
    const referenced =
      haystack.includes(`'${key}'`) || haystack.includes(`"${key}"`);

    expect(referenced).toBe(true);
  });
});
