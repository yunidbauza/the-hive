// @vitest-environment node
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
 *
 * Two more describe blocks below ("matches the real session's environment")
 * are the regression guard for a second-round finding: the probe used to
 * build its own environment by hand (`{ ...baseEnv, ...runtime.env }`) and
 * never touch `cwd` at all, so it observed `TERM` and the working directory
 * main happened to have rather than what a real session actually gets. Both
 * can make an rc file take a different branch than it would for a real
 * session, producing a false "kept" verdict.
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

/**
 * `diagnoseEnv` now requires a `cwd` (story 108's second fix round) — no
 * test below cares what it is except the two "matches the real session's
 * environment" blocks, so this is just a valid, disposable directory to pass
 * everywhere else.
 */
const cwd = () => dir;

describe('diagnoseEnv', () => {
  it('reports a variable the shell kept, end to end', async () => {
    const shell = fakeShell('printenv');

    const result = await diagnoseEnv(runtime({ shell, env: { A: '1' } }), null, cwd(), baseEnv);

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
      cwd(),
      baseEnv,
    );

    expect(result.projectId).toBe('apfm-web');
    expect(result.vars[0]).toMatchObject({ actual: 'incorp', overridden: true });
  });

  it('reports a probe that could not even start as a failed observation, not a bad setting', async () => {
    const missing = join(dir, 'does-not-exist');

    const result = await diagnoseEnv(
      runtime({ shell: missing, env: { A: '1' } }),
      null,
      cwd(),
      baseEnv,
    );

    // `vars` is empty rather than a verdict list containing a guess — a
    // diagnostic that never ran has nothing to report about the setting.
    expect(result.error).not.toBeNull();
    expect(result.vars).toEqual([]);
  });

  it('reports a shell that did not exit cleanly as a failed observation', async () => {
    const shell = fakeShell('exit 3');

    const result = await diagnoseEnv(runtime({ shell, env: { A: '1' } }), null, cwd(), baseEnv);

    expect(result.error).toMatch(/status 3/);
    expect(result.vars).toEqual([]);
  });
});

