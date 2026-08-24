// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  deriveProjectId,
  deriveProjectKey,
} from '../../../../electron/main/config/identity';

/**
 * Project id derivation (story 101).
 *
 * The id is machinery, not a label: sessions reference projects through
 * `entity.project`, so these rules exist to make an id that never has to
 * change once it is written.
 */

const none = new Set<string>();

describe('deriveProjectId', () => {
  it('kebab-cases the directory name', () => {
    expect(deriveProjectId('My Project', none)).toBe('my-project');
    expect(deriveProjectId('The_Hive', none)).toBe('the-hive');
    expect(deriveProjectId('apfm.web', none)).toBe('apfm-web');
  });

  it('strips characters outside [a-z0-9-] and collapses runs', () => {
    expect(deriveProjectId('a  b//c', none)).toBe('a-b-c');
    expect(deriveProjectId('--lead--', none)).toBe('lead');
    expect(deriveProjectId('Ünïcødé', none)).toBe('n-c-d');
  });

  it('truncates to 40 characters', () => {
    expect(deriveProjectId('x'.repeat(60), none)).toHaveLength(40);
  });

  it('never ends on a dash after truncating', () => {
    // 39 x's then a separator: the naive slice would leave a trailing dash.
    expect(deriveProjectId(`${'x'.repeat(39)} tail`, none)).toBe('x'.repeat(39));
  });

  it('suffixes a collision with -2, then -3', () => {
    expect(deriveProjectId('repo', new Set(['repo']))).toBe('repo-2');
    expect(deriveProjectId('repo', new Set(['repo', 'repo-2']))).toBe('repo-3');
  });

  it('falls back when nothing survives sanitising', () => {
    expect(deriveProjectId('///', none)).toBe('project');
    expect(deriveProjectId('///', new Set(['project']))).toBe('project-2');
  });

  it('keeps a truncated id within 40 characters after suffixing', () => {
    const id = deriveProjectId('y'.repeat(60), new Set(['y'.repeat(40)]));

    expect(id.length).toBeLessThanOrEqual(40);
    expect(id.endsWith('-2')).toBe(true);
  });

  it('produces an id the config parser accepts', () => {
    // `parse.ts` runs every id through `assertId`, so a derived id that the
    // reader would reject is a write that refuses itself.
    expect(deriveProjectId('My Project', none)).toMatch(
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    );
    expect(deriveProjectId('///', none)).toMatch(
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    );
  });
});

/**
 * Project key derivation (HIVE-94).
 *
 * Unlike the id, the key is *typed by a human*, so these rules are judged by
 * guessability rather than by uniqueness alone: a key nobody would predict from
 * the project's name is a key they will look up every time, which is the
 * lookup the key exists to remove.
 */
describe('deriveProjectKey', () => {
  it('takes the initials of a multi-word name', () => {
    expect(deriveProjectKey('incorpx-server', none)).toBe('is');
    expect(deriveProjectKey('ai-sdk', none)).toBe('as');
    expect(deriveProjectKey('APFM Web', none)).toBe('aw');
  });

  it('takes a short single word whole', () => {
    expect(deriveProjectKey('hive', none)).toBe('hive');
    expect(deriveProjectKey('api', none)).toBe('api');
  });

  /*
    Three rather than four for a long word. A four-letter slice of `incorpx`
    reads like a truncation (`inco`); three reads like an abbreviation.
  */
  it('abbreviates a long single word to three letters', () => {
    expect(deriveProjectKey('incorpx', none)).toBe('inc');
    expect(deriveProjectKey('terraform', none)).toBe('ter');
  });

  /**
   * A leading article is dropped.
   *
   * `The Hive` is `hive`, not `th`. The article is not part of what anyone
   * calls the project, and initials that begin with one produce a key nobody
   * would guess — which is the only property that matters here.
   */
  it('drops a leading article before deciding', () => {
    expect(deriveProjectKey('the-hive', none)).toBe('hive');
    expect(deriveProjectKey('The Hive', none)).toBe('hive');
    expect(deriveProjectKey('a-portal', none)).toBe('por');
  });

  it('keeps an article that is the only word', () => {
    expect(deriveProjectKey('the', none)).toBe('the');
  });

  it('lowercases, and treats digits as separators rather than characters', () => {
    // `[a-z]{2,4}` has no room for a digit, so mapping one in is impossible;
    // splitting on it keeps the initials meaningful.
    expect(deriveProjectKey('incorpx2-server', none)).toBe('is');
    expect(deriveProjectKey('APFM', none)).toBe('apfm');
  });

  it('always produces something the pattern accepts', () => {
    for (const name of ['', '   ', '123', '—', 'x', 'Ünïcødé']) {
      expect(deriveProjectKey(name, none)).toMatch(/^[a-z]{2,4}$/);
    }
  });

  describe('collisions', () => {
    /**
     * The first fallback keeps growing the *last* word.
     *
     * `incorpx-server` and `incorpx-sdk` both want `is`; the loser becomes
     * `ise` and `isd` — still initials, with just enough of the tail to tell
     * them apart. That is what makes a collision readable rather than arbitrary.
     */
    it('extends with the next letters of the last word', () => {
      expect(deriveProjectKey('incorpx-server', new Set(['is']))).toBe('ise');
      expect(deriveProjectKey('incorpx-sdk', new Set(['is']))).toBe('isd');
      expect(deriveProjectKey('incorpx-server', new Set(['is', 'ise']))).toBe('iser');
    });

    it('extends a single word by one more letter', () => {
      expect(deriveProjectKey('incorpx', new Set(['inc']))).toBe('inco');
    });

    it('varies the last letter when the name has no more to give', () => {
      const key = deriveProjectKey('hive', new Set(['hive']));
      expect(key).toMatch(/^hiv[a-z]$/);
      expect(key).not.toBe('hive');
    });

    /*
      Never a digit — `deriveProjectId` takes a `-2` suffix, and this cannot,
      because `PROJECT_KEY_PATTERN` is closed to letters. A key that grew a
      digit would be a slug again rather than an alias.
    */
    it('never falls back to a numeric suffix', () => {
      const taken = new Set<string>();
      for (let n = 0; n < 60; n += 1) {
        const key = deriveProjectKey('hive', taken);
        expect(key).toMatch(/^[a-z]{2,4}$/);
        expect(taken.has(key)).toBe(false);
        taken.add(key);
      }
    });
  });
});
