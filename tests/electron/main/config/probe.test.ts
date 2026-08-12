// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { probeCommand } from '../../../../electron/main/config/probe';

/**
 * Real files throughout, matching `runtime.test.ts`.
 *
 * This is the search `diagnoseCommand` has always done, extracted (story 106)
 * so `gh` detection can use the same one. Mocking `fs` here would assert the
 * mock rather than the behaviour, and the case worth catching is precisely the
 * candidate that exists but is not executable.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-probe-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function executable(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, name);
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, 0o755);
  return file;
}

function plainFile(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, name);
  writeFileSync(file, 'not executable\n');
  chmodSync(file, 0o644);
  return file;
}

describe('probeCommand', () => {
  it('resolves a command found on PATH', () => {
    const file = executable(dir, 'gh');

    const result = probeCommand('gh', dir);

    expect(result.isPath).toBe(false);
    expect(result.resolved).toBe(file);
    expect(result.probes).toEqual([{ directory: dir, found: true }]);
  });

  it('reports the first match when several directories carry the command', () => {
    const first = join(dir, 'a');
    const second = join(dir, 'b');
    const wanted = executable(first, 'gh');
    executable(second, 'gh');

    const result = probeCommand('gh', [first, second].join(delimiter));

    expect(result.resolved).toBe(wanted);
    expect(result.probes).toHaveLength(2);
  });

  it('flags a present but non-executable file rather than calling it missing', () => {
    plainFile(dir, 'gh');

    const result = probeCommand('gh', dir);

    expect(result.resolved).toBeNull();
    expect(result.probes).toEqual([
      { directory: dir, found: false, notExecutable: true },
    ]);
  });

  it('reports a directory that simply has nothing', () => {
    const result = probeCommand('gh', dir);

    expect(result.resolved).toBeNull();
    expect(result.probes).toEqual([{ directory: dir, found: false }]);
  });

  it('skips empty PATH entries rather than probing a cwd it does not share', () => {
    const file = executable(dir, 'gh');

    const result = probeCommand('gh', `${delimiter}${dir}`);

    expect(result.probes).toEqual([{ directory: dir, found: true }]);
    expect(result.resolved).toBe(file);
  });

  it('treats a command containing a separator as a path, not a search', () => {
    const file = executable(dir, 'gh');

    const result = probeCommand(file, dir);

    expect(result.isPath).toBe(true);
    expect(result.resolved).toBe(file);
    expect(result.probes).toEqual([]);
  });

  it('reports an absolute but non-executable path as unresolved', () => {
    const file = plainFile(dir, 'gh');

    const result = probeCommand(file, dir);

    expect(result.isPath).toBe(true);
    expect(result.resolved).toBeNull();
  });

  it('reports a relative path as unresolved rather than guessing at a cwd', () => {
    const result = probeCommand('./bin/gh', dir);

    expect(result.isPath).toBe(true);
    expect(result.resolved).toBeNull();
    expect(result.probes).toEqual([]);
  });

  it('returns nothing to report for an empty PATH', () => {
    const result = probeCommand('gh', '');

    expect(result.probes).toEqual([]);
    expect(result.resolved).toBeNull();
  });
});
