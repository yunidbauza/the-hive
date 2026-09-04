// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reloadConfig, setReceiver } from '../../../../electron/main/config';
import { parseConfig } from '../../../../electron/main/config/parse';
import {
  CONFIG_PATH_ENV,
  DEFAULT_RECEIVER,
} from '../../../../electron/shared/config-contract';

/**
 * The receiver block's defaulting (HIVE-131).
 *
 * `ConfigSnapshot.receiver` is documented as always fully resolved, so the
 * contract under test is that a file naming nothing still answers with the
 * default — the same guarantee `jira.test.ts` makes for its block. The spread
 * here is the one `loadConfig` and `writeConfig` both perform; asserting it
 * against the parser's output is what proves the two agree.
 */

const resolved = (parsed: { receiver?: { hostAlias?: string } }) => ({
  ...DEFAULT_RECEIVER,
  ...parsed.receiver,
});

const doc = (extra: object) =>
  JSON.stringify({ version: 2, projects: [], ...extra });

describe('receiver resolution', () => {
  it('defaults to the Docker Desktop alias', () => {
    expect(DEFAULT_RECEIVER.hostAlias).toBe('host.docker.internal');
  });

  it('a file with no block resolves to the default', () => {
    expect(resolved(parseConfig(doc({}), 'config'))).toEqual({
      hostAlias: 'host.docker.internal',
    });
  });

  it('a file naming an alias overrides the default', () => {
    const parsed = parseConfig(
      doc({ receiver: { hostAlias: 'host.containers.internal' } }),
      'config',
    );

    expect(resolved(parsed)).toEqual({ hostAlias: 'host.containers.internal' });
  });

  it('a rejected alias falls back to the default rather than an empty string', () => {
    const parsed = parseConfig(doc({ receiver: { hostAlias: '' } }), 'config');

    expect(resolved(parsed)).toEqual({ hostAlias: 'host.docker.internal' });
  });

  it('a dropped block falls back to the default', () => {
    const parsed = parseConfig(doc({ receiver: 'nope' }), 'config');

    expect(resolved(parsed)).toEqual({ hostAlias: 'host.docker.internal' });
  });

  it('a version 1 file still loads and gets the default', () => {
    const parsed = parseConfig(
      JSON.stringify({ version: 1, projects: [{ id: 'a', path: '~/a' }] }),
      'config',
    );

    expect(parsed.fatal).toBe(false);
    expect(resolved(parsed)).toEqual({ hostAlias: 'host.docker.internal' });
  });
});

/**
 * The writer, tested against real files — because every property worth proving
 * here is a property of the *file*, the way `jira.test.ts` argues it.
 *
 * The sibling-key case is the one that matters most and that the e2e cannot
 * reach: `setReceiver`'s doc comment promises that a key this build has not
 * heard of survives a save, and the deferred opt-in `bind` block is exactly
 * that key. A user who hand-writes it before the follow-up story ships must not
 * lose it the first time they touch the alias field.
 */

const originalConfigPath = process.env[CONFIG_PATH_ENV];
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-receiver-'));
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

describe('setReceiver', () => {
  it('creates the block on a file that has none', () => {
    seed('{\n  "version": 2\n}\n');

    const snapshot = setReceiver({ hostAlias: 'host.containers.internal' });

    expect(snapshot.receiver).toEqual({ hostAlias: 'host.containers.internal' });
    expect(onDisk().receiver).toEqual({ hostAlias: 'host.containers.internal' });
  });

  it('leaves the key absent until something is actually set', () => {
    seed('{\n  "version": 2\n}\n');

    // Reading is not writing: the default is applied in memory only.
    expect(onDisk().receiver).toBeUndefined();
  });

  /**
   * The promise `setReceiver`'s doc comment makes, and the reason it spreads the
   * block rather than rebuilding it.
   */
  it('preserves a sibling key this build does not know', () => {
    seed(
      '{\n  "version": 2,\n  "receiver": { "hostAlias": "gateway", "bind": { "host": "0.0.0.0" } }\n}\n',
    );

    setReceiver({ hostAlias: 'host.docker.internal' });

    expect(onDisk().receiver).toEqual({
      hostAlias: 'host.docker.internal',
      bind: { host: '0.0.0.0' },
    });
  });

  it('preserves unrelated top-level keys and hand-written comments', () => {
    seed(
      '{\n  "//mine": "a comment",\n  "version": 2,\n  "futureKey": "unknown",\n  "receiver": { "hostAlias": "gateway" }\n}\n',
    );

    setReceiver({ hostAlias: 'host.docker.internal' });

    const after = onDisk();
    expect(after['//mine']).toBe('a comment');
    expect(after.futureKey).toBe('unknown');
    expect(after.receiver).toEqual({ hostAlias: 'host.docker.internal' });
  });

  /**
   * A block the reader already complained about is replaced rather than merged
   * into — merging onto a string would produce something neither the user nor
   * the parser meant.
   */
  it('replaces a non-object block rather than merging into it', () => {
    seed('{\n  "version": 2,\n  "receiver": "nope"\n}\n');

    setReceiver({ hostAlias: 'gateway' });

    expect(onDisk().receiver).toEqual({ hostAlias: 'gateway' });
  });
});
