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
 * `diagnoseEnv` is proven against real, disposable "shells" (scripts this
 * test writes and makes executable, and — for the interactive-flag
 * regression test below — a real `/bin/zsh` with a disposable rc file), the
 * same way `gh.test.ts` proves `readGhStatus`'s filesystem search against
 * real files rather than mocking `node:fs` or `node:child_process`: what is
 * worth testing here is how a real spawn's result gets turned into a
 * diagnostic, and a mocked `execFile` would only assert the mock.
 *
 * `diagnoseEnv` is now asynchronous — review caught that the original
 * `spawnSync` version could freeze the whole main process against a shell
 * that traps `SIGTERM` (measured: 20+ seconds against a 2-second timeout).
 * The "does not block, and is bounded by `SIGKILL`" tests below are the
 * regression guard for that specific defect.
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
 * `diagnoseEnv` always invokes with `ENV_PROBE_ARGS` (`-l -i -c printenv`),
 * but a real `/bin/sh` script run directly (not via `sh -c`) receives those
 * as `$1 $2 $3 $4` and never looks at them — which is exactly what lets this
 * fixture stand in for "a login shell whose rc file did something" without
 * depending on any real shell's rc-sourcing behaviour, which is unpredictable
 * across machines and CI images. (The one exception is the interactive-flag
 * regression test below, which deliberately *does* depend on real rc-sourcing
 * behaviour, because that is the thing under test there.)
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
  it('reports a variable the shell kept, end to end', async () => {
    const shell = fakeShell('printenv');

    const result = await diagnoseEnv(runtime({ shell, env: { A: '1' } }), null, baseEnv);

    expect(result.error).toBeNull();
    expect(result.shell).toBe(shell);
    expect(result.projectId).toBeNull();
    expect(result.vars).toEqual([
      { key: 'A', configured: '1', actual: '1', overridden: false },
    ]);
  });

  it('reports a variable a simulated rc file overrides, scoped to a project', async () => {
    const shell = fakeShell('export AWS_PROFILE=incorp\nprintenv');

    const result = await diagnoseEnv(
      runtime({ shell, env: { AWS_PROFILE: 'hive' } }),
      'apfm-web',
      baseEnv,
    );

    expect(result.projectId).toBe('apfm-web');
    expect(result.vars[0]).toMatchObject({ actual: 'incorp', overridden: true });
  });

  it('reports a probe that could not even start as a failed observation, not a bad setting', async () => {
    const missing = join(dir, 'does-not-exist');

    const result = await diagnoseEnv(runtime({ shell: missing, env: { A: '1' } }), null, baseEnv);

    // `vars` is empty rather than a verdict list containing a guess — a
    // diagnostic that never ran has nothing to report about the setting.
    expect(result.error).not.toBeNull();
    expect(result.vars).toEqual([]);
  });

  it('reports a shell that did not exit cleanly as a failed observation', async () => {
    const shell = fakeShell('exit 3');

    const result = await diagnoseEnv(runtime({ shell, env: { A: '1' } }), null, baseEnv);

    expect(result.error).toMatch(/status 3/);
    expect(result.vars).toEqual([]);
  });
});

