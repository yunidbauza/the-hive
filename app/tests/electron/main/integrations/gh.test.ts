// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readGhStatus,
  type RunCommand,
} from '../../../../electron/main/integrations/gh';

/**
 * `gh` detection and auth status (story 106).
 *
 * The command runner is injected, so nothing here executes a real binary — the
 * behaviour under test is how output and exit codes are *read*, and a test that
 * shelled out would answer differently on every machine. The one thing proven
 * against the real filesystem is the search, because "found" has to mean an
 * executable file that is actually there.
 */

let dir: string;

const VERSION_OUT = 'gh version 2.62.0 (2024-11-14)\nhttps://github.com/cli/cli/releases/latest\n';

const AUTHED_OUT = `github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo'
`;

const NOT_AUTHED_ERR =
  'You are not logged into any GitHub hosts. To log in, run: gh auth login\n';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-gh-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Put a real, executable `gh` on a real directory and return that directory. */
function withGh(): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'gh');
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, 0o755);
  return dir;
}

/** A runner that answers by argv, and records what it was asked to execute. */
function runner(
  map: Record<string, { code: number; stdout?: string; stderr?: string }>,
  seen: { file: string; args: readonly string[] }[] = [],
): RunCommand {
  return (file, args) => {
    seen.push({ file, args });
    const hit = map[args.join(' ')];
    if (hit === undefined) return { code: 127, stdout: '', stderr: 'not found' };
    return { code: hit.code, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' };
  };
}

const healthy = {
  '--version': { code: 0, stdout: VERSION_OUT },
  'auth status': { code: 0, stdout: AUTHED_OUT },
};

describe('readGhStatus — not installed', () => {
  it('reports it, with the probes explaining where it looked', () => {
    const status = readGhStatus({ PATH: dir }, runner({}));

    expect(status.installed).toBe(false);
    expect(status.resolved).toBeNull();
    expect(status.authenticated).toBe(false);
    expect(status.tokenSource).toBe('none');
    expect(status.probes).toEqual([{ directory: dir, found: false }]);
    expect(status.error).toBeNull();
  });

  it('never runs anything when there is nothing to run', () => {
    const seen: { file: string; args: readonly string[] }[] = [];
    readGhStatus({ PATH: dir }, runner({}, seen));

    expect(seen).toEqual([]);
  });

  it('still reports an environment token, because that is where one would come from', () => {
    const status = readGhStatus({ PATH: dir, GH_TOKEN: 'x' }, runner({}));

    expect(status.installed).toBe(false);
    expect(status.tokenSource).toBe('env');
    expect(status.envVar).toBe('GH_TOKEN');
  });
});

describe('readGhStatus — installed', () => {
  it('reports the version, the account and the keyring as the source', () => {
    const status = readGhStatus({ PATH: withGh() }, runner(healthy));

    expect(status.installed).toBe(true);
    expect(status.resolved).toBe(join(dir, 'gh'));
    expect(status.version).toBe('2.62.0');
    expect(status.authenticated).toBe(true);
    expect(status.account).toBe('octocat');
    expect(status.tokenSource).toBe('keyring');
    expect(status.envVar).toBeNull();
    expect(status.error).toBeNull();
  });

  it('runs the resolved absolute path, never the bare name', () => {
    const seen: { file: string; args: readonly string[] }[] = [];
    readGhStatus({ PATH: withGh() }, runner(healthy, seen));

    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) expect(call.file).toBe(join(dir, 'gh'));
  });

  it('passes a constant argv — nothing is interpolated into it', () => {
    const seen: { file: string; args: readonly string[] }[] = [];
    readGhStatus({ PATH: withGh() }, runner(healthy, seen));

    expect(seen.map((call) => call.args.join(' ')).sort()).toEqual([
      '--version',
      'auth status',
    ]);
  });

  it('treats not-logged-in as an ordinary answer, not an error', () => {
    const status = readGhStatus(
      { PATH: withGh() },
      runner({
        '--version': { code: 0, stdout: VERSION_OUT },
        'auth status': { code: 1, stderr: NOT_AUTHED_ERR },
      }),
    );

    expect(status.installed).toBe(true);
    expect(status.authenticated).toBe(false);
    expect(status.account).toBeNull();
    expect(status.tokenSource).toBe('none');
    expect(status.error).toBeNull();
  });

  it('reports a version it could not read as null rather than guessing', () => {
    const status = readGhStatus(
      { PATH: withGh() },
      runner({
        '--version': { code: 0, stdout: 'something else entirely\n' },
        'auth status': { code: 0, stdout: AUTHED_OUT },
      }),
    );

    expect(status.version).toBeNull();
    expect(status.authenticated).toBe(true);
  });

  it('records a runner that threw as an error, without crashing the pane', () => {
    const status = readGhStatus({ PATH: withGh() }, () => {
      throw new Error('spawn ETIMEDOUT');
    });

    expect(status.installed).toBe(true);
    expect(status.authenticated).toBe(false);
    expect(status.error).toMatch(/ETIMEDOUT/);
  });
});

describe('readGhStatus — the token source', () => {
  it('prefers GH_TOKEN over GITHUB_TOKEN, matching gh itself', () => {
    const status = readGhStatus(
      { PATH: withGh(), GH_TOKEN: 'a', GITHUB_TOKEN: 'b' },
      runner(healthy),
    );

    expect(status.tokenSource).toBe('env');
    expect(status.envVar).toBe('GH_TOKEN');
  });

  it('uses GITHUB_TOKEN when it is the only one set', () => {
    const status = readGhStatus(
      { PATH: withGh(), GITHUB_TOKEN: 'b' },
      runner(healthy),
    );

    expect(status.envVar).toBe('GITHUB_TOKEN');
  });

  it('reports the environment even when a keyring account also exists', () => {
    // Which one `gh` would actually use is the useful answer, and it is the
    // environment.
    const status = readGhStatus({ PATH: withGh(), GH_TOKEN: 'a' }, runner(healthy));

    expect(status.tokenSource).toBe('env');
    expect(status.authenticated).toBe(true);
  });

  it('ignores an empty variable — an unset one that was exported anyway', () => {
    const status = readGhStatus(
      { PATH: withGh(), GH_TOKEN: '', GITHUB_TOKEN: '   ' },
      runner(healthy),
    );

    expect(status.tokenSource).toBe('keyring');
    expect(status.envVar).toBeNull();
  });

  it('never lets a token value into the result', () => {
    // The guarantee the whole design rests on: `gh` redacts by default, but the
    // result is built from named fields rather than from output, so even output
    // that carried a token could not leak through.
    const status = readGhStatus(
      { PATH: withGh(), GH_TOKEN: 'ghp_realsecret' },
      runner({
        '--version': { code: 0, stdout: VERSION_OUT },
        'auth status': {
          code: 0,
          stdout: `${AUTHED_OUT}  - Token: ghp_realsecret\n`,
        },
      }),
    );

    expect(JSON.stringify(status)).not.toContain('ghp_realsecret');
  });
});
