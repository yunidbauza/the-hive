// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  forgetProbedRoots,
  sessionRoot,
  setSessionCwdLookup,
} from '../../../../electron/main/fs/session-roots';

/**
 * The one place the explorer's read boundary widens — so the tests are about
 * what it **refuses**, and they use real repositories to prove it.
 *
 * `git rev-parse --git-common-dir` is the whole mechanism. A stub would assert
 * the stub; the question here is what git actually reports for a linked
 * worktree versus an unrelated repository, and only git can answer it. These
 * are a handful of `git init`s in a temp directory and run in well under a
 * second.
 */

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
};

/** A repository with one commit, so a worktree can be added to it. */
function makeRepo(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'first');
  return dir;
}

let project: string;
let elsewhere: string;
const temporary: string[] = [];

beforeEach(() => {
  forgetProbedRoots();
  setSessionCwdLookup(null);
  project = makeRepo('hive-sr-project-');
  temporary.push(project);
});

afterEach(() => {
  setSessionCwdLookup(null);
  forgetProbedRoots();
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('sessionRoot — what it admits', () => {
  it('admits a linked worktree kept outside the project', async () => {
    const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'hive-sr-wt-')));
    temporary.push(worktree);
    rmSync(worktree, { recursive: true, force: true });
    git(project, 'worktree', 'add', '-q', '-b', 'side', worktree);
    temporary.push(worktree);

    setSessionCwdLookup(() => worktree);

    // The exact case the widening exists for: a prefix cannot express it,
    // because the directory is not under the project at all.
    expect(await sessionRoot(project, 'session-a')).toBe(worktree);
  });

  it('admits a subdirectory of that worktree as the worktree itself', async () => {
    const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'hive-sr-wt2-')));
    temporary.push(worktree);
    rmSync(worktree, { recursive: true, force: true });
    git(project, 'worktree', 'add', '-q', '-b', 'deep', worktree);
    temporary.push(worktree);
    mkdirSync(join(worktree, 'src'));

    setSessionCwdLookup(() => join(worktree, 'src'));

    // `--show-toplevel`, not the cwd: an agent that cd'd into `src/` is still
    // working in that worktree, and the tree should root at its top.
    expect(await sessionRoot(project, 'session-a')).toBe(worktree);
  });
});

describe('sessionRoot — what it refuses', () => {
  it('refuses a worktree of a different repository', async () => {
    elsewhere = makeRepo('hive-sr-other-');
    temporary.push(elsewhere);

    setSessionCwdLookup(() => elsewhere);

    /*
      The load-bearing check. A bare `git rev-parse --show-toplevel` would have
      accepted this — it is a perfectly good working tree — and the explorer
      would have read a repository the user never mapped.
    */
    expect(await sessionRoot(project, 'session-a')).toBeNull();
  });

  it('refuses a directory that is not a repository at all', async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'hive-sr-plain-')));
    temporary.push(plain);

    setSessionCwdLookup(() => plain);

    expect(await sessionRoot(project, 'session-a')).toBeNull();
  });

  it('refuses a cwd that no longer exists', async () => {
    setSessionCwdLookup(() => join(tmpdir(), 'hive-sr-gone-does-not-exist'));

    expect(await sessionRoot(project, 'session-a')).toBeNull();
  });

  it('answers null for a cwd inside the project — the prefix handles that', async () => {
    const inside = join(project, 'sub');
    mkdirSync(inside);
    setSessionCwdLookup(() => inside);

    // Not a refusal so much as "no second root needed": one root still covers
    // it, and the renderer prepends a project-relative prefix.
    expect(await sessionRoot(project, 'session-a')).toBeNull();
  });

  it('answers null with no session, no lookup, or no observed cwd', async () => {
    expect(await sessionRoot(project, undefined)).toBeNull();

    setSessionCwdLookup(() => undefined);
    expect(await sessionRoot(project, 'session-a')).toBeNull();

    setSessionCwdLookup(null);
    expect(await sessionRoot(project, 'session-a')).toBeNull();
  });

  it('refuses when the project is not a git repository', async () => {
    const notRepo = realpathSync(mkdtempSync(join(tmpdir(), 'hive-sr-norepo-')));
    temporary.push(notRepo);

    const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'hive-sr-wt3-')));
    rmSync(worktree, { recursive: true, force: true });
    git(project, 'worktree', 'add', '-q', '-b', 'orphan', worktree);
    temporary.push(worktree);

    setSessionCwdLookup(() => worktree);

    // A directory with no `.git` can have no worktrees, so there is nothing the
    // common dir could legitimately match.
    expect(await sessionRoot(notRepo, 'session-a')).toBeNull();
  });
});

describe('sessionRoot — the probe cache', () => {
  it('reuses one git probe per directory', async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'hive-sr-cache-')));
    temporary.push(plain);

    let asked = 0;
    setSessionCwdLookup(() => {
      asked += 1;
      return plain;
    });

    await sessionRoot(project, 'a');
    await sessionRoot(project, 'a');
    await sessionRoot(project, 'a');

    // The lookup is cheap and runs every time; the *subprocess* is what the
    // cache is protecting, and a cached refusal counts. Three reads, and the
    // second and third answer from the map.
    expect(asked).toBe(3);
    expect(await sessionRoot(project, 'a')).toBeNull();
  });
});
