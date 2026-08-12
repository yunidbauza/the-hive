// @vitest-environment node
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../../../../electron/main/config/parse';
import { defaultShell } from '../../../../electron/main/config/shell';
import { writeConfig } from '../../../../electron/main/config/write';
import { CONFIG_PATH_ENV } from '../../../../electron/shared/config-contract';

/**
 * The single write path (story 101).
 *
 * Real files throughout. Every property under test — atomicity, the temp file
 * landing in the same directory, an out-of-band edit surviving, comment keys
 * round-tripping — is a property of the filesystem, and a mocked `fs` would
 * assert the mock rather than the behaviour.
 */

let dir: string;
let path: string;
let projectDir: string;
const originalConfigPath = process.env[CONFIG_PATH_ENV];
const originalShell = process.env.SHELL;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-write-'));
  path = join(dir, 'config.json');
  projectDir = join(dir, 'repo');
  mkdirSync(projectDir, { recursive: true });
  process.env[CONFIG_PATH_ENV] = path;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalConfigPath === undefined) delete process.env[CONFIG_PATH_ENV];
  else process.env[CONFIG_PATH_ENV] = originalConfigPath;
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
});

/** Seed the config file and return exactly what was written. */
const seed = (document: unknown): string => {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  writeFileSync(path, text);
  return text;
};

const entry = (id: string, at: string) => ({
  id,
  name: id,
  path: at,
  icon: 'ph-folder',
  origin: 'local',
});

describe('writeConfig — the round trip', () => {
  it('writes a file parseConfig reads back identically', () => {
    seed({ version: 2, projects: [] });

    const result = writeConfig((draft) => ({
      ...draft,
      projects: [entry('repo', projectDir)],
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.snapshot.errors).toEqual([]);
    expect(result.snapshot.projects[0]?.status).toBe('ok');

    const parsed = parseConfig(readFileSync(path, 'utf8'), 'config');
    expect(parsed.fatal).toBe(false);
    expect(parsed.projects[0]?.id).toBe('repo');
  });

  it('returns the fresh snapshot, so no reload is needed', () => {
    seed({ version: 2, shell: '/bin/zsh', projects: [] });

    const result = writeConfig((draft) => ({
      ...draft,
      projects: [entry('repo', projectDir)],
    }));

    if (!result.ok) throw new Error(result.reason);
    expect(result.snapshot.shell).toBe('/bin/zsh');
    expect(result.snapshot.configPath).toBe(path);
    expect(result.snapshot.projects).toHaveLength(1);
  });

  it('defaults the shell to the login shell, not $SHELL, when the file names none', () => {
    // Same technique as `index.test.ts`'s defaulting test: poison `$SHELL` with
    // a value `defaultShell()` could never return, then assert the result
    // equals `defaultShell()` and not the poisoned value. That proves both that
    // the fallback landed and that `$SHELL` was not consulted, and it stays
    // deterministic on any machine or CI runner regardless of the real login
    // shell.
    process.env.SHELL = '/bin/not-a-real-shell';
    seed({ version: 2, projects: [] });

    const result = writeConfig((draft) => ({
      ...draft,
      projects: [entry('repo', projectDir)],
    }));

    if (!result.ok) throw new Error(result.reason);
    expect(result.snapshot.shell).toBe(defaultShell());
    expect(result.snapshot.shell).not.toBe('/bin/not-a-real-shell');
  });

  it('ends the file with a trailing newline', () => {
    seed({ version: 2, projects: [] });

    writeConfig((draft) => ({ ...draft, projects: [] }));

    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });
});

describe('writeConfig — preservation', () => {
  /**
   * The template is deliberately comment-heavy. A UI that ate those comments
   * the first time the user clicked a button would make hand-editing and the
   * settings page mutually exclusive.
   */
  it('preserves "//" comment keys, unknown top-level keys, and key order', () => {
    seed({
      '//': 'this file documents itself',
      version: 2,
      '//projects': 'one entry per repository',
      projects: [],
      future: { untouched: true },
    });

    writeConfig((draft) => ({ ...draft, projects: [] }));

    const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(after['//']).toBe('this file documents itself');
    expect(after['//projects']).toBe('one entry per repository');
    expect(after.future).toEqual({ untouched: true });
    expect(Object.keys(after)).toEqual([
      '//',
      'version',
      '//projects',
      'projects',
      'future',
    ]);
  });

  it('preserves shell and claudeCommand it was not asked to change', () => {
    seed({ version: 2, shell: '/bin/fish', claudeCommand: 'claude-next', projects: [] });

    writeConfig((draft) => ({ ...draft, projects: [entry('repo', projectDir)] }));

    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.shell).toBe('/bin/fish');
    expect(after.claudeCommand).toBe('claude-next');
  });

  it('writes version 2, upgrading a v1 file on the first save', () => {
    seed({ '//': 'written by hand under 090', version: 1, projects: [] });

    writeConfig((draft) => ({ ...draft, projects: [] }));

    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.version).toBe(2);
    // The upgrade does not cost the user their comments.
    expect(after['//']).toBe('written by hand under 090');
  });
});

