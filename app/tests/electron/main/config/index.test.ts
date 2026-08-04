// @vitest-environment node
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONFIG_PATH_ENV } from '../../../../electron/shared/config-contract';

/**
 * The config loader (story 090).
 *
 * These tests use a **real temporary directory** rather than a mocked `fs`.
 * Every assertion here is about what the filesystem actually does — `~`
 * expansion, symlink resolution, a path that is a file rather than a directory
 * — and a mock that answers those questions is a mock that encodes the
 * assumption under test. Nothing is spawned and nothing outlives the test, so
 * the objection `AGENTS.md` raises against real `node-pty` does not apply.
 */

let sandbox: string;
let home: string;
const originalHome = process.env.HOME;
const originalConfigPath = process.env[CONFIG_PATH_ENV];
const originalShell = process.env.SHELL;

/** Import fresh each time — the module caches its snapshot on purpose. */
async function loadConfig() {
  vi.resetModules();
  const module = await import('../../../../electron/main/config/index');
  return module.loadConfig();
}

/** Write a config file at the path `HIVE_CONFIG_PATH` points at. */
function writeConfig(contents: unknown): string {
  const path = join(sandbox, 'config.json');
  writeFileSync(
    path,
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  );
  process.env[CONFIG_PATH_ENV] = path;
  return path;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'hive-config-'));
  home = join(sandbox, 'home');
  mkdirSync(home, { recursive: true });
  // `os.homedir()` honours $HOME on POSIX, which is the platform this story
  // targets — no `node:os` mock needed, and none that could drift from it.
  process.env.HOME = home;
  process.env.SHELL = '/bin/zsh';
  delete process.env[CONFIG_PATH_ENV];
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalConfigPath === undefined) delete process.env[CONFIG_PATH_ENV];
  else process.env[CONFIG_PATH_ENV] = originalConfigPath;
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
});

describe('path resolution', () => {
  it('expands ~ to the home directory', async () => {
    mkdirSync(join(home, 'repos', 'apfm-web'), { recursive: true });
    writeConfig({
      version: 1,
      projects: [{ id: 'apfm-web', path: '~/repos/apfm-web' }],
    });

    const snapshot = await loadConfig();

    expect(snapshot.projects).toEqual([
      {
        id: 'apfm-web',
        // `realpathSync` also canonicalises the tmpdir (/var → /private/var on
        // macOS), so the expectation is realpath'd too. Asserting the raw join
        // would be asserting that resolution did *not* happen.
        path: realpathSync(join(home, 'repos', 'apfm-web')),
        status: 'ok',
        // The v1 upgrade, applied in memory (story 101). The file on disk is
        // still v1 and stays that way until the user saves something.
        name: 'apfm-web',
        icon: 'ph-folder',
        origin: 'local',
        isRepo: false,
      },
    ]);
  });

  it('rejects a relative path as not-absolute', async () => {
    writeConfig({
      version: 1,
      projects: [{ id: 'apfm-web', path: 'repos/apfm-web' }],
    });

    const snapshot = await loadConfig();

    expect(snapshot.projects[0]).toMatchObject({
      path: null,
      status: 'not-absolute',
    });
    expect(snapshot.errors.join('\n')).toContain('apfm-web');
  });

  it('resolves a symlink to its target, so the path handed to node-pty is the one validated', async () => {
    const real = join(sandbox, 'real-repo');
    const link = join(sandbox, 'linked-repo');
    mkdirSync(real);
    symlinkSync(real, link);
    writeConfig({ version: 1, projects: [{ id: 'apfm-web', path: link }] });

    const snapshot = await loadConfig();

    expect(snapshot.projects[0]?.status).toBe('ok');
    // `realpathSync` also canonicalises /var → /private/var on macOS, so the
    // assertion is "not the link", not a literal string.
    expect(snapshot.projects[0]?.path).not.toBe(link);
    expect(snapshot.projects[0]?.path?.endsWith('real-repo')).toBe(true);
  });

  it('reports a path that does not exist as missing', async () => {
    writeConfig({
      version: 1,
      projects: [{ id: 'apfm-web', path: join(sandbox, 'nope') }],
    });

    const snapshot = await loadConfig();

    expect(snapshot.projects[0]).toMatchObject({ path: null, status: 'missing' });
  });

  it('reports a file where a directory is expected as not-a-directory', async () => {
    const file = join(sandbox, 'a-file');
    writeFileSync(file, '');
    writeConfig({ version: 1, projects: [{ id: 'apfm-web', path: file }] });

    const snapshot = await loadConfig();

    expect(snapshot.projects[0]).toMatchObject({
      path: null,
      status: 'not-a-directory',
    });
  });
});

