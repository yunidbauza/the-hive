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
    seed('{\n  "version": 2,\n  "notifications": { "session.blocked": "off" }\n}\n');

    const snapshot = setNotifications({ 'clone.done': 'inbox' });

    // The snapshot is fully resolved — every registered kind answers — so the
    // assertion names the two that matter rather than restating the registry.
    expect(snapshot.notifications).toMatchObject({
      'session.blocked': 'off',
      'clone.done': 'inbox',
    });
    expect(onDisk().notifications).toEqual({
      'session.blocked': 'off',
      'clone.done': 'inbox',
    });
  });

  it('creates the block on a file that has none', () => {
    seed('{\n  "version": 2\n}\n');

    setNotifications({ 'clone.done': 'off' });

    expect(onDisk().notifications).toEqual({ 'clone.done': 'off' });
  });

  it('leaves the key absent until a switch is actually moved', () => {
    seed('{\n  "version": 2\n}\n');

    // Reading is not writing: the defaults are applied in memory only.
    expect(onDisk().notifications).toBeUndefined();
  });

  it('writes only the keys the user has touched, not all three', () => {
    seed('{\n  "version": 2\n}\n');

    setNotifications({ 'session.blocked': 'inbox' });

    // The other two are defaulted in memory. Materialising them here would
    // silently freeze today's defaults into the user's file, so a later change
    // to `DEFAULT_NOTIFICATIONS` would not reach anyone who had ever opened
    // this section.
    expect(onDisk().notifications).toEqual({ 'session.blocked': 'inbox' });
  });

  it('preserves comment keys across the write', () => {
    seed(
      '{\n  "//": "hand written, keep me",\n  "version": 2,\n  "projects": []\n}\n',
    );

    setNotifications({ 'session.blocked': 'off' });

    expect(onDisk()['//']).toBe('hand written, keep me');
  });

  it('preserves unknown top-level keys across the write', () => {
    seed('{\n  "version": 2,\n  "futureThing": { "a": 1 }\n}\n');

    setNotifications({ 'session.blocked': 'off' });

    expect(onDisk().futureThing).toEqual({ a: 1 });
  });

  it('preserves an unknown key *inside* the block — a class a later story adds', () => {
    seed(
      '{\n  "version": 2,\n  "notifications": { "sessionDone": true, "waiting": true }\n}\n',
    );

    setNotifications({ 'clone.done': 'off' });

    expect(onDisk().notifications).toEqual({
      sessionDone: true,
      waiting: true,
      'clone.done': 'off',
    });
  });

  it('replaces a block that was not an object rather than merging into it', () => {
    seed('{\n  "version": 2,\n  "notifications": "on"\n}\n');

    setNotifications({ 'session.blocked': 'off' });

    expect(onDisk().notifications).toEqual({ 'session.blocked': 'off' });
  });

  it('returns a snapshot describing the file, not the request', () => {
    seed('{\n  "version": 2,\n  "notifications": { "clone.done": "off" }\n}\n');

    const snapshot = setNotifications({ 'session.blocked': 'off' });

    expect(snapshot.notifications).toMatchObject({
      'session.blocked': 'off',
      'clone.done': 'off',
    });
  });

  /**
   * The regression, and the nastiest one in HIVE-75.
   *
   * `loadConfig` migrates the legacy booleans, but the *write* path built its
   * snapshot with a plain spread — and that snapshot becomes the cache every
   * later read sees. So a user booted correctly with clone notifications off,
   * then changed any unrelated setting, and their toasts came back on with the
   * pane showing "System" selected.
   *
   * `sessionDone` no longer has anywhere to migrate to (HIVE-83 retired
   * `session.ended`), so `cloneDone` is the one legacy boolean left that can
   * still pin this down.
   */
  it('migrates the legacy cloneDone boolean in the snapshot it returns, not just on load', () => {
    seed('{\n  "version": 2,\n  "notifications": { "cloneDone": false }\n}\n');

    const snapshot = setNotifications({ 'pr.merged': 'off' });

    expect(snapshot.notifications['clone.done']).toBe('off');
    // And the raw legacy key does not leak into a fully-resolved object.
    expect(
      (snapshot.notifications as Record<string, unknown>).cloneDone,
    ).toBeUndefined();
  });

  it('keeps projects untouched', () => {
    seed(
      `{\n  "version": 2,\n  "projects": [{ "id": "hive", "path": "${dir}" }]\n}\n`,
    );

    setNotifications({ 'session.blocked': 'off' });

    expect(onDisk().projects).toEqual([{ id: 'hive', path: dir }]);
  });
});
