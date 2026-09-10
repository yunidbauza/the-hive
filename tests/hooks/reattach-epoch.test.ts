import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Who re-establishes per-surface state after a reconnect (HIVE-150).
 *
 * A reconnect is a **new surface** on the machine that answers it: surface ids
 * are minted from a `WeakMap` keyed on the socket object
 * (`electron/main/ipc/surfaces.ts`), and HIVE-145 wired every piece of
 * per-surface state to be released when that socket goes away. The renderer
 * never unmounts, so nothing on this side would ever ask again.
 *
 * `useReattachEpoch` is the one mechanism that fixes it: a counter that moves
 * on every successful reattach, which the effects owning that state depend on
 * and re-run by React's own rules. One mechanism rather than N re-announce
 * hooks, because a checklist of hooks is a checklist somebody forgets — and the
 * defects HIVE-145 kept finding were exactly a piece of per-surface state
 * nobody remembered to key.
 *
 * This scans source text rather than behaviour on purpose. The two specs beside
 * it prove each owner re-runs; what a per-owner test can never prove is that
 * the set of owners is *complete*. A third piece of per-surface state added
 * later without an epoch would pass every behavioural test in the repo and go
 * stale in silence on the first reconnect. This fails instead, and its message
 * says what to do about it.
 */

const ROOT = process.cwd();

/** Files that legitimately depend on the epoch, and what each one owns. */
const OWNERS: ReadonlyArray<{ path: string; owns: string }> = [
  {
    path: 'src/features/explorer/hooks/use-project-watcher.ts',
    owns: "the explorer's fs:watch, which the server releases with the old socket",
  },
  {
    path: 'src/hooks/use-foreground-session.ts',
    owns: "the ui:foreground record that suppresses a watched session's toasts",
  },
];

/**
 * Where per-surface state is established from.
 *
 * The renderer's two hook trees, deliberately, rather than all of `src/`: a
 * component reaching the bridge directly would already be breaking a rule this
 * repo enforces elsewhere, and widening the scan to catch that would make it
 * slow and noisy rather than more correct.
 */
const SEARCHED = ['src/hooks', 'src/features/explorer/hooks'] as const;

/** Every `.ts`/`.tsx` file under `dir`, repo-relative. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    .map((name) => join(dir, name));
}

describe('the reattach epoch', () => {
  it('is depended on by exactly the effects that own per-surface state', () => {
    const found = SEARCHED.flatMap(sourcesUnder).filter((path) =>
      readFileSync(join(ROOT, path), 'utf8').includes('useReattachEpoch'),
    );

    expect(
      found.sort(),
      'A file gained or lost `useReattachEpoch`. If it owns state the server ' +
        'keeps per surface — a watcher, a focus record — add it to OWNERS in ' +
        'this file with a sentence saying what it owns. If it does not own any, ' +
        'it should not be keyed on the epoch: a reconnect would re-run it for ' +
        'nothing. Terminals in particular must stay off it, because their ' +
        'continuity comes from `resumeFrom` and remounting one throws away the ' +
        'scrollback that resume just saved.',
    ).toEqual(OWNERS.map((owner) => owner.path).sort());
  });

  it('finds the files it claims to scan, so an empty match cannot pass', () => {
    /*
      The positive control this guard needs. Without it, a rename that emptied
      `SEARCHED` would make `found` empty — and the assertion above would then
      be comparing two empty lists only if OWNERS were also emptied, but a typo
      in a directory name would still narrow the scan silently.
    */
    const scanned = SEARCHED.flatMap(sourcesUnder);
    expect(scanned.length).toBeGreaterThan(5);
    for (const owner of OWNERS) expect(scanned).toContain(owner.path);
  });

  it('gives every owner a reason, so the list cannot rot into a bare list', () => {
    for (const owner of OWNERS) {
      expect(owner.owns.length, `${owner.path} has no reason beside it`).toBeGreaterThan(10);
    }
  });
});