describe('duplicate ids', () => {
  it('keeps the first and reports the rest', async () => {
    const first = join(sandbox, 'first');
    const second = join(sandbox, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeConfig({
      version: 1,
      projects: [
        { id: 'apfm-web', path: first },
        { id: 'apfm-web', path: second },
      ],
    });

    const snapshot = await loadConfig();

    expect(snapshot.projects[0]?.status).toBe('ok');
    expect(snapshot.projects[0]?.path?.endsWith('first')).toBe(true);
    expect(snapshot.projects[1]).toMatchObject({
      id: 'apfm-web',
      path: null,
      status: 'duplicate-id',
    });
    expect(snapshot.errors.join('\n')).toContain('duplicate');
  });
});

describe('malformed input', () => {
  it('still produces a snapshot when the JSON is unparseable, and reports it once', async () => {
    writeConfig('{ this is not json');

    const snapshot = await loadConfig();

    expect(snapshot.projects).toEqual([]);
    expect(snapshot.errors).toHaveLength(1);
    expect(snapshot.errors[0]).toMatch(/json/i);
  });

  it('rejects a wrong schema version rather than guessing at it', async () => {
    writeConfig({ version: 99, projects: [{ id: 'apfm-web', path: sandbox }] });

    const snapshot = await loadConfig();

    expect(snapshot.projects).toEqual([]);
    expect(snapshot.errors.join('\n')).toContain('version');
  });

  it('reports an unknown top-level key without discarding the rest of the file', async () => {
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);
    writeConfig({
      version: 1,
      projects: [{ id: 'apfm-web', path: repo }],
      shel: '/bin/bash',
    });

    const snapshot = await loadConfig();

    expect(snapshot.projects[0]?.status).toBe('ok');
    expect(snapshot.errors.join('\n')).toContain('shel');
  });

  it('does not pollute Object.prototype from a __proto__ key', async () => {
    writeConfig('{"version":1,"projects":[],"__proto__":{"polluted":true}}');

    const snapshot = await loadConfig();

    expect(
      (Object.prototype as unknown as Record<string, unknown>).polluted,
    ).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(snapshot.errors.join('\n')).toContain('__proto__');
  });

  it('rejects a project entry whose id is not a usable lookup key', async () => {
    writeConfig({
      version: 1,
      projects: [{ id: '../etc', path: sandbox }],
    });

    const snapshot = await loadConfig();

    expect(snapshot.projects).toEqual([]);
    expect(snapshot.errors.join('\n')).toMatch(/id/i);
  });
});

describe('first run', () => {
  it('writes a template when no file exists, and that template parses clean', async () => {
    const path = join(home, '.hive', 'config.json');
    delete process.env[CONFIG_PATH_ENV];

    const first = await loadConfig();

    expect(first.configPath).toBe(path);
    expect(first.templateWritten).toBe(true);
    expect(first.projects).toEqual([]);
    expect(first.errors).toEqual([]);
    expect(readFileSync(path, 'utf8')).toContain('projects');

    // The whole point of writing a template rather than an empty file: the
    // next read must find a valid document, not a new set of errors.
    const second = await loadConfig();
    expect(second.templateWritten).toBe(false);
    expect(second.errors).toEqual([]);
  });

  it('logs the path once so a user can find the file they have never seen', async () => {
    delete process.env[CONFIG_PATH_ENV];

    await loadConfig();

    expect(console.info).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.info).mock.calls[0]?.join(' ')).toContain('.hive');
  });
});

