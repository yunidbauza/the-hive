// @vitest-environment node
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { execFileSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectConfig } from '../../../../electron/shared/config-contract';

/**
 * `fs:resolve`, against real files.
 *
 * Every question here is about where a string lands once the disk has been
 * asked — a symlink, a working directory, a directory that is not a file — so
 * these run against a real temp tree, as `read.test.ts` does. A mocked `fs`
 * would let each of them pass while asserting nothing about the thing they
 * exist to decide.
 */

const projects: ProjectConfig[] = [];

vi.mock('../../../../electron/main/config', () => ({
  getConfig: () => ({ projects }),
}));

const { resolvePaths } = await import('../../../../electron/main/fs/resolve');
const { setSessionCwdLookup, forgetProbedRoots } = await import(
  '../../../../electron/main/fs/session-roots'
);

let root: string;
let outside: string;

const file = (...parts: string[]): void => {
  const target = join(root, ...parts);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'x');
};

const resolveAll = (candidates: string[], sessionId?: string) =>
  resolvePaths({
    projectId: 'demo',
    candidates,
    ...(sessionId === undefined ? {} : { sessionId }),
  });

/** The verdicts alone — every test here is about those, never about the wrapper. */
const verdicts = async (candidates: string[], sessionId?: string) => {
  const result = await resolveAll(candidates, sessionId);
  return result.ok ? result.value.resolved : result.error;
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-fs-resolve-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'hive-fs-resolve-out-')));
  projects.length = 0;
  projects.push({
    id: 'demo',
    name: 'demo',
    path: root,
    icon: 'ph-folder',
    origin: 'local',
    status: 'ok',
    key: 'demo',
    isRepo: true,
  });
  file('src', 'app.ts');
  file('src', 'lib', 'util.ts');
  writeFileSync(join(outside, 'secret.txt'), 's');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  projects.length = 0;
  setSessionCwdLookup(null);
  forgetProbedRoots();
});

