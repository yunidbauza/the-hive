// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reloadConfig } from '../../../../electron/main/config';
import { parseConfig } from '../../../../electron/main/config/parse';
import { CONFIG_PATH_ENV, DEFAULT_REMOTE } from '../../../../electron/shared/config-contract';

/**
 * The remote block's defaulting (HIVE-144).
 *
 * `ConfigSnapshot.remote` is documented as always fully resolved, so the
 * contract under test is that a file naming nothing still answers with the
 * default — the same guarantee `server.test.ts` and `receiver.test.ts` make
 * for their blocks. The spread here is the one `loadConfig` and `writeConfig`
 * both perform; asserting it against the parser's output is what proves the
 * two agree.
 */

const resolved = (parsed: { remote?: { mode?: string; host?: string; port?: number } }) => ({
  ...DEFAULT_REMOTE,
  ...parsed.remote,
});

const doc = (extra: object) => JSON.stringify({ version: 2, projects: [], ...extra });

describe('remote resolution', () => {
  it('defaults to local mode with no target', () => {
    expect(DEFAULT_REMOTE).toEqual({ mode: 'local', host: '', port: 7433 });
  });

  it('a file with no block resolves to the default', () => {
    expect(resolved(parseConfig(doc({}), 'config'))).toEqual(DEFAULT_REMOTE);
  });

  it('a file naming only mode still gets the default host and port', () => {
    const parsed = parseConfig(doc({ remote: { mode: 'remote' } }), 'config');

    expect(resolved(parsed)).toEqual({
      mode: 'remote',
      host: DEFAULT_REMOTE.host,
      port: DEFAULT_REMOTE.port,
    });
  });

  it('a dropped block falls back to the default', () => {
    const parsed = parseConfig(doc({ remote: 'nope' }), 'config');

    expect(resolved(parsed)).toEqual(DEFAULT_REMOTE);
  });

  /**
   * Ruling 3 (HIVE-144): `host` is validated only when this block's own
   * `mode` is `'remote'`. `DEFAULT_REMOTE.host` is `''`, and every install
   * that has never attached carries exactly that — so a file explicitly
   * naming `mode: 'local'` and an empty `host` must resolve with **no
   * error**, not merely with the default value.
   */
  it('a local mode with an empty host resolves with no error', () => {
    const parsed = parseConfig(doc({ remote: { mode: 'local', host: '' } }), 'config');

    expect(resolved(parsed)).toEqual({ mode: 'local', host: '', port: DEFAULT_REMOTE.port });
    expect(parsed.errors).toEqual([]);
  });

  it('a bad host in remote mode falls back to the default and reports why', () => {
    const parsed = parseConfig(
      doc({ remote: { mode: 'remote', host: '203.0.113.7', port: 7433 } }),
      'config',
    );

    expect(resolved(parsed).host).toBe(DEFAULT_REMOTE.host);
    expect(parsed.errors.join(' ')).toContain('remote.host');
    expect(parsed.fatal).toBe(false);
  });
});

/**
 * The reader, tested against real files — the same rationale `server.test.ts`
 * and `receiver.test.ts` state: every property worth proving here is a
 * property of the *file*, and `loadConfig` (not a hand-rolled merge formula)
 * is the code path that ships. There is no `setRemote` yet — the mode switch
 * that will write this block is a later task — so this section covers only
 * the read side.
 */

const originalConfigPath = process.env[CONFIG_PATH_ENV];
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-remote-'));
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
};

describe('the remote block on a real snapshot', () => {
  it('a file with no remote key yields DEFAULT_REMOTE on the snapshot', () => {
    seed('{\n  "version": 2\n}\n');

    const snapshot = reloadConfig();

    expect(snapshot.remote).toEqual(DEFAULT_REMOTE);
  });

  it('a file naming a partial remote block carries the given fields, the rest defaulted', () => {
    seed('{\n  "version": 2,\n  "remote": { "mode": "remote" }\n}\n');

    const snapshot = reloadConfig();

    expect(snapshot.remote).toEqual({
      mode: 'remote',
      host: DEFAULT_REMOTE.host,
      port: DEFAULT_REMOTE.port,
    });
  });

  /**
   * The ruling this whole task exists to protect: every install that has
   * never attached carries `mode: 'local'` and an empty `host`, and that must
   * never surface in `ConfigSnapshot.errors` — a permanent false alarm in
   * Settings on a machine that has never used this feature.
   */
  it('mode local with no host produces no error on the snapshot', () => {
    seed('{\n  "version": 2,\n  "remote": { "mode": "local" }\n}\n');

    const snapshot = reloadConfig();

    expect(snapshot.remote).toEqual(DEFAULT_REMOTE);
    expect(snapshot.errors).toEqual([]);
  });
});
