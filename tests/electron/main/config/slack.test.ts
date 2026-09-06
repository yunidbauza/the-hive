// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reloadConfig, setSlack } from '../../../../electron/main/config';
import { parseConfig } from '../../../../electron/main/config/parse';
import {
  CONFIG_PATH_ENV,
  DEFAULT_SLACK,
} from '../../../../electron/shared/config-contract';

/**
 * The slack block's defaulting (HIVE-124).
 *
 * `ConfigSnapshot.slack` is documented as always fully resolved, so the
 * contract under test is that a file naming nothing still answers with the
 * default — the same guarantee `receiver.test.ts` makes for its block. The
 * spread here is the one `loadConfig` and `writeConfig` both perform;
 * asserting it against the parser's output is what proves the two agree.
 */

const resolved = (parsed: { slack?: { socketMode?: boolean; commanders?: string[] } }) => ({
  ...DEFAULT_SLACK,
  ...parsed.slack,
});

const doc = (extra: object) =>
  JSON.stringify({ version: 2, projects: [], ...extra });

describe('slack resolution', () => {
  it('defaults to off with nobody allowed to command', () => {
    expect(DEFAULT_SLACK).toEqual({ socketMode: false, commanders: [] });
  });

  it('a file with no block resolves to the default', () => {
    expect(resolved(parseConfig(doc({}), 'config'))).toEqual({
      socketMode: false,
      commanders: [],
    });
  });

  it('a file naming both fields reads them', () => {
    const parsed = parseConfig(
      doc({ slack: { socketMode: true, commanders: ['U08BA712189'] } }),
      'config',
    );

    expect(resolved(parsed)).toEqual({
      socketMode: true,
      commanders: ['U08BA712189'],
    });
  });

  it('costs the block and nothing else when it is not an object', () => {
    const parsed = parseConfig(
      doc({ slack: 'yes', shell: '/bin/zsh' }),
      'config',
    );

    expect(resolved(parsed)).toEqual({ socketMode: false, commanders: [] });
    expect(parsed.shell).toBe('/bin/zsh');
    expect(parsed.errors.join(' ')).toContain('slack: expected an object');
  });

  it('drops a non-string commander and keeps the rest', () => {
    const parsed = parseConfig(
      doc({ slack: { commanders: ['U1', 7, '', 'U2'] } }),
      'config',
    );

    expect(parsed.slack?.commanders).toEqual(['U1', 'U2']);
    expect(parsed.errors.join(' ')).toContain('commanders');
  });

  it('reports a non-boolean switch and uses the default', () => {
    const parsed = parseConfig(
      doc({ slack: { socketMode: 'true' } }),
      'config',
    );

    expect(resolved(parsed).socketMode).toBe(false);
    expect(parsed.errors.join(' ')).toContain('socketMode');
  });

  it('a version 1 file still loads and gets the default', () => {
    const parsed = parseConfig(
      JSON.stringify({ version: 1, projects: [{ id: 'a', path: '~/a' }] }),
      'config',
    );

    expect(parsed.fatal).toBe(false);
    expect(resolved(parsed)).toEqual({ socketMode: false, commanders: [] });
  });
});

/**
 * The writer, tested against real files — because every property worth proving
 * here is a property of the *file*, the way `receiver.test.ts` argues it.
 */

const originalConfigPath = process.env[CONFIG_PATH_ENV];
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-slack-'));
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

describe('setSlack', () => {
  it('creates the block on a file that has none', () => {
    seed('{\n  "version": 2\n}\n');

    const snapshot = setSlack({ socketMode: true, commanders: ['U1'] });

    expect(snapshot.slack).toEqual({ socketMode: true, commanders: ['U1'] });
    expect(onDisk().slack).toEqual({ socketMode: true, commanders: ['U1'] });
  });

  it('leaves the key absent until something is actually set', () => {
    seed('{\n  "version": 2\n}\n');

    // Reading is not writing: the default is applied in memory only.
    expect(onDisk().slack).toBeUndefined();
  });

  it('changes one field without restating the other', () => {
    seed(
      '{\n  "version": 2,\n  "slack": { "socketMode": true, "commanders": ["U1"] }\n}\n',
    );

    setSlack({ commanders: ['U1', 'U2'] });

    expect(onDisk().slack).toEqual({
      socketMode: true,
      commanders: ['U1', 'U2'],
    });
  });

  /**
   * The promise `setSlack`'s doc comment makes, and the reason it spreads the
   * block rather than rebuilding it.
   */
  it('preserves a sibling key this build does not know', () => {
    seed(
      '{\n  "version": 2,\n  "slack": { "socketMode": false, "future": true }\n}\n',
    );

    setSlack({ socketMode: true });

    expect(onDisk().slack).toEqual({ socketMode: true, future: true });
  });

  it('preserves unrelated top-level keys and hand-written comments', () => {
    seed(
      '{\n  "//mine": "a comment",\n  "version": 2,\n  "futureKey": "unknown",\n  "slack": { "socketMode": false }\n}\n',
    );

    setSlack({ socketMode: true });

    const after = onDisk();
    expect(after['//mine']).toBe('a comment');
    expect(after.futureKey).toBe('unknown');
    expect(after.slack).toEqual({ socketMode: true });
  });

  /**
   * A block the reader already complained about is replaced rather than merged
   * into — merging onto a string would produce something neither the user nor
   * the parser meant.
   */
  it('replaces a non-object block rather than merging into it', () => {
    seed('{\n  "version": 2,\n  "slack": "nope"\n}\n');

    setSlack({ socketMode: true });

    expect(onDisk().slack).toEqual({ socketMode: true });
  });
});
