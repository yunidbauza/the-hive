// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reloadConfig, setNotifications } from '../../../../electron/main/config';
import { CONFIG_PATH_ENV } from '../../../../electron/shared/config-contract';

/**
 * Story 106's mutating verb, against real files.
 *
 * The properties worth proving are all properties of the *file*: that a save
 * touches only the switch the user moved, that the block is absent until one is
 * moved at all, and that comments and unknown keys survive. A mocked `fs` would
 * assert the mock.
 */

let dir: string;
let path: string;
const originalConfigPath = process.env[CONFIG_PATH_ENV];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-notify-'));
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

describe('setNotifications', () => {
  it('writes only the class named, leaving a hand-written sibling alone', () => {
    seed('{\n  "version": 2,\n  "notifications": { "sessionDone": false }\n}\n');

    const snapshot = setNotifications({ sessionIdle: true });

    expect(snapshot.notifications).toEqual({
      sessionDone: false,
      sessionIdle: true,
      cloneDone: true,
    });
    expect(onDisk().notifications).toEqual({
      sessionDone: false,
      sessionIdle: true,
    });
  });

  it('creates the block on a file that has none', () => {
    seed('{\n  "version": 2\n}\n');

    setNotifications({ cloneDone: false });

    expect(onDisk().notifications).toEqual({ cloneDone: false });
  });

  it('leaves the key absent until a switch is actually moved', () => {
    seed('{\n  "version": 2\n}\n');

    // Reading is not writing: the defaults are applied in memory only.
    expect(onDisk().notifications).toBeUndefined();
  });

  it('writes only the keys the user has touched, not all three', () => {
    seed('{\n  "version": 2\n}\n');

    setNotifications({ sessionIdle: true });

    // The other two are defaulted in memory. Materialising them here would
    // silently freeze today's defaults into the user's file, so a later change
    // to `DEFAULT_NOTIFICATIONS` would not reach anyone who had ever opened
    // this section.
    expect(onDisk().notifications).toEqual({ sessionIdle: true });
  });

  it('preserves comment keys across the write', () => {
    seed(
      '{\n  "//": "hand written, keep me",\n  "version": 2,\n  "projects": []\n}\n',
    );

    setNotifications({ sessionDone: false });

    expect(onDisk()['//']).toBe('hand written, keep me');
  });

  it('preserves unknown top-level keys across the write', () => {
    seed('{\n  "version": 2,\n  "futureThing": { "a": 1 }\n}\n');

    setNotifications({ sessionDone: false });

    expect(onDisk().futureThing).toEqual({ a: 1 });
  });

  it('preserves an unknown key *inside* the block — a class a later story adds', () => {
    seed(
      '{\n  "version": 2,\n  "notifications": { "sessionDone": true, "waiting": true }\n}\n',
    );

    setNotifications({ cloneDone: false });

    expect(onDisk().notifications).toEqual({
      sessionDone: true,
      waiting: true,
      cloneDone: false,
    });
  });

  it('replaces a block that was not an object rather than merging into it', () => {
    seed('{\n  "version": 2,\n  "notifications": "on"\n}\n');

    setNotifications({ sessionDone: false });

    expect(onDisk().notifications).toEqual({ sessionDone: false });
  });

  it('returns a snapshot describing the file, not the request', () => {
    seed('{\n  "version": 2,\n  "notifications": { "cloneDone": false }\n}\n');

    const snapshot = setNotifications({ sessionDone: false });

    expect(snapshot.notifications).toEqual({
      sessionDone: false,
      sessionIdle: false,
      cloneDone: false,
    });
  });

  it('keeps projects untouched', () => {
    seed(
      `{\n  "version": 2,\n  "projects": [{ "id": "hive", "path": "${dir}" }]\n}\n`,
    );

    setNotifications({ sessionDone: false });

    expect(onDisk().projects).toEqual([{ id: 'hive', path: dir }]);
  });
});
