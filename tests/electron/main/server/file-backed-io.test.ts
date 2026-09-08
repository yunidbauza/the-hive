// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIG_PATH_ENV } from '@shared/config-contract';

import { getConfig, reloadConfig } from '../../../../electron/main/config';
import { readServerDevicesFromDisk } from '../../../../electron/main/server/file-backed-io';

/**
 * `readServerDevicesFromDisk` against a real file (HIVE-142 review, N1).
 *
 * Follows `config/server.test.ts`'s own pattern: `CONFIG_PATH_ENV` points
 * `configPath()` at a throwaway temp file for the run, so this exercises the
 * real `readFileSync` + `parseConfig` path rather than a stubbed one.
 *
 * The property that actually matters — the reason this function exists
 * rather than a bare `getConfig().server.devices` — is the last test: a
 * change on disk this function sees must **not** also change what
 * `getConfig()` answers everywhere else in the process. Everything above it
 * is `parseConfig`'s own contract (already covered by `config/parse.test.ts`
 * and `config/server.test.ts`), asserted again here only because this
 * function is the one place a malformed or absent file must fail closed to
 * `[]` rather than to whatever `loadConfig` would do with it (a template
 * write, a thrown error) — see this function's own doc comment.
 */

const originalConfigPath = process.env[CONFIG_PATH_ENV];
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-file-backed-io-'));
  path = join(dir, 'config.json');
  process.env[CONFIG_PATH_ENV] = path;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalConfigPath === undefined) delete process.env[CONFIG_PATH_ENV];
  else process.env[CONFIG_PATH_ENV] = originalConfigPath;
});

// `credential.digest` must be a 64-character hex string (`HEX_SHA256` in
// `config/parse.ts`) or the parser drops the whole device — a fixed valid
// digest keeps these fixtures parseable rather than silently dropped.
const device = (id: string, name: string) => ({
  id,
  name,
  paired: '2026-09-07',
  revoked: false,
  credential: { kind: 'sha256' as const, digest: '0'.repeat(64) },
});

describe('readServerDevicesFromDisk', () => {
  it('reads the roster off a real file', () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 2, server: { devices: [device('d_1', 'MacBook')] } }),
    );

    expect(readServerDevicesFromDisk()).toEqual([device('d_1', 'MacBook')]);
  });

  it('answers [] for a file that does not exist', () => {
    // Nothing written to `path` — `configPath()` still resolves there.
    expect(readServerDevicesFromDisk()).toEqual([]);
  });

  it('answers [] for malformed JSON, rather than throwing or writing a template', () => {
    writeFileSync(path, '{ this is not json');

    expect(readServerDevicesFromDisk()).toEqual([]);
  });

  it('answers [] for an unsupported config version', () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 999, server: { devices: [device('d_1', 'MacBook')] } }),
    );

    expect(readServerDevicesFromDisk()).toEqual([]);
  });

  it('answers [] when the server block is absent or malformed', () => {
    writeFileSync(path, JSON.stringify({ version: 2 }));
    expect(readServerDevicesFromDisk()).toEqual([]);

    writeFileSync(path, JSON.stringify({ version: 2, server: 'nope' }));
    expect(readServerDevicesFromDisk()).toEqual([]);
  });

  it(
    'never installs its result as this process\'s cached config, even when the file on ' +
      'disk has changed since the cache was last primed (HIVE-142 review, N1)',
    () => {
      // Prime the shared cache from an initial file. `shell` is explicit
      // (rather than left absent) so this test does not depend on the test
      // machine's own default shell to tell the two files apart.
      writeFileSync(
        path,
        JSON.stringify({ version: 2, shell: '/bin/bash', server: { devices: [] } }),
      );
      reloadConfig();
      const before = getConfig();

      // Change the file to something the cache has never seen — the exact
      // situation a running server sees between a `--pair` one-shot's write
      // (a separate process) and this process's next manual reload.
      writeFileSync(
        path,
        JSON.stringify({
          version: 2,
          shell: '/bin/zsh',
          server: { devices: [device('d_9', 'iPad')] },
        }),
      );

      const devices = readServerDevicesFromDisk();

      // The narrow reader sees the new file...
      expect(devices).toEqual([device('d_9', 'iPad')]);

      // ...but the process-wide cache is untouched: the same object
      // reference, still describing the old file. `getConfig()` returns
      // `cached` directly and only ever replaces it inside `reloadConfig()`
      // — reference equality here is the proof that call never happened.
      const after = getConfig();
      expect(after).toBe(before);
      expect(after.server.devices).toEqual([]);
      expect(after.shell).toBe('/bin/bash');
    },
  );
});
