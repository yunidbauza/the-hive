// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reloadConfig, resetConfig } from '../../../../electron/main/config';
import {
  CONFIG_PATH_ENV,
  CONFIG_VERSION,
} from '../../../../electron/shared/config-contract';

/**
 * Reset to the first-run template (story 107).
 *
 * Against real files, like every other write test: the property under test is
 * that the *file* on disk is the template afterwards, and that the one promise
 * every other verb makes — comments and unknown keys survive — is deliberately
 * broken here. A mocked `fs` would assert the mock.
 */

let dir: string;
let path: string;
const originalConfigPath = process.env[CONFIG_PATH_ENV];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-reset-'));
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

describe('resetConfig', () => {
  it('replaces a populated config with the commented template', () => {
    seed(
      `${JSON.stringify(
        {
          version: 2,
          shell: '/bin/zsh',
          claudeCommand: 'claude --verbose',
          projects: [
            { id: 'repo', name: 'Repo', path: dir, icon: 'ph-folder', origin: 'local' },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const snapshot = resetConfig();

    expect(snapshot.projects).toEqual([]);
    expect(snapshot.errors).toEqual([]);

    const written = onDisk();
    expect(written.projects).toEqual([]);
    expect(written.version).toBe(CONFIG_VERSION);
    // Still the *commented* template, not a bare `{ projects: [] }` — that is
    // the whole reason the template is written rather than an empty document.
    expect(written['//']).toContain('The Hive');
    expect(written.shell).toBeUndefined();
    expect(written.claudeCommand).toBeUndefined();
  });

  it('discards the unknown keys and comments every other verb preserves', () => {
    seed(
      `${JSON.stringify(
        { version: 2, '//mine': 'keep me', future: 1, projects: [] },
        null,
        2,
      )}\n`,
    );

    resetConfig();

    const written = onDisk();
    expect(written['//mine']).toBeUndefined();
    expect(written.future).toBeUndefined();
  });

  it('returns a snapshot the renderer can install without reloading', () => {
    seed('{\n  "version": 2,\n  "notifications": { "sessionIdle": true }\n}\n');

    const snapshot = resetConfig();

    expect(snapshot.configPath).toBe(path);
    // Back to the defaults, because the file no longer names any of them.
    expect(snapshot.notifications).toEqual({
      sessionDone: true,
      sessionIdle: false,
      cloneDone: true,
    });
  });

  it('refuses and reports when there is no file to read', () => {
    // Deliberately not seeded: `writeConfig` will not rewrite a base it never
    // saw. Recreating the file is `reload`'s job, and having exactly one path
    // that creates it is worth the extra click.
    const snapshot = resetConfig();

    expect(snapshot.errors).toHaveLength(1);
    expect(snapshot.errors[0]).toContain('nothing was written');
  });
});
