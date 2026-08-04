// @vitest-environment node
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EffectiveRuntime } from '../../../../electron/shared/config-contract';
import {
  compareEnv,
  diagnoseEnv,
} from '../../../../electron/main/config/env-diagnostic';

/**
 * The environment diagnostic (story 108).
 *
 * `compareEnv` is pure and gets the bulk of the coverage — it is the part
 * that decides what "overridden" means, and it needs no process to test.
 * `diagnoseEnv` is proven against a real, disposable "shell" (a script this
 * test writes and makes executable), the same way `gh.test.ts` proves
 * `readGhStatus`'s filesystem search against real files rather than mocking
 * `node:fs`: what is worth testing here is how a real spawn's result gets
 * turned into a diagnostic, and a mocked `spawnSync` would only assert the
 * mock.
 */

describe('compareEnv', () => {
  it('marks a variable the shell kept as applied', () => {
    const vars = compareEnv({ A: '1' }, 'A=1\nB=2\n');
    expect(vars).toEqual([{ key: 'A', configured: '1', actual: '1', overridden: false }]);
  });

  it('marks a variable the rc file changed as overridden', () => {
    const vars = compareEnv({ AWS_PROFILE: 'hive' }, 'AWS_PROFILE=incorp\n');
    expect(vars[0]).toMatchObject({ actual: 'incorp', overridden: true });
  });

  it('marks a variable the shell dropped entirely', () => {
    expect(compareEnv({ A: '1' }, 'B=2\n')[0]).toMatchObject({
      actual: null,
      overridden: true,
    });
  });

  it('keeps a value containing "=" intact', () => {
    expect(compareEnv({ A: 'x=y' }, 'A=x=y\n')[0]).toMatchObject({
      actual: 'x=y',
      overridden: false,
    });
  });

  it('reports only configured variables, not the shell’s whole environment', () => {
    expect(compareEnv({ A: '1' }, 'A=1\nPATH=/usr/bin\nHOME=/root\n')).toHaveLength(1);
  });
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-env-diagnostic-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Write an executable "shell" whose body ignores its argv entirely.
 *
 * `diagnoseEnv` always invokes with `['-l', '-c', 'printenv']`, but a real
 * `/bin/sh` script run directly (not via `sh -c`) receives those as `$1 $2
 * $3` and never looks at them — which is exactly what lets this fixture stand
 * in for "a login shell whose rc file did something" without depending on any
 * real shell's rc-sourcing behaviour, which is unpredictable across machines
 * and CI images.
 */
function fakeShell(body: string): string {
  const file = join(dir, 'shell.sh');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const runtime = (over: Partial<EffectiveRuntime> = {}): EffectiveRuntime => ({
  shell: '/bin/sh',
  claudeCommand: 'claude',
  env: {},
  shellFromProject: false,
  commandFromProject: false,
  ...over,
});

/**
 * A `PATH` real enough to resolve `printenv`, so the fake shells below can
 * actually run it. Injected as `baseEnv` rather than left to `process.env`
 * so the test does not depend on whatever environment happens to be running
 * it.
 */
const baseEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };

describe('diagnoseEnv', () => {
  it('reports a variable the shell kept, end to end', () => {
    const shell = fakeShell('printenv');

    const result = diagnoseEnv(runtime({ shell, env: { A: '1' } }), null, baseEnv);

    expect(result.error).toBeNull();
    expect(result.shell).toBe(shell);
    expect(result.projectId).toBeNull();
    expect(result.vars).toEqual([
      { key: 'A', configured: '1', actual: '1', overridden: false },
    ]);
  });

  it('reports a variable a simulated rc file overrides, scoped to a project', () => {
    const shell = fakeShell('export AWS_PROFILE=incorp\nprintenv');

    const result = diagnoseEnv(
      runtime({ shell, env: { AWS_PROFILE: 'hive' } }),
      'apfm-web',
      baseEnv,
    );

    expect(result.projectId).toBe('apfm-web');
    expect(result.vars[0]).toMatchObject({ actual: 'incorp', overridden: true });
  });

  it('reports a probe that could not even start as a failed observation, not a bad setting', () => {
    const missing = join(dir, 'does-not-exist');

    const result = diagnoseEnv(runtime({ shell: missing, env: { A: '1' } }), null, baseEnv);

    // `vars` is empty rather than a verdict list containing a guess — a
    // diagnostic that never ran has nothing to report about the setting.
    expect(result.error).not.toBeNull();
    expect(result.vars).toEqual([]);
  });

  it('reports a shell that did not exit cleanly as a failed observation', () => {
    const shell = fakeShell('exit 3');

    const result = diagnoseEnv(runtime({ shell, env: { A: '1' } }), null, baseEnv);

    expect(result.error).toMatch(/status 3/);
    expect(result.vars).toEqual([]);
  });
});
