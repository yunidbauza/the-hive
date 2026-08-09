import { describe, expect, it } from 'vitest';

import { sortEntries } from '@lib/explorer/sort';
import type { DirEntry } from '@shared/fs-contract';

/**
 * The one definition of directory order.
 *
 * Main returns entries unsorted on purpose, so this is the only place the order
 * is decided — and therefore the only place it needs pinning.
 */

const file = (name: string): DirEntry => ({ name, kind: 'file', size: 1 });
const dir = (name: string): DirEntry => ({ name, kind: 'dir', size: 0 });

const names = (entries: DirEntry[]) => entries.map((entry) => entry.name);

describe('sortEntries', () => {
  it('puts directories before files', () => {
    expect(names(sortEntries([file('a.ts'), dir('z-folder')]))).toEqual([
      'z-folder',
      'a.ts',
    ]);
  });

  /**
   * A raw code-point comparison sorts every uppercase name above every
   * lowercase one, which puts `AGENTS.md` and `README.md` at the top of a
   * repository listing and nothing else near them.
   */
  it('compares case-insensitively', () => {
    expect(names(sortEntries([file('beta.ts'), file('Alpha.ts')]))).toEqual([
      'Alpha.ts',
      'beta.ts',
    ]);
  });

  it('sorts numbers the way a person reads them', () => {
    expect(
      names(sortEntries([file('item-10.sql'), file('item-2.sql')])),
    ).toEqual(['item-2.sql', 'item-10.sql']);
  });

  it('does not mutate its argument', () => {
    const input = [file('b'), dir('a')];
    sortEntries(input);
    expect(names(input)).toEqual(['b', 'a']);
  });

  it('handles an empty listing', () => {
    expect(sortEntries([])).toEqual([]);
  });
});
