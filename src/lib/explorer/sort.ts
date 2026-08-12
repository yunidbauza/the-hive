import type { DirEntry } from '@shared/fs-contract';

/**
 * The one definition of directory order.
 *
 * Main deliberately returns entries unsorted — it reads what `readdir` gives it
 * and filters — so that this is the only place the order is decided. Sorting on
 * both sides is how a rendered directory comes to differ from the array a test
 * asserted against.
 *
 * Directories first, then files, each compared case-insensitively so `AGENTS.md`
 * does not sort above every lowercase name the way a raw code-point comparison
 * would. `numeric` makes `item-2` precede `item-10`, which is what anyone
 * looking at a list of migrations expects.
 *
 * `localeCompare` rather than `<`: the tree renders repository contents, and
 * repositories contain accented and non-Latin filenames.
 */
const collator = new Intl.Collator(undefined, {
  sensitivity: 'base',
  numeric: true,
});

export function sortEntries(entries: readonly DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
}