describe('resolvePaths', () => {
  it('answers index-aligned, with null for what it does not serve', async () => {
    await expect(
      resolveAll(['src/app.ts', 'nope.ts', 'src/lib/util.ts']),
    ).resolves.toEqual({
      ok: true,
      value: {
        resolved: [
          { relPath: 'src/app.ts', rootKey: '' },
          null,
          { relPath: 'src/lib/util.ts', rootKey: '' },
        ],
      },
    });
  });

  it('accepts an absolute path inside the root and refuses one outside', async () => {
    await expect(
      verdicts([join(root, 'src/app.ts'), join(outside, 'secret.txt')]),
    ).resolves.toEqual([{ relPath: 'src/app.ts', rootKey: '' }, null]);
  });

  /**
   * The three shapes that are *not* a file to open: a directory, a symlink
   * whose target leaves the root, and a traversal out of it. `realpath` runs
   * before the containment test, which is what makes the second one refusable
   * at all — the joined path is inside the root and the real one is not.
   */
  it('refuses a directory and a symlink that leaves the root', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'src', 'leak.txt'));
    await expect(verdicts(['src', 'src/leak.txt', '../'])).resolves.toEqual([
      null,
      null,
      null,
    ]);
  });

  it('allows a symlink that resolves back inside the root', async () => {
    symlinkSync(join(root, 'src', 'app.ts'), join(root, 'alias.ts'));
    await expect(verdicts(['alias.ts'])).resolves.toEqual([
      { relPath: 'src/app.ts', rootKey: '' },
    ]);
  });

  /**
   * The homonym is the whole test.
   *
   * `util.ts` exists under *both* bases, so this is the only case that can
   * tell the order apart — every other candidate here exists under one base or
   * the other, and would answer the same if `bases` were reversed. Getting
   * this backwards is the failure `resolveOne`'s own comment describes: a
   * different file with the same name, handed over as the one that was
   * clicked.
   */
  it('prefers the session cwd over the root for a name that exists under both', async () => {
    file('util.ts');
    setSessionCwdLookup(() => join(root, 'src', 'lib'));
    await expect(verdicts(['util.ts'], 'sess')).resolves.toEqual([
      { relPath: 'src/lib/util.ts', rootKey: '' },
    ]);
  });

  it('resolves a relative candidate against the session cwd before the root', async () => {
    setSessionCwdLookup((id) =>
      id === 'sess' ? join(root, 'src', 'lib') : undefined,
    );
    await expect(
      verdicts(['util.ts', './util.ts', '../app.ts', 'src/app.ts'], 'sess'),
    ).resolves.toEqual([
      { relPath: 'src/lib/util.ts', rootKey: '' },
      { relPath: 'src/lib/util.ts', rootKey: '' },
      { relPath: 'src/app.ts', rootKey: '' },
      { relPath: 'src/app.ts', rootKey: '' },
    ]);
  });

  it('ignores a session cwd outside the root, and one that does not exist', async () => {
    setSessionCwdLookup(() => outside);
    await expect(verdicts(['secret.txt', 'src/app.ts'], 'sess')).resolves.toEqual([
      null,
      { relPath: 'src/app.ts', rootKey: '' },
    ]);

    setSessionCwdLookup(() => join(root, 'gone'));
    await expect(verdicts(['src/app.ts'], 'sess')).resolves.toEqual([
      { relPath: 'src/app.ts', rootKey: '' },
    ]);
  });

  it('expands ~/ and still requires containment', async () => {
    const home = process.env.HOME;
    process.env.HOME = root;
    try {
      await expect(verdicts(['~/src/app.ts', '~/../secret.txt'])).resolves.toEqual(
        [{ relPath: 'src/app.ts', rootKey: '' }, null],
      );
    } finally {
      process.env.HOME = home;
    }
  });

  it('answers an empty list without touching the disk', async () => {
    await expect(resolveAll([])).resolves.toEqual({
      ok: true,
      value: { resolved: [] },
    });
  });

  /**
   * The widened root, on a real linked worktree.
   *
   * `rootKey` is `''` in every other case here, so without this the
   * `session ?? ''` branch that exists *because* of worktrees is never
   * observed on its worktree side — and that branch is what keeps the editor's
   * buffer key honest: `src/app.ts` in the project and `src/app.ts` in a
   * worktree are two files, and they collide under one key unless the root
   * comes back with them. Real git, as `session-roots.test.ts` does, because
   * `git rev-parse --git-common-dir` is the whole mechanism being trusted.
   */
  it('answers relative to a linked worktree, and names it as the root', async () => {
    const git = (cwd: string, ...args: string[]): void => {
      execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
    };
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'hive-fs-resolve-repo-')));
    const tree = join(
      realpathSync(mkdtempSync(join(tmpdir(), 'hive-fs-resolve-wt-'))),
      'wt',
    );
    try {
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src', 'app.ts'), 'export {};\n');
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.email', 'test@example.com');
      git(repo, 'config', 'user.name', 'Test');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'first');
      git(repo, 'worktree', 'add', '-q', tree, '-b', 'feature');

      // Untracked, and written after the worktree was added, so it exists in
      // the project checkout and nowhere else.
      writeFileSync(join(repo, 'only-in-project.ts'), 'x');

      projects[0] = { ...projects[0]!, path: repo };
      const worktree = realpathSync(tree);
      setSessionCwdLookup(() => worktree);

      await expect(
        verdicts(['src/app.ts', 'only-in-project.ts'], 'sess'),
      ).resolves.toEqual([
        { relPath: 'src/app.ts', rootKey: worktree },
        // Proof the root really moved rather than merely being reported:
        // this file is in the project and is now out of reach.
        null,
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(dirname(tree), { recursive: true, force: true });
    }
  });

  it('fails as a whole only for an unknown project', async () => {
    const result = await resolvePaths({
      projectId: 'ghost',
      candidates: ['src/app.ts'],
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('EPROJECT');
  });
});
