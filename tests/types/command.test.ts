import { describe, expect, it } from 'vitest';

import { ADVERTISED_VERBS, CONSOLE_VERBS, QUIET_VERBS } from '@/types/command';

/**
 * The grammar has two lists — what parses and what is taught — and the second
 * is derived from the first. These pin the derivation, because a hand-copied
 * `ADVERTISED_VERBS` is exactly the drift the constant exists to prevent.
 */
describe('ADVERTISED_VERBS', () => {
  it('is CONSOLE_VERBS with the quiet verbs removed, in the same order', () => {
    expect(ADVERTISED_VERBS).toEqual(
      CONSOLE_VERBS.filter((verb) => !QUIET_VERBS.has(verb)),
    );
  });

  it('keeps `answer` quiet — parsed, but not advertised', () => {
    // The ask card in the inbox is the route to an open ask; the console verb
    // stays for whoever already knows it and is taught nowhere.
    expect(CONSOLE_VERBS).toContain('answer');
    expect(ADVERTISED_VERBS).not.toContain('answer');
  });

  it('only ever quiets verbs the grammar actually has', () => {
    // A typo in `QUIET_VERBS` would silently hide nothing; this makes it loud.
    for (const verb of QUIET_VERBS) {
      expect(CONSOLE_VERBS).toContain(verb);
    }
  });
});