describe('defaults', () => {
  it('falls back to $SHELL and the documented claude command', async () => {
    writeConfig({ version: 1, projects: [] });

    const snapshot = await loadConfig();

    expect(snapshot.shell).toBe('/bin/zsh');
    expect(snapshot.claudeCommand).toBe('claude');
  });

  it('lets the file override both', async () => {
    writeConfig({
      version: 1,
      shell: '/bin/bash',
      claudeCommand: 'claude --resume',
      projects: [],
    });

    const snapshot = await loadConfig();

    expect(snapshot.shell).toBe('/bin/bash');
    expect(snapshot.claudeCommand).toBe('claude --resume');
  });
});

describe(CONFIG_PATH_ENV, () => {
  it('takes precedence over ~/.hive/config.json, which is what isolates a test run', async () => {
    // A real config exists in the fake home and would be found without the env
    // var — the assertion is that it is not.
    mkdirSync(join(home, '.hive'), { recursive: true });
    writeFileSync(
      join(home, '.hive', 'config.json'),
      JSON.stringify({
        version: 1,
        projects: [{ id: 'real-project', path: sandbox }],
      }),
    );
    writeConfig({ version: 1, projects: [] });

    const snapshot = await loadConfig();

    expect(snapshot.configPath).toBe(join(sandbox, 'config.json'));
    expect(snapshot.projects).toEqual([]);
  });
});

describe('caching', () => {
  it('reads once and serves the same snapshot until an explicit reload', async () => {
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);
    const path = writeConfig({ version: 1, projects: [] });

    vi.resetModules();
    const module = await import('../../../../electron/main/config/index');

    expect(module.getConfig().projects).toEqual([]);

    writeFileSync(
      path,
      JSON.stringify({ version: 1, projects: [{ id: 'apfm-web', path: repo }] }),
    );

    // Still the first read — the file is not watched (out of scope).
    expect(module.getConfig().projects).toEqual([]);

    expect(module.reloadConfig().projects[0]).toMatchObject({
      id: 'apfm-web',
      status: 'ok',
    });
    expect(module.getConfig().projects).toHaveLength(1);
  });
});

