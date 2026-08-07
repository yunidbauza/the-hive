// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reloadConfig, setJira } from '../../../../electron/main/config';
import { parseConfig } from '../../../../electron/main/config/parse';
import { CONFIG_PATH_ENV } from '../../../../electron/shared/config-contract';

/**
 * The `jira` block (HIVE-67).
 *
 * Two halves. The reader is tested against strings, because that is what
 * `parse.ts` is for. The writer is tested against real files, because every
 * property worth proving there is a property of the *file*: that a save touches
 * only the field the user changed, and that a key this build has not heard of
 * survives — `jql` is exactly that key, and HIVE-69 adds it.
 */

const doc = (body: Record<string, unknown>): string =>
  JSON.stringify({ version: 2, ...body });

describe('parseConfig — jira', () => {
  it('is undefined when the file has no block', () => {
    expect(parseConfig(doc({}), 'config').jira).toBeUndefined();
  });

  it('reads both fields', () => {
    const parsed = parseConfig(
      doc({
        jira: { site: 'behiques.atlassian.net', email: 'me@example.com' },
      }),
      'config',
    );
    expect(parsed.jira).toEqual({
      site: 'behiques.atlassian.net',
      email: 'me@example.com',
    });
    expect(parsed.errors).toEqual([]);
  });

  it('is partial when the file names only one field', () => {
    const parsed = parseConfig(doc({ jira: { site: 'a.b.net' } }), 'config');
    expect(parsed.jira).toEqual({ site: 'a.b.net' });
  });

  it('does not report the block as an unknown top-level key', () => {
    const parsed = parseConfig(doc({ jira: { site: 'a.b.net' } }), 'config');
    expect(parsed.errors.join(' ')).not.toMatch(/unknown/i);
    expect(parsed.fatal).toBe(false);
  });

  it('reports a non-object block and ignores it, keeping the rest of the file', () => {
    const parsed = parseConfig(
      doc({ jira: 'nope', shell: '/bin/zsh' }),
      'config',
    );
    expect(parsed.jira).toBeUndefined();
    expect(parsed.shell).toBe('/bin/zsh');
    expect(parsed.errors.join(' ')).toMatch(/jira/);
    expect(parsed.fatal).toBe(false);
  });

  it('reports a non-string field and skips it rather than the whole block', () => {
    const parsed = parseConfig(
      doc({ jira: { site: 7, email: 'me@example.com' } }),
      'config',
    );
    expect(parsed.jira).toEqual({ email: 'me@example.com' });
    expect(parsed.errors.join(' ')).toMatch(/jira\.site/);
  });

  it('treats an empty string as absent rather than as a configured host', () => {
    const parsed = parseConfig(doc({ jira: { site: '   ' } }), 'config');
    expect(parsed.jira).toEqual({});
    expect(parsed.errors.join(' ')).toMatch(/jira\.site/);
  });

  it('costs only the block when it carries a forbidden key', () => {
    const parsed = parseConfig(
      '{"version":2,"shell":"/bin/zsh","jira":{"__proto__":{}}}',
      'config',
    );
    expect(parsed.jira).toBeUndefined();
    expect(parsed.shell).toBe('/bin/zsh');
    expect(parsed.fatal).toBe(false);
  });

  it('reports an unknown key inside the block', () => {
    const parsed = parseConfig(doc({ jira: { token: 'nope' } }), 'config');
    expect(parsed.errors.join(' ')).toMatch(/jira/);
  });
});

let dir: string;
let path: string;
const originalConfigPath = process.env[CONFIG_PATH_ENV];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-jira-'));
  path = join(dir, 'config.json');
  process.env[CONFIG_PATH_ENV] = path;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalConfigPath === undefined) delete process.env[CONFIG_PATH_ENV];
  else process.env[CONFIG_PATH_ENV] = originalConfigPath;
});

const seed = (text: string): void => {
  writeFileSync(path, text);
  reloadConfig();
};

const onDisk = (): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

describe('setJira', () => {
  it('writes only the field the request names', () => {
    seed('{\n  "version": 2,\n  "jira": { "site": "a.b.net" }\n}\n');

    const snapshot = setJira({ email: 'me@example.com' });

    expect(snapshot.jira).toEqual({
      site: 'a.b.net',
      email: 'me@example.com',
    });
    expect(onDisk().jira).toEqual({
      site: 'a.b.net',
      email: 'me@example.com',
    });
  });

  it('creates the block on a file that has none', () => {
    seed('{\n  "version": 2\n}\n');

    setJira({ site: 'a.b.net' });

    expect(onDisk().jira).toEqual({ site: 'a.b.net' });
  });

  it('leaves the key absent until something is actually set', () => {
    seed('{\n  "version": 2\n}\n');

    // Reading is not writing: the nulls are applied in memory only.
    expect(onDisk().jira).toBeUndefined();
  });

  it('preserves an unknown key inside the block — jql, which HIVE-69 adds', () => {
    seed(
      '{\n  "version": 2,\n  "jira": { "site": "a.b.net", "jql": "assignee = currentUser()" }\n}\n',
    );

    setJira({ email: 'me@example.com' });

    expect(onDisk().jira).toEqual({
      site: 'a.b.net',
      jql: 'assignee = currentUser()',
      email: 'me@example.com',
    });
  });

  it('removes a field when the request passes null, rather than storing ""', () => {
    seed(
      '{\n  "version": 2,\n  "jira": { "site": "a.b.net", "email": "me@example.com" }\n}\n',
    );

    setJira({ site: null });

    expect(onDisk().jira).toEqual({ email: 'me@example.com' });
    expect(setJira({ email: null }).jira).toEqual({ site: null, email: null });
  });

  it('replaces a block that was not an object rather than merging into it', () => {
    seed('{\n  "version": 2,\n  "jira": "behiques.atlassian.net"\n}\n');

    setJira({ site: 'a.b.net' });

    expect(onDisk().jira).toEqual({ site: 'a.b.net' });
  });

  it('never writes a token, because it has no way to receive one', () => {
    seed('{\n  "version": 2\n}\n');

    setJira({ site: 'a.b.net', email: 'me@example.com' });

    expect(JSON.stringify(onDisk())).not.toMatch(/token/i);
  });

  it('preserves comment keys and unknown top-level keys across the write', () => {
    seed(
      '{\n  "//": "hand written, keep me",\n  "version": 2,\n  "futureThing": { "a": 1 }\n}\n',
    );

    setJira({ site: 'a.b.net' });

    expect(onDisk()['//']).toBe('hand written, keep me');
    expect(onDisk().futureThing).toEqual({ a: 1 });
  });

  it('keeps projects untouched', () => {
    seed(
      `{\n  "version": 2,\n  "projects": [{ "id": "hive", "path": "${dir}" }]\n}\n`,
    );

    setJira({ site: 'a.b.net' });

    expect(onDisk().projects).toEqual([{ id: 'hive', path: dir }]);
  });

  it('returns a snapshot describing the file, not the request', () => {
    seed('{\n  "version": 2,\n  "jira": { "email": "me@example.com" }\n}\n');

    expect(setJira({ site: 'a.b.net' }).jira).toEqual({
      site: 'a.b.net',
      email: 'me@example.com',
    });
  });
});