describe('diagnoseEnv — matches what a real session gets (story 108, fix round 2)', () => {
  /**
   * Finding 1's regression guard. Before this fix, the probe's environment
   * was `{ ...baseEnv, ...runtime.env }` — nothing forced `TERM`, so a
   * `baseEnv` with no `TERM` at all (exactly what a packaged app launched
   * from Finder has — `TERM` is unset in launchd's environment) produced a
   * probe with no `TERM` either, while every real session gets
   * `TERM=xterm-256color` forced on it by `buildSessionEnv`. An rc file that
   * branches on `TERM` (`[[ $TERM == dumb ]] && return`, which oh-my-zsh and
   * powerlevel10k both do) would take a different path under the probe than
   * under a real session.
   *
   * Proven the same way the rest of this file proves things: configure a
   * value for `TERM` (bypassing the UI-layer guard that normally refuses
   * it, since `diagnoseEnv` itself takes whatever `runtime.env` it is
   * given) and prove the shell reports back the *forced* value rather than
   * either the configured one or nothing — and prove it even when the base
   * environment the probe inherits has no `TERM` at all.
   */
  it('forces TERM to xterm-256color even when the base environment has none', async () => {
    const shell = fakeShell('printenv');
    const baseEnvWithoutTerm: NodeJS.ProcessEnv = { PATH: baseEnv.PATH };
    expect(baseEnvWithoutTerm.TERM).toBeUndefined();

    const result = await diagnoseEnv(
      runtime({ shell, env: { TERM: 'whatever-was-configured' } }),
      null,
      cwd(),
      baseEnvWithoutTerm,
    );

    expect(result.error).toBeNull();
    expect(result.vars).toEqual([
      {
        key: 'TERM',
        configured: 'whatever-was-configured',
        actual: 'xterm-256color',
        overridden: true,
      },
    ]);
  });

  /**
   * Finding 2's regression guard. Before this fix, `diagnoseEnv` never
   * received a `cwd` at all and the probe inherited main's own working
   * directory (`/` in a typical packaged build) — never `project.path`, the
   * directory a real session for that project actually runs in
   * (`sessions/index.ts`). Anything an rc file keys on the directory —
   * direnv's `.envrc`, `asdf`/`nodenv`/`pyenv` version files — would diverge.
   *
   * Proven with a marker file that only exists in the directory passed as
   * `cwd`, and an `export` that runs *inside* the probed shell — mirroring
   * how the "simulated rc file overrides" test above proves an override,
   * rather than echoing a value that `printenv`'s own dump could stomp on:
   * the fixture asks the OS for its actual working directory (`pwd`, not the
   * `$PWD` environment variable — that would only prove the env var was set,
   * not that the process actually started there) and re-exports `MARKER`
   * based on whether the marker is visible from it. If `cwd` never reached
   * the child, the probe would run wherever this test process happens to be
   * (this repo's `app/` directory), which does not contain the marker, and
   * `MARKER` would keep the injected value instead of being overridden.
   */
  it('runs the probe in the resolved project directory, not wherever the caller happens to be', async () => {
    const shell = fakeShell(
      'export MARKER=$([ -f "$(pwd)/marker" ] && echo yes || echo no)\nprintenv',
    );
    const projectDir = mkdtempSync(join(tmpdir(), 'hive-env-diagnostic-cwd-'));
    writeFileSync(join(projectDir, 'marker'), '');

    try {
      const result = await diagnoseEnv(
        runtime({ shell, env: { MARKER: 'no' } }),
        'apfm-web',
        projectDir,
        baseEnv,
      );

      expect(result.error).toBeNull();
      expect(result.vars).toEqual([
        { key: 'MARKER', configured: 'no', actual: 'yes', overridden: true },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('forces PWD to match the cwd it was given', async () => {
    const shell = fakeShell('printenv');
    const projectDir = mkdtempSync(join(tmpdir(), 'hive-env-diagnostic-pwd-'));

    try {
      const result = await diagnoseEnv(
        runtime({ shell, env: { PWD: 'whatever-was-configured' } }),
        null,
        projectDir,
        baseEnv,
      );

      expect(result.error).toBeNull();
      expect(result.vars).toEqual([
        {
          key: 'PWD',
          configured: 'whatever-was-configured',
          actual: projectDir,
          overridden: true,
        },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  /**
   * The third thing that has to match, and the one the merge of this story
   * onto `main` nearly lost: a real session is spawned with
   * `stripEnv: AUTH_ENV_KEYS` whenever `subscriptionAuth` is on
   * (`sessions/index.ts`), so the probe must be too.
   *
   * A probe that skipped it would report an environment where
   * `ANTHROPIC_API_KEY` is present and every real session's is not — the same
   * false verdict as the `TERM` and `cwd` findings above, and for the same
   * reason: an rc file that branches on it takes a branch no real session
   * takes. Proven with the marker pattern the `cwd` test uses, because
   * `compareEnv` only reports keys that were *configured* and a stripped key
   * is by definition not one of them.
   */
  it('strips the names a real session would have stripped', async () => {
    const shell = fakeShell(
      'export MARKER=$([ -n "$ANTHROPIC_API_KEY" ] && echo leaked || echo stripped)\nprintenv',
    );

    const result = await diagnoseEnv(
      runtime({ shell, env: { MARKER: 'leaked' } }),
      null,
      cwd(),
      { ...baseEnv, ANTHROPIC_API_KEY: 'sk-should-not-reach-the-probe' },
      ['ANTHROPIC_API_KEY'],
    );

    expect(result.error).toBeNull();
    expect(result.vars).toEqual([
      { key: 'MARKER', configured: 'leaked', actual: 'stripped', overridden: true },
    ]);
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
      cwd(),
      baseEnv,
      [],
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
      cwd(),
      baseEnv,
      [],
      300,
    );

    expect(result.error).toMatch(/killed/);
    expect(result.error).not.toMatch(/exited with status/);
    expect(result.vars).toEqual([]);
  });
});

describe('diagnoseEnv — stdin is closed, not left open', () => {
  /**
   * The regression guard for the second round-2 finding: `execFile` does not
   * forward a `stdio` option to the underlying `spawn` (measured — passing
   * one has no effect), so stdin is an open pipe that never EOFs unless this
   * module closes it itself. Without the `child.stdin.end()` fix, a `read`
   * in an rc file blocks until the probe's own timeout kills it — the same
   * multi-second "did not finish … and was killed" a hung shell produces,
   * except triggered by something as ordinary as an interactive-mode prompt.
   * This is more reachable than it sounds because `-i` (the fix for the
   * *other* round-1 finding) is exactly what makes an rc file take its
   * interactive branch, where prompts and `read` live.
   *
   * Proven by timing: without the fix this fixture would run out the full
   * timeout and report a `killed` error (verified by hand while writing this
   * fix — see the fix report); with it, it resolves in well under a second.
   */
  it('resolves promptly rather than timing out when the shell reads stdin', async () => {
    const shell = fakeShell('read x\nprintenv');

    const start = Date.now();
    const result = await diagnoseEnv(
      runtime({ shell, env: { A: '1' } }),
      null,
      cwd(),
      baseEnv,
      [],
      // Generous relative to how fast this should actually resolve (well
      // under a second), but still far short of a real timeout — if the fix
      // regresses, this test fails on the assertion below rather than
      // hanging the suite for the full production TIMEOUT_MS.
      2_000,
    );
    const elapsed = Date.now() - start;

    expect(result.error).toBeNull();
    expect(result.vars).toEqual([{ key: 'A', configured: '1', actual: '1', overridden: false }]);
    // The actual regression guard: a shell blocked on `read` with an open
    // stdin would consume the whole timeout above and report `killed`,
    // rather than resolving fast with a clean verdict.
    expect(elapsed).toBeLessThan(1_500);
  });
});

/**
 * Whether `/bin/zsh` exists on this machine.
 *
 * The interactive-sourcing test below needs a *real* zsh — the thing under
 * test is real rc-sourcing behaviour, which a portable `#!/bin/sh` fixture
 * cannot exercise. Every other test in this file uses one specifically to
 * avoid this kind of environmental dependency; this is the one deliberate
 * exception, and it earns the guard the rest of the file doesn't need. There
 * is no CI config in this repo today, so this is a latent risk rather than a
 * live one — but a test whose entire value is being trusted when it goes red
 * must not be able to go red for an environmental reason instead of a real
 * regression, on a Linux CI runner or minimal container that has no zsh.
 */
const hasZsh = existsSync('/bin/zsh');

describe.skipIf(!hasZsh)(
  'diagnoseEnv — the interactive flag is load-bearing (skipped: no /bin/zsh on this machine)',
  () => {
    /**
     * The regression guard for the second defect review caught: the probe
     * was specced as `-l -c`, which is *non-interactive*, and zsh sources
     * `.zshrc` only for interactive shells. A real session's `<shell> -l` on
     * a PTY is interactive, so a non-interactive probe would report a
     * variable as "kept" in exactly the case a real session would have
     * gotten the rc file's value — the canonical case this whole diagnostic
     * exists for.
     *
     * This test deliberately runs a real `/bin/zsh` rather than a fake
     * shell script: the thing under test is real rc-sourcing behaviour,
     * which a fixture that ignores its argv cannot exercise. `ZDOTDIR` (not
     * `HOME`) isolates zsh's dotfile lookup to a disposable directory, so
     * this does not depend on — or risk touching — the machine's real
     * `.zshrc`.
     */
    it('sees a variable set only in .zshrc, proving the probe actually ran interactively', async () => {
      writeFileSync(join(dir, '.zshrc'), 'export FOO=from_zshrc\n');
      // An empty `.zprofile` keeps the login half deterministic without
      // depending on whatever the real machine's profile happens to set.
      writeFileSync(join(dir, '.zprofile'), '');

      const result = await diagnoseEnv(
        runtime({ shell: '/bin/zsh', env: { FOO: 'configured-value' } }),
        null,
        cwd(),
        { ...baseEnv, ZDOTDIR: dir },
      );

      expect(result.error).toBeNull();
      // A regression to non-interactive would report `actual: null` (zsh
      // never sources .zshrc, so FOO is simply absent) rather than this.
      expect(result.vars[0]).toMatchObject({
        key: 'FOO',
        actual: 'from_zshrc',
        overridden: true,
      });
    });
  },
);