describe('schema v1 compatibility (story 101)', () => {
  it('reads a v1 file, defaults the new fields, and leaves the file byte-identical', async () => {
    const repo = join(sandbox, 'legacy');
    mkdirSync(repo);
    const original = `${JSON.stringify(
      {
        '//': 'hand-written under story 090',
        version: 1,
        projects: [{ id: 'apfm-web', path: repo }],
      },
      null,
      2,
    )}\n`;
    const path = join(sandbox, 'config.json');
    writeFileSync(path, original);
    process.env[CONFIG_PATH_ENV] = path;

    const snapshot = await loadConfig();
    const entry = snapshot.projects[0];

    expect(entry?.status).toBe('ok');
    expect(entry?.name).toBe('legacy');
    expect(entry?.icon).toBe('ph-folder');
    expect(entry?.origin).toBe('local');

    // The upgrade is in memory. Reading someone's file and rewriting it before
    // they asked for anything is a surprise, not a migration — a v1 file the
    // user never edits through the UI stays v1 forever and keeps working.
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('still accepts a v2 file', async () => {
    const repo = join(sandbox, 'modern');
    mkdirSync(repo);
    writeConfig({
      version: 2,
      projects: [
        {
          id: 'modern',
          name: 'Modern',
          path: repo,
          icon: 'ph-folder',
          origin: 'local',
        },
      ],
    });

    const snapshot = await loadConfig();

    expect(snapshot.errors).toEqual([]);
    expect(snapshot.projects[0]).toMatchObject({
      id: 'modern',
      name: 'Modern',
      origin: 'local',
      status: 'ok',
    });
  });
});

/**
 * Mutation (story 101).
 *
 * These go through the module's cache deliberately: `addProject` reads
 * `getConfig()` to decide the id and to detect duplicates, so a test that
 * bypassed the cache would not exercise the path the IPC handler takes.
 */
async function mutable() {
  vi.resetModules();
  return import('../../../../electron/main/config/index');
}

describe('addProject', () => {
  it('adds a directory, deriving id and name from the basename', async () => {
    const repo = join(sandbox, 'my-repo');
    mkdirSync(repo);
    writeConfig({ version: 2, projects: [] });
    const module = await mutable();

    const snapshot = module.addProject({ path: repo });

    expect(snapshot.errors).toEqual([]);
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]?.id).toBe('my-repo');
    expect(snapshot.projects[0]?.name).toBe('my-repo');
    expect(snapshot.projects[0]?.status).toBe('ok');
    // The cache is refreshed, so main and the renderer cannot disagree.
    expect(module.getConfig().projects).toHaveLength(1);
  });

  it('rejects a relative path, a file, and a missing directory without writing', async () => {
    const file = join(sandbox, 'notes.txt');
    writeFileSync(file, 'not a directory');
    const path = writeConfig({ version: 2, projects: [] });
    const module = await mutable();

    expect(module.addProject({ path: 'relative/path' }).errors[0]).toMatch(
      /not-absolute/,
    );
    expect(module.addProject({ path: file }).errors[0]).toMatch(/not-a-directory/);
    expect(module.addProject({ path: join(sandbox, 'nope') }).errors[0]).toMatch(
      /missing/,
    );

    expect(module.getConfig().projects).toHaveLength(0);
    expect(JSON.parse(readFileSync(path, 'utf8')).projects).toEqual([]);
  });

  it('expands ~ and stores the path as the user wrote it', async () => {
    mkdirSync(join(home, 'tilde-repo'), { recursive: true });
    const path = writeConfig({ version: 2, projects: [] });
    const module = await mutable();

    const snapshot = module.addProject({ path: '~/tilde-repo' });

    expect(snapshot.projects[0]?.status).toBe('ok');
    // Resolved for identity and duplicate detection; stored verbatim, so the
    // file stays portable across machines with different home directories.
    expect(JSON.parse(readFileSync(path, 'utf8')).projects[0].path).toBe(
      '~/tilde-repo',
    );
  });

  it('is a no-op when the resolved path is already added', async () => {
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);
    writeConfig({ version: 2, projects: [] });
    const module = await mutable();

    module.addProject({ path: repo });
    const second = module.addProject({ path: repo });

    expect(second.projects).toHaveLength(1);
    expect(second.errors.some((error) => /already added/.test(error))).toBe(true);
  });

  it('suffixes a colliding id derived from the same basename', async () => {
    const first = join(sandbox, 'one', 'api');
    const second = join(sandbox, 'two', 'api');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    writeConfig({ version: 2, projects: [] });
    const module = await mutable();

    module.addProject({ path: first });
    const snapshot = module.addProject({ path: second });

    expect(snapshot.projects.map((entry) => entry.id)).toEqual(['api', 'api-2']);
  });

  it('honours an explicit name without changing the id', async () => {
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);
    writeConfig({ version: 2, projects: [] });
    const module = await mutable();

    const snapshot = module.addProject({ path: repo, name: 'My Repo' });

    expect(snapshot.projects[0]?.name).toBe('My Repo');
    expect(snapshot.projects[0]?.id).toBe('repo');
  });

  it('adds a directory that is not a git repository, tagging it', async () => {
    const plain = join(sandbox, 'plain');
    mkdirSync(plain);
    writeConfig({ version: 2, projects: [] });
    const module = await mutable();

    const snapshot = module.addProject({ path: plain });

    // A PTY needs a cwd, not a repo. Refusing here would be the app inventing
    // a rule the shell does not have.
    expect(snapshot.projects[0]?.status).toBe('ok');
    expect(snapshot.projects[0]?.isRepo).toBe(false);
  });

  it('upgrades a v1 file on the first add', async () => {
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);
    const path = writeConfig({ '//': 'kept', version: 1, projects: [] });
    const module = await mutable();

    module.addProject({ path: repo });

    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.version).toBe(2);
    expect(after['//']).toBe('kept');
  });
});

