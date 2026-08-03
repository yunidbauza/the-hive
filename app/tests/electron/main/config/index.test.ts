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