describe('writeConfig — refusal', () => {
  /**
   * A mutation cannot produce a bad *version* — `writeConfig` forces the
   * current one, so that path is closed by construction (asserted below). The
   * reachable way to build a result the reader rejects is a forbidden key, and
   * spreading a `JSON.parse`d object is how one becomes an *own* property.
   */
  it('refuses a mutation whose result the reader would reject, leaving the file byte-identical', () => {
    const before = seed({ version: 2, projects: [] });

    const result = writeConfig((draft) => ({
      ...draft,
      ...(JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>),
    }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toMatch(/could not read back/);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('forces the current version regardless of what the mutation returns', () => {
    seed({ version: 2, projects: [] });

    const result = writeConfig((draft) => ({ ...draft, version: 99 }));

    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(2);
  });

  it('refuses to write when the file on disk is already unreadable', () => {
    writeFileSync(path, '{ not json');

    const result = writeConfig((draft) => ({ ...draft, projects: [] }));

    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toMatch(/could not be read/);
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
  });

  it('refuses when the file does not exist at all', () => {
    rmSync(path, { force: true });

    const result = writeConfig((draft) => ({ ...draft, projects: [] }));

    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toMatch(/could not read/);
  });

  /**
   * An unknown top-level key is advisory, not fatal — so a config carrying one
   * must stay writable. This is the case that makes `errors.length` the wrong
   * refusal test and `fatal` the right one.
   */
  it('still writes a file that carries an unknown top-level key', () => {
    seed({ version: 2, future: 'x', projects: [] });

    const result = writeConfig((draft) => ({
      ...draft,
      projects: [entry('repo', projectDir)],
    }));

    if (!result.ok) throw new Error(result.reason);
    expect(result.snapshot.projects).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, 'utf8')).future).toBe('x');
  });

  it('reports a write failure without losing the previous config', () => {
    const before = seed({ version: 2, projects: [] });
    // A read-only directory makes both the temp write and the rename fail.
    chmodSync(dir, 0o500);

    const result = writeConfig((draft) => ({ ...draft, projects: [] }));

    chmodSync(dir, 0o700);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toMatch(/could not write/);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

describe('writeConfig — atomicity', () => {
  it('leaves no temp file behind', () => {
    seed({ version: 2, projects: [] });

    writeConfig((draft) => ({ ...draft, projects: [entry('repo', projectDir)] }));

    expect(readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('leaves no temp file behind when the write is refused', () => {
    seed({ version: 2, projects: [] });

    writeConfig((draft) => ({
      ...draft,
      ...(JSON.parse('{"__proto__":{}}') as Record<string, unknown>),
    }));

    expect(readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  /**
   * The cache is not the file. A user who edited the config in a text editor
   * after the app loaded must not have that edit silently discarded by the
   * next button click.
   */
  it('re-reads from disk: an out-of-band edit is not clobbered', () => {
    seed({ version: 2, shell: '/bin/zsh', projects: [] });
    seed({ version: 2, shell: '/bin/fish', projects: [] });

    writeConfig((draft) => ({ ...draft, projects: [entry('repo', projectDir)] }));

    expect(JSON.parse(readFileSync(path, 'utf8')).shell).toBe('/bin/fish');
  });
});