describe('removeProject', () => {
  it('drops exactly one entry and leaves every other line intact', async () => {
    const keep = join(sandbox, 'keep');
    const drop = join(sandbox, 'drop');
    mkdirSync(keep);
    mkdirSync(drop);
    const path = writeConfig({
      '//': 'kept',
      version: 2,
      projects: [
        { id: 'keep', name: 'Keep', path: keep, icon: 'ph-folder', origin: 'local' },
        { id: 'drop', name: 'Drop', path: drop, icon: 'ph-folder', origin: 'local' },
      ],
    });
    const module = await mutable();

    const snapshot = module.removeProject({ id: 'drop' });

    expect(snapshot.errors).toEqual([]);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after['//']).toBe('kept');
    expect(after.projects.map((entry: { id: string }) => entry.id)).toEqual(['keep']);
    expect(module.getConfig().projects).toHaveLength(1);
  });

  it('reports an unknown id without writing', async () => {
    const path = writeConfig({ version: 2, projects: [] });
    const before = readFileSync(path, 'utf8');
    const module = await mutable();

    const snapshot = module.removeProject({ id: 'ghost' });

    expect(snapshot.errors.some((error) => /no project with id "ghost"/.test(error))).toBe(
      true,
    );
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

/**
 * Regressions from the PR #40 self review.
 *
 * Both are cases where the *cache* and the *file* disagree — which they can,
 * because the config is deliberately not watched.
 */
describe('mutation against a file edited since load', () => {
  it('does not clobber the cache when a write is refused', async () => {
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);
    const path = writeConfig({
      version: 2,
      projects: [
        { id: 'repo', name: 'Repo', path: repo, icon: 'ph-folder', origin: 'local' },
      ],
    });
    const module = await mutable();
    expect(module.getConfig().projects).toHaveLength(1);

    // Make the file unreadable *after* load, so the write must refuse.
    writeFileSync(path, '{ not json');
    const snapshot = module.removeProject({ id: 'repo' });

    expect(snapshot.errors).toHaveLength(1);
    // The refusal reports the reason and keeps the projects. Caching the
    // failure would have made every mapped project unspawnable until an
    // explicit reload, without anything on disk having changed.
    expect(snapshot.projects).toHaveLength(1);
    expect(module.getConfig().projects).toHaveLength(1);
  });

  it('derives the id against the file, not the cache, so a hand-edit cannot collide', async () => {
    const first = join(sandbox, 'a', 'api');
    mkdirSync(first, { recursive: true });
    const path = writeConfig({ version: 2, projects: [] });
    const module = await mutable();

    // The user hand-edits the file while the app is running — the workflow this
    // story replaces but does not forbid — claiming the id `api`.
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        projects: [
          { id: 'api', name: 'Hand written', path: sandbox, icon: 'ph-folder', origin: 'local' },
        ],
      }),
    );

    const snapshot = module.addProject({ path: first });

    const ids = snapshot.projects.map((entry) => entry.id);
    expect(ids).toEqual(['api', 'api-2']);
    // Nothing was written that the reader would then disable.
    expect(snapshot.projects.every((entry) => entry.status !== 'duplicate-id')).toBe(
      true,
    );
  });

  it('detects a duplicate path added by hand since load', async () => {
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);
    const path = writeConfig({ version: 2, projects: [] });
    const module = await mutable();

    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        projects: [
          { id: 'byhand', name: 'By hand', path: repo, icon: 'ph-folder', origin: 'local' },
        ],
      }),
    );

    const snapshot = module.addProject({ path: repo });

    expect(snapshot.errors.some((error) => /already added/.test(error))).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).projects).toHaveLength(1);
  });
});

/**
 * Story 103's mutating verbs.
 *
 * Same harness as `addProject` above: a real temporary config, the module
 * imported fresh so its cache starts empty, and every assertion checked against
 * the file on disk as well as the returned snapshot — a verb that updated the
 * cache but not the file would otherwise pass.
 */
