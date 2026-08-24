// @vitest-environment node
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectConfig } from '../../../../electron/shared/config-contract';

import { testProjectKey } from '@tests/support/project-key';

/**
 * The containment guard — **the security-critical module in this feature**.
 *
 * Real directories and real symlinks throughout, matching `probe.test.ts`. A
 * mocked `fs` here would assert the mock: the whole question is what the
 * *filesystem* says a path resolves to, and the case worth catching is exactly
 * the one a string check cannot see.
 */

const projects: ProjectConfig[] = [];

vi.mock('../../../../electron/main/config', () => ({
  getConfig: () => ({ projects }),
}));

const { contains, projectRoot, resolveExisting, resolveForWrite } = await import(
  '../../../../electron/main/fs/paths'
);

let root: string;
let outside: string;

/** A minimal usable entry. `status: 'ok'` is what makes a project readable. */
function mapProject(id: string, path: string | null, status = 'ok'): void {
  projects.length = 0;
  projects.push({
    id,
    name: id,
    path,
    icon: 'ph-folder',
    origin: 'local',
    status: status as ProjectConfig['status'],
    key: testProjectKey(id),
    isRepo: true,
  });
}

beforeEach(() => {
  // `realpathSync` on the way in: macOS puts temp dirs under a `/private`
  // symlink, so an un-resolved root would fail its own containment test.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-fs-root-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'hive-fs-outside-')));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'export {};\n');
  writeFileSync(join(outside, 'secret.txt'), 'password\n');
  mapProject('demo', root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  projects.length = 0;
});

describe('contains', () => {
  it('accepts the root itself and anything under it', () => {
    expect(contains('/w/app', '/w/app')).toBe(true);
    expect(contains('/w/app', '/w/app/src/index.ts')).toBe(true);
  });

  /**
   * The prefix bug, pinned.
   *
   * Without the separator, a project at `/w/app` considers `/w/app-secrets`
   * contained because the string starts with the root. It looks fine until
   * somebody has two sibling repositories.
   */
  it('rejects a sibling whose name merely starts with the root', () => {
    expect(contains('/w/app', '/w/app-secrets/.env')).toBe(false);
  });

  it('rejects an unrelated path', () => {
    expect(contains('/w/app', '/etc/passwd')).toBe(false);
  });
});

describe('projectRoot', () => {
  it('resolves a mapped, usable project', async () => {
    await expect(projectRoot('demo')).resolves.toBe(root);
  });

  it('refuses an id the config does not know', async () => {
    await expect(projectRoot('nope')).rejects.toMatchObject({ code: 'EPROJECT' });
  });

  /**
   * A project that exists but is unusable, and one that does not exist at all,
   * answer identically.
   *
   * That is deliberate: the difference is the only thing an id-probing loop
   * could extract from this verb, and it is worth nothing to the panel — which
   * renders the config's own `status` reason from a snapshot it already has.
   */
  it('refuses an unusable project the same way as an unknown one', async () => {
    mapProject('demo', root, 'missing');
    const unusable = await projectRoot('demo').catch((error: Error) => error);

    mapProject('demo', root);
    const unknown = await projectRoot('nope').catch((error: Error) => error);

    expect((unusable as Error).message).toBe((unknown as Error).message);
  });

  it('refuses a project whose path is null', async () => {
    mapProject('demo', null);
    await expect(projectRoot('demo')).rejects.toMatchObject({ code: 'EPROJECT' });
  });

  it('refuses a project whose directory has since been deleted', async () => {
    rmSync(root, { recursive: true, force: true });
    await expect(projectRoot('demo')).rejects.toMatchObject({ code: 'EPROJECT' });
  });
});

describe('resolveExisting', () => {
  it('resolves the project root for an empty relative path', async () => {
    await expect(resolveExisting('demo', '')).resolves.toMatchObject({
      absolute: root,
      root,
    });
  });

  it('resolves a nested file', async () => {
    await expect(resolveExisting('demo', 'src/app.ts')).resolves.toMatchObject({
      absolute: join(root, 'src', 'app.ts'),
    });
  });

  it('refuses a path that does not exist', async () => {
    await expect(resolveExisting('demo', 'src/gone.ts')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  /**
   * **The check a string guard cannot make.**
   *
   * `assertRelPath` sees `link/secret.txt` — relative, no `..`, no control
   * bytes — and passes it. Only asking the filesystem where `link` actually
   * goes settles it, which is why `realpath` runs before the containment test
   * and not after.
   */
  it('refuses a symlink pointing out of the project', async () => {
    symlinkSync(outside, join(root, 'link'));

    await expect(resolveExisting('demo', 'link/secret.txt')).rejects.toMatchObject(
      { code: 'EOUTSIDE' },
    );
  });

  it('refuses a symlinked directory that leaves the project', async () => {
    symlinkSync(outside, join(root, 'link'));
    await expect(resolveExisting('demo', 'link')).rejects.toMatchObject({
      code: 'EOUTSIDE',
    });
  });

  it('follows a symlink that stays inside the project', async () => {
    symlinkSync(join(root, 'src'), join(root, 'alias'));
    await expect(resolveExisting('demo', 'alias/app.ts')).resolves.toMatchObject({
      absolute: join(root, 'src', 'app.ts'),
    });
  });

  /**
   * Defence in depth: `assertRelPath` rejects these before main is reached, so
   * this asserts the second line rather than the first. A future caller that
   * skipped the guard must still not escape.
   */
  it('refuses a traversal that reaches outside', async () => {
    await expect(
      resolveExisting('demo', `../${join(outside).split('/').pop()}/secret.txt`),
    ).rejects.toMatchObject({ code: 'EOUTSIDE' });
  });

  it('refuses an absolute path', async () => {
    await expect(
      resolveExisting('demo', join(outside, 'secret.txt')),
    ).rejects.toMatchObject({ code: 'EOUTSIDE' });
  });
});

describe('resolveForWrite', () => {
  it('resolves a file that already exists', async () => {
    await expect(resolveForWrite('demo', 'src/app.ts')).resolves.toMatchObject({
      absolute: join(root, 'src', 'app.ts'),
    });
  });

  /**
   * The case `realpath` alone cannot handle.
   *
   * The target does not exist, so it cannot be resolved — only its parent can.
   * That is why the write path checks the parent and re-appends the basename
   * rather than resolving the whole thing.
   */
  it('resolves a file that does not exist yet', async () => {
    await expect(resolveForWrite('demo', 'src/new.ts')).resolves.toMatchObject({
      absolute: join(root, 'src', 'new.ts'),
    });
  });

  it('refuses when the parent directory does not exist', async () => {
    await expect(resolveForWrite('demo', 'nope/new.ts')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses writing to the project root itself', async () => {
    await expect(resolveForWrite('demo', '')).rejects.toMatchObject({
      code: 'EISDIR',
    });
  });

  /**
   * A file created inside a symlinked directory lands wherever the link goes.
   * Checking the parent is what makes the eventual write contained.
   */
  it('refuses a new file inside a symlinked directory that leaves the project', async () => {
    symlinkSync(outside, join(root, 'link'));
    await expect(resolveForWrite('demo', 'link/planted.txt')).rejects.toMatchObject(
      { code: 'EOUTSIDE' },
    );
  });

  it('refuses an absolute path', async () => {
    await expect(
      resolveForWrite('demo', join(outside, 'planted.txt')),
    ).rejects.toMatchObject({ code: 'EOUTSIDE' });
  });

  it('refuses an unknown project before touching the filesystem', async () => {
    await expect(resolveForWrite('nope', 'a.ts')).rejects.toMatchObject({
      code: 'EPROJECT',
    });
  });

  /**
   * **The second link, which an earlier revision missed.**
   *
   * Resolving the *parent* says nothing about the leaf: the parent is inside
   * the root and the joined path is inside the root, so both original checks
   * passed — and `writeFile` follows symlinks, so the bytes landed outside.
   * Only `lstat` on the target can see this.
   */
  it('refuses a target that is itself a symlink out of the project', async () => {
    const target = join(outside, 'secret.txt');
    symlinkSync(target, join(root, 'src', 'link.ts'));

    await expect(resolveForWrite('demo', 'src/link.ts')).rejects.toMatchObject({
      code: 'EOUTSIDE',
    });
  });

  it('refuses a dangling symlink rather than creating through it', async () => {
    symlinkSync(join(outside, 'not-there.txt'), join(root, 'src', 'dangling.ts'));

    await expect(
      resolveForWrite('demo', 'src/dangling.ts'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  /**
   * Containment is the property being defended, not the absence of links: an
   * in-repo symlink is ordinary and resolves to a real path inside the root.
   */
  it('follows a symlinked target that stays inside the project', async () => {
    symlinkSync(join(root, 'src', 'app.ts'), join(root, 'alias.ts'));

    await expect(resolveForWrite('demo', 'alias.ts')).resolves.toMatchObject({
      absolute: join(root, 'src', 'app.ts'),
    });
  });
});