describe('diagnoseEnv — does not block on, and is bounded against, a hostile shell', () => {
  /**
   * The regression guard for the defect review caught in the synchronous
   * version: `spawnSync`'s `timeout` only *sends* `killSignal`, and the
   * default (`SIGTERM`) can be trapped and ignored — measured against the
   * real system shell at 20+ seconds for a 2-second timeout. Two things have
   * to be true at once for the fix to actually hold: the event loop must
   * keep running while the child is alive (this is what makes it
   * asynchronous rather than merely "eventually returns"), and the probe
   * must still resolve close to its timeout rather than the full duration of
   * whatever the trapping script does (this is what `killSignal: 'SIGKILL'`
   * — a signal that cannot be trapped — buys).
   */
  it('keeps the event loop free while the probe runs, and is bounded by SIGKILL rather than the shell’s own sleep', async () => {
    // Traps SIGTERM and then sleeps far longer than the timeout below —
    // `diagnoseEnv`'s default `killSignal: 'SIGKILL'` is what has to end
    // this, not the shell choosing to cooperate.
    const shell = fakeShell("trap '' TERM\nsleep 5");

    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks += 1;
    }, 20);

    const start = Date.now();
    const result = await diagnoseEnv(
      runtime({ shell, env: { A: '1' } }),
      null,
      baseEnv,
      // A short timeout so this test does not itself take 5+ seconds to
      // prove the point — see `diagnoseEnv`'s `timeoutMs` doc comment.
      300,
    );
    const elapsed = Date.now() - start;
    clearInterval(heartbeat);

    // The event loop kept running: a 20ms timer fired repeatedly while the
    // 5-second-sleeping, SIGTERM-trapping child was still alive underneath
    // the awaited call. A synchronous probe would have produced `ticks === 0`
    // here, because nothing else can run during a blocking `spawnSync`.
    expect(ticks).toBeGreaterThan(0);

    // Bounded well under the shell's 5-second sleep — SIGKILL, not the
    // shell's own cooperation, is what ended this.
    expect(elapsed).toBeLessThan(2_000);

    expect(result.vars).toEqual([]);
  });

  /**
   * The `killed`-checked-first ordering, tested end to end rather than by
   * reaching into the module's private `describeProbeFailure`. This is the
   * async equivalent of the `spawnSync` version's `result.error`-before-
   * `result.status` hazard review flagged as load-bearing: a probe that
   * timed out and was killed must never be described as if it had exited
   * with some ordinary status, because that reads as a normal (if odd) run
   * rather than as the failed observation it actually was.
   */
  it('describes a killed probe as killed, not as an ordinary exit', async () => {
    const shell = fakeShell("trap '' TERM\nsleep 5");

    const result = await diagnoseEnv(
      runtime({ shell, env: { A: '1' } }),
      null,
      baseEnv,
      300,
    );

    expect(result.error).toMatch(/killed/);
    expect(result.error).not.toMatch(/exited with status/);
    expect(result.vars).toEqual([]);
  });
});

describe('diagnoseEnv — the interactive flag is load-bearing', () => {
  /**
   * The regression guard for the second defect review caught: the probe was
   * specced as `-l -c`, which is *non-interactive*, and zsh sources
   * `.zshrc` only for interactive shells. A real session's `<shell> -l` on a
   * PTY is interactive, so a non-interactive probe would report a variable
   * as "kept" in exactly the case a real session would have gotten the rc
   * file's value — the canonical case this whole diagnostic exists for.
   *
   * This test deliberately runs a real `/bin/zsh` rather than a fake shell
   * script: the thing under test is real rc-sourcing behaviour, which a
   * fixture that ignores its argv cannot exercise. `ZDOTDIR` (not `HOME`)
   * isolates zsh's dotfile lookup to a disposable directory, so this does
   * not depend on — or risk touching — the machine's real `.zshrc`.
   */
  it('sees a variable set only in .zshrc, proving the probe actually ran interactively', async () => {
    writeFileSync(join(dir, '.zshrc'), 'export FOO=from_zshrc\n');
    // An empty `.zprofile` keeps the login half deterministic without
    // depending on whatever the real machine's profile happens to set.
    writeFileSync(join(dir, '.zprofile'), '');

    const result = await diagnoseEnv(
      runtime({ shell: '/bin/zsh', env: { FOO: 'configured-value' } }),
      null,
      { ...baseEnv, ZDOTDIR: dir },
    );

    expect(result.error).toBeNull();
    // A regression to non-interactive would report `actual: null` (zsh never
    // sources .zshrc, so FOO is simply absent) rather than this.
    expect(result.vars[0]).toMatchObject({
      key: 'FOO',
      actual: 'from_zshrc',
      overridden: true,
    });
  });
});