describe('renameProject', () => {
  it('writes the new name and leaves the id and path alone', async () => {
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);
    const path = writeConfig({
      version: 2,
      projects: [{ id: 'repo', name: 'repo', path: repo, icon: 'ph-folder' }],
    });
    const module = await mutable();

    const snapshot = module.renameProject({ id: 'repo', name: 'My Repo' });

    expect(snapshot.errors).toEqual([]);
    expect(snapshot.projects[0]?.name).toBe('My Repo');
    // The id is machinery: sessions reference it, so it must never drift.
    expect(snapshot.projects[0]?.id).toBe('repo');
    const written = JSON.parse(readFileSync(path, 'utf8')).projects[0];
    expect(written.name).toBe('My Repo');
    expect(written.id).toBe('repo');
    expect(written.path).toBe(repo);
    expect(module.getConfig().projects[0]?.name).toBe('My Repo');
  });

  it('preserves per-entry keys it does not own', async () => {
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);
    const path = writeConfig({
      version: 2,
      projects: [
        { id: 'repo', name: 'repo', path: repo, origin: 'cloned', note: 'keep me' },
      ],
    });
    const module = await mutable();

    module.renameProject({ id: 'repo', name: 'Renamed' });

    // The entry is spread, never rebuilt — which is the only reason a key this
    // build has never heard of survives the round trip.
    const written = JSON.parse(readFileSync(path, 'utf8')).projects[0];
    expect(written.origin).toBe('cloned');
    expect(written.note).toBe('keep me');
  });

  it('refuses an id that is not in the file, writing nothing', async () => {
    const path = writeConfig({ version: 2, projects: [] });
    const module = await mutable();

    const snapshot = module.renameProject({ id: 'ghost', name: 'Ghost' });

    expect(snapshot.errors[0]).toMatch(/no project with id "ghost"/);
    expect(JSON.parse(readFileSync(path, 'utf8')).projects).toEqual([]);
  });

  it('upgrades a v1 file to v2 on the first rename, keeping its comments', async () => {
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);
    const path = writeConfig({
      version: 1,
      '// note': 'hand written',
      projects: [{ id: 'repo', path: repo }],
    });
    const module = await mutable();

    module.renameProject({ id: 'repo', name: 'Upgraded' });

    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.version).toBe(2);
    expect(written['// note']).toBe('hand written');
    expect(written.projects[0].name).toBe('Upgraded');
  });
});

describe('repointProject', () => {
  it('writes the new path as the user wrote it and keeps origin', async () => {
    const old = join(sandbox, 'old');
    const moved = join(home, 'moved');
    mkdirSync(old);
    mkdirSync(moved);
    const path = writeConfig({
      version: 2,
      projects: [{ id: 'repo', name: 'Repo', path: old, origin: 'cloned' }],
    });
    const module = await mutable();

    const snapshot = module.repointProject({ id: 'repo', path: '~/moved' });

    expect(snapshot.errors).toEqual([]);
    expect(snapshot.projects[0]?.status).toBe('ok');
    const written = JSON.parse(readFileSync(path, 'utf8')).projects[0];
    // Stored verbatim so the file stays portable across machines; resolved only
    // for validation and identity.
    expect(written.path).toBe('~/moved');
    // Re-pointing changes where a project is, never where it came from.
    expect(written.origin).toBe('cloned');
    expect(written.name).toBe('Repo');
  });

  it('refuses a missing path, a file, and a relative path, writing nothing', async () => {
    const old = join(sandbox, 'old');
    const file = join(sandbox, 'a-file');
    mkdirSync(old);
    writeFileSync(file, '');
    const path = writeConfig({
      version: 2,
      projects: [{ id: 'repo', name: 'Repo', path: old }],
    });
    const module = await mutable();

    expect(module.repointProject({ id: 'repo', path: 'relative' }).errors[0]).toMatch(
      /not-absolute/,
    );
    expect(module.repointProject({ id: 'repo', path: file }).errors[0]).toMatch(
      /not-a-directory/,
    );
    expect(
      module.repointProject({ id: 'repo', path: join(sandbox, 'nope') }).errors[0],
    ).toMatch(/missing/);

    expect(JSON.parse(readFileSync(path, 'utf8')).projects[0].path).toBe(old);
  });

  it('refuses a path another project already occupies', async () => {
    const first = join(sandbox, 'first');
    const second = join(sandbox, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeConfig({
      version: 2,
      projects: [
        { id: 'first', name: 'First', path: first },
        { id: 'second', name: 'Second', path: second },
      ],
    });
    const module = await mutable();

    const snapshot = module.repointProject({ id: 'second', path: first });

    expect(snapshot.errors[0]).toMatch(/already added as "first"/);
  });

  it('permits re-pointing a project at the folder it already has', async () => {
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);
    writeConfig({ version: 2, projects: [{ id: 'repo', name: 'Repo', path: repo }] });
    const module = await mutable();

    // The duplicate check skips the project being moved: a no-op is something
    // the user is allowed to do, not a clash with itself.
    const snapshot = module.repointProject({ id: 'repo', path: repo });

    expect(snapshot.errors).toEqual([]);
    expect(snapshot.projects[0]?.status).toBe('ok');
  });

  it('refuses an id that is not in the file', async () => {
    writeConfig({ version: 2, projects: [] });
    const module = await mutable();
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);

    expect(module.repointProject({ id: 'ghost', path: repo }).errors[0]).toMatch(
      /no project with id "ghost"/,
    );
  });

  it('preserves top-level comment and unknown keys', async () => {
    const old = join(sandbox, 'old');
    const moved = join(sandbox, 'moved');
    mkdirSync(old);
    mkdirSync(moved);
    const path = writeConfig({
      version: 2,
      '// note': 'hand written',
      somethingElse: { kept: true },
      projects: [{ id: 'repo', name: 'Repo', path: old }],
    });
    const module = await mutable();

    module.repointProject({ id: 'repo', path: moved });

    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written['// note']).toBe('hand written');
    expect(written.somethingElse).toEqual({ kept: true });
  });

  it('preserves per-entry keys it does not own', async () => {
    const old = join(sandbox, 'old');
    const moved = join(sandbox, 'moved');
    mkdirSync(old);
    mkdirSync(moved);
    const path = writeConfig({
      version: 2,
      projects: [{ id: 'repo', name: 'Repo', path: old, note: 'keep me' }],
    });
    const module = await mutable();

    module.repointProject({ id: 'repo', path: moved });

    expect(JSON.parse(readFileSync(path, 'utf8')).projects[0].note).toBe('keep me');
  });
});

describe('reorderProjects', () => {
  /** Three real directories and a config listing them a, b, c. */
  async function threeProjects() {
    for (const name of ['a', 'b', 'c']) mkdirSync(join(sandbox, name));
    const path = writeConfig({
      version: 2,
      projects: ['a', 'b', 'c'].map((id) => ({
        id,
        name: id.toUpperCase(),
        path: join(sandbox, id),
      })),
    });
    return { path, module: await mutable() };
  }

  const idsIn = (path: string): string[] =>
    JSON.parse(readFileSync(path, 'utf8')).projects.map(
      (entry: { id: string }) => entry.id,
    );

  it('rewrites the array into the given order', async () => {
    const { path, module } = await threeProjects();

    const snapshot = module.reorderProjects({ ids: ['c', 'a', 'b'] });

    expect(snapshot.errors).toEqual([]);
    expect(snapshot.projects.map((project) => project.id)).toEqual(['c', 'a', 'b']);
    // The left rail reads this order positionally, so the array is the ordering
    // — there is nowhere else for it to live.
    expect(idsIn(path)).toEqual(['c', 'a', 'b']);
  });

  it('carries each entry across whole, including keys it does not own', async () => {
    mkdirSync(join(sandbox, 'a'));
    mkdirSync(join(sandbox, 'b'));
    const path = writeConfig({
      version: 2,
      projects: [
        { id: 'a', name: 'A', path: join(sandbox, 'a'), origin: 'cloned', note: 'keep' },
        { id: 'b', name: 'B', path: join(sandbox, 'b') },
      ],
    });
    const module = await mutable();

    module.reorderProjects({ ids: ['b', 'a'] });

    const written = JSON.parse(readFileSync(path, 'utf8')).projects;
    expect(written[0].id).toBe('b');
    expect(written[1]).toMatchObject({ id: 'a', origin: 'cloned', note: 'keep' });
  });

  it('refuses an ordering that is not a permutation of the file', async () => {
    const { path, module } = await threeProjects();

    // Too few: a project the renderer never knew about would be dropped.
    expect(module.reorderProjects({ ids: ['a', 'b'] }).errors[0]).toMatch(
      /does not match the projects on disk/,
    );
    // An id that is not there.
    expect(module.reorderProjects({ ids: ['a', 'b', 'z'] }).errors[0]).toMatch(
      /does not match the projects on disk/,
    );

    expect(idsIn(path)).toEqual(['a', 'b', 'c']);
  });

  it('refuses an ordering built before the file gained a project', async () => {
    const { path, module } = await threeProjects();
    // A hand edit between the renderer's read and its write. The config is
    // deliberately not watched, so this is the ordinary case, not a race.
    mkdirSync(join(sandbox, 'd'));
    const document = JSON.parse(readFileSync(path, 'utf8'));
    document.projects.push({ id: 'd', name: 'D', path: join(sandbox, 'd') });
    writeFileSync(path, JSON.stringify(document));

    const snapshot = module.reorderProjects({ ids: ['c', 'b', 'a'] });

    expect(snapshot.errors[0]).toMatch(/does not match the projects on disk/);
    expect(idsIn(path)).toEqual(['a', 'b', 'c', 'd']);
  });

  /**
   * The check that stops this verb destroying data.
   *
   * `parse.ts` reports an entry with no id and **skips** it, leaving it in the
   * file, so the renderer posts only the ids it can see. Comparing the payload
   * against the ids the map collected would agree with itself and write the
   * survivors — reporting success while deleting an entry the user never saw.
   */
  it('refuses rather than dropping an entry that has no id', async () => {
    for (const name of ['alpha', 'charlie']) mkdirSync(join(sandbox, name));
    const path = writeConfig({
      version: 2,
      projects: [
        { id: 'alpha', path: join(sandbox, 'alpha') },
        { path: join(sandbox, 'draft'), note: 'my notes' },
        { id: 'charlie', path: join(sandbox, 'charlie') },
      ],
    });
    const module = await mutable();

    const snapshot = module.reorderProjects({ ids: ['charlie', 'alpha'] });

    expect(snapshot.errors[0]).toMatch(/no id, or share one/);
    const after = JSON.parse(readFileSync(path, 'utf8')).projects;
    expect(after).toHaveLength(3);
    expect(after[1].note).toBe('my notes');
  });

  it('refuses rather than collapsing two entries that share an id', async () => {
    mkdirSync(join(sandbox, 'a1'));
    mkdirSync(join(sandbox, 'a2'));
    mkdirSync(join(sandbox, 'b'));
    const path = writeConfig({
      version: 2,
      projects: [
        { id: 'a', path: join(sandbox, 'a1') },
        { id: 'a', path: join(sandbox, 'a2') },
        { id: 'b', path: join(sandbox, 'b') },
      ],
    });
    const module = await mutable();

    // Last-wins in the lookup would delete the entry `resolveProjects` marks
    // `ok` and promote the one it disabled, silently repointing the project.
    const snapshot = module.reorderProjects({ ids: ['b', 'a'] });

    expect(snapshot.errors[0]).toMatch(/no id, or share one/);
    expect(JSON.parse(readFileSync(path, 'utf8')).projects).toHaveLength(3);
  });

  it('does not wipe a file whose entries are all unreadable', async () => {
    const path = writeConfig({
      version: 2,
      projects: [{ path: '/tmp/no-id-here' }],
    });
    const module = await mutable();

    expect(module.reorderProjects({ ids: [] }).errors[0]).toMatch(
      /no id, or share one/,
    );
    expect(JSON.parse(readFileSync(path, 'utf8')).projects).toHaveLength(1);
  });

  /**
   * `idOf` accepts any string; `parse` requires `ID_PATTERN`. So the file can
   * hold an entry main can address and the renderer cannot see, and the
   * refusal must not tell the user to do something that cannot help.
   */
  it('refuses an ordering built without an entry whose id the reader rejects', async () => {
    mkdirSync(join(sandbox, 'good'));
    const path = writeConfig({
      version: 2,
      projects: [
        { id: 'good', path: join(sandbox, 'good') },
        { id: 'has space', path: join(sandbox, 'good') },
      ],
    });
    const module = await mutable();

    const snapshot = module.reorderProjects({ ids: ['good'] });

    expect(snapshot.errors[0]).toMatch(/could not be read/);
    expect(JSON.parse(readFileSync(path, 'utf8')).projects).toHaveLength(2);
  });

  it('accepts an empty ordering for an empty file', async () => {
    writeConfig({ version: 2, projects: [] });
    const module = await mutable();

    expect(module.reorderProjects({ ids: [] }).errors).toEqual([]);
  });

  it('accepts the order the file already has', async () => {
    const { path, module } = await threeProjects();

    expect(module.reorderProjects({ ids: ['a', 'b', 'c'] }).errors).toEqual([]);
    expect(idsIn(path)).toEqual(['a', 'b', 'c']);
  });
});
