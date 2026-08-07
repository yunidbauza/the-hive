import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * Session lifecycle and the `claude` bootstrap (story 096).
 *
 * The unit suite proves every rule against a stubbed supervisor with fake
 * timers. What it cannot prove is that a *real* login shell, spawned by a real
 * pty in a real directory, runs the bootstrap and then survives it — or that
 * quitting the app leaves nothing behind. Those need the built app.
 *
 * `claudeCommand` is pointed at a **stub script** rather than the real `claude`.
 * A spec that started a real agent in a real repository would consume tokens,
 * could write to the working tree, and would depend on a binary that is not
 * installed in CI. The stub proves the mechanism — that the configured command
 * is what runs, in the right place, and that the shell outlives it — which is
 * the whole of what this story owns.
 */

const REAL_DIRECTORY = join(import.meta.dirname, '../../..');
const SESSION = 'hero-refresh';
const PROJECT = 'apfm-web';

/**
 * A stand-in for `claude`: records that it ran, with its cwd, then exits.
 *
 * **The exit code is load-bearing now.** The bootstrap is `claude && exit`
 * (`sessionCommand`), so a stub that ends cleanly takes the login shell with it
 * and there is no shell left for a spec to type into. Every spec below that
 * needs a live shell therefore uses a stub that ends **badly** — which is not a
 * fudge but the real state it is modelling: an agent that crashed, leaving the
 * session open so the user can see why.
 *
 * `writeCleanStub` is the other half, and the two together are the contract.
 */
function writeStubCommand(path: string, marker: string, exitCode = 1): void {
  writeFileSync(
    path,
    `#!/bin/sh\nprintf 'stub-claude-started\\n'\npwd > '${marker}'\nexit ${exitCode}\n`,
    { encoding: 'utf8' },
  );
  chmodSync(path, 0o755);
}

/**
 * The same stub, ending cleanly — what `/exit` does — and recording the pid of
 * the login shell that ran it.
 *
 * `$PPID` inside the stub *is* that shell, which is the process the `&& exit`
 * is supposed to take with it. Capturing it from in there is the only way to
 * name it: by the time the assertion runs there is deliberately nothing left to
 * ask.
 */
function writeCleanStub(path: string, marker: string, shellPid: string): void {
  writeFileSync(
    path,
    `#!/bin/sh\nprintf 'stub-claude-started\\n'\npwd > '${marker}'\necho $PPID > '${shellPid}'\nexit 0\n`,
    { encoding: 'utf8' },
  );
  chmodSync(path, 0o755);
}

/**
 * A stub that records the arguments it was handed (story 109).
 *
 * `"$*"` rather than a marker file's contents, because what is being proved is
 * the *shell's* view of the command line — that `--model haiku` arrived as two
 * arguments to `claude` and not as part of its name, and that nothing was
 * swallowed by `&&`. A unit test can prove the string was assembled; only a
 * real shell can prove it was assembled into the right words.
 *
 * Exits non-zero so the login shell survives, leaving the app in a state the
 * test can keep inspecting.
 */
function writeArgsStub(path: string, argsFile: string): void {
  writeFileSync(path, `#!/bin/sh\nprintf '%s' "$*" > '${argsFile}'\nexit 1\n`, {
    encoding: 'utf8',
  });
  chmodSync(path, 0o755);
}

function writeConfig(
  path: string,
  options: { claudeCommand: string; projects?: { id: string; path: string }[] },
): void {
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      shell: '/bin/sh',
      claudeCommand: options.claudeCommand,
      projects: options.projects ?? [{ id: PROJECT, path: REAL_DIRECTORY }],
    }),
  );
}

const read = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, 'utf8').trim() : null;

async function expectFile(path: string, contents: string): Promise<void> {
  await expect.poll(() => read(path), { timeout: 20_000 }).toBe(contents);
}

/**
 * The session-identity flags HIVE-61 appends to every spawn.
 *
 * `--session-id` is a fresh uuid and `--settings` is a per-test temp path, so
 * neither can be matched literally. Stripping them keeps what the two argv
 * tests are really asserting — that nothing *else* reached the argument list,
 * `&& exit` included — without freezing a value that changes per run.
 *
 * These two tests have been failing since HIVE-61 landed, which updated the
 * unit tests for the new flags and not this file.
 */
const IDENTITY_FLAGS = /\s*--(?:name|session-id|settings)\s+\S+/g;

/** Assert the argv the stub recorded, ignoring the identity flags. */
async function expectArgs(path: string, contents: string): Promise<void> {
  await expect
    .poll(() => read(path)?.replace(IDENTITY_FLAGS, '').trim() ?? null, {
      timeout: 20_000,
    })
    .toBe(contents);
}

async function openSession(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');
  await page.getByRole('button', { name: new RegExp(SESSION) }).first().click();
  await expect(page.locator(`[data-terminal-id="${SESSION}"]`)).toBeVisible();
}

test('a session runs the configured command in the project directory', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  const stub = testInfo.outputPath('claude-stub.sh');
  const ranIn = testInfo.outputPath('ran-in.txt');
  writeStubCommand(stub, ranIn);
  writeConfig(configPath, { claudeCommand: stub });

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await openSession(page);

    /**
     * The bootstrap ran, and it ran **where the project is**. `pwd` from inside
     * the command proves the whole chain at once: config resolution, the login
     * shell's cwd, and the bootstrap actually being submitted rather than left
     * typed at a prompt.
     */
    await expectFile(ranIn, REAL_DIRECTORY);
  } finally {
    await app.close();
  }
});

test('a clean exit from the agent ends the whole session', async ({}, testInfo) => {
  /**
   * `/exit` retires the row.
   *
   * Story 096 originally chose the opposite — a login shell underneath so the
   * user was left somewhere useful — and `sessionCommand` records why that was
   * reversed: a fleet view whose rail fills with idle shells stops being a
   * fleet view. The mechanism is `&&`, and this is the half of it that closes.
   */
  const configPath = testInfo.outputPath('hive-config.json');
  const stub = testInfo.outputPath('claude-stub.sh');
  const ranIn = testInfo.outputPath('ran-in.txt');
  const shellPid = testInfo.outputPath('shell-pid.txt');
  const after = testInfo.outputPath('after.txt');
  writeCleanStub(stub, ranIn, shellPid);
  writeConfig(configPath, { claudeCommand: stub });

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await openSession(page);
    await expectFile(ranIn, REAL_DIRECTORY);
    await expect.poll(() => read(shellPid), { timeout: 20_000 }).not.toBeNull();

    /**
     * Asserted on the *process*, not on a rendered badge. A session showing
     * `terminated` with a live shell still behind it would pass a UI assertion and
     * still leak — which is the whole failure mode story 096's teardown exists
     * to prevent, and this change adds a new way to reach it.
     */
    await expect
      .poll(() => isAlive(Number(read(shellPid))), { timeout: 20_000 })
      .toBe(false);

    // And nothing was respawned in its place: a write into a session with no
    // shell reaches nothing, so the marker never appears.
    await page.evaluate(
      ([sessionId, path]) => {
        window.hive!.pty.write({
          sessionId: sessionId!,
          data: `echo still-here > '${path}'\n`,
        });
      },
      [SESSION, after],
    );
    await page.waitForTimeout(1_000);
    expect(read(after)).toBeNull();
  } finally {
    await app.close();
  }
});

test('an agent that fails leaves the shell alive so the error is visible', async ({}, testInfo) => {
  /**
   * The other half of `&&`, and the reason it is not `;`.
   *
   * A mistyped `claudeCommand` (story 090) exits 127. With `;` that would close
   * every new session the instant it opened, with `command not found` scrolling
   * past inside a pty that was already going away — the worst failure this
   * change could have. `&&` short-circuits, so the login shell stays up.
   */
  const configPath = testInfo.outputPath('hive-config.json');
  const stub = testInfo.outputPath('claude-stub.sh');
  const after = testInfo.outputPath('after.txt');
  writeStubCommand(stub, testInfo.outputPath('ran-in.txt'));
  writeConfig(configPath, { claudeCommand: stub });

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await openSession(page);
    await expectFile(testInfo.outputPath('ran-in.txt'), REAL_DIRECTORY);

    await page.evaluate(
      ([sessionId, marker]) => {
        window.hive!.pty.write({
          sessionId: sessionId!,
          data: `echo shell-alive > '${marker}'\n`,
        });
      },
      [SESSION, after],
    );

    await expectFile(after, 'shell-alive');
  } finally {
    await app.close();
  }
});

test('opening a session twice attaches to the same process', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  const stub = testInfo.outputPath('claude-stub.sh');
  const pidFile = testInfo.outputPath('pid.txt');
  writeStubCommand(stub, testInfo.outputPath('ran-in.txt'));
  writeConfig(configPath, { claudeCommand: stub });

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await openSession(page);
    await expectFile(testInfo.outputPath('ran-in.txt'), REAL_DIRECTORY);

    const recordPid = async (marker: string) => {
      await page.evaluate(
        ([sessionId, path]) => {
          window.hive!.pty.write({
            sessionId: sessionId!,
            data: `echo $$ > '${path}'\n`,
          });
        },
        [SESSION, marker],
      );
    };

    await recordPid(pidFile);
    await expect.poll(() => read(pidFile), { timeout: 20_000 }).not.toBeNull();
    const before = read(pidFile);

    // Navigate away and back — the journey that must never respawn.
    await page.getByRole('button', { name: /lead-form/ }).first().click();
    await page.getByRole('button', { name: new RegExp(SESSION) }).first().click();

    const second = testInfo.outputPath('pid-2.txt');
    await recordPid(second);
    await expect.poll(() => read(second), { timeout: 20_000 }).not.toBeNull();

    // A stable pid is the proof: same shell, same context, still running.
    expect(read(second)).toBe(before);
  } finally {
    await app.close();
  }
});

test('restart produces a fresh process and the old one is gone', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  const stub = testInfo.outputPath('claude-stub.sh');
  writeStubCommand(stub, testInfo.outputPath('ran-in.txt'));
  writeConfig(configPath, { claudeCommand: stub });

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await openSession(page);
    await expectFile(testInfo.outputPath('ran-in.txt'), REAL_DIRECTORY);

    const pidOf = async (marker: string) => {
      await page.evaluate(
        ([sessionId, path]) => {
          window.hive!.pty.write({
            sessionId: sessionId!,
            data: `echo $$ > '${path}'\n`,
          });
        },
        [SESSION, marker],
      );
      await expect.poll(() => read(marker), { timeout: 20_000 }).not.toBeNull();
      return read(marker);
    };

    const before = await pidOf(testInfo.outputPath('pid-before.txt'));

    await page.evaluate(
      ([sessionId, projectId]) =>
        window.hive!.pty.restart({
          sessionId: sessionId!,
          projectId: projectId!,
          cols: 80,
          rows: 24,
        }),
      [SESSION, PROJECT],
    );

    const after = await pidOf(testInfo.outputPath('pid-after.txt'));

    expect(after).not.toBe(before);
    // The old shell really died rather than being abandoned.
    expect(isAlive(Number(before))).toBe(false);
  } finally {
    await app.close();
  }
});

/** Is this pid still around? `kill -0` asks without signalling anything. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('quitting the app leaves zero descendant processes', async ({}, testInfo) => {
  /**
   * The single most important teardown in the codebase.
   *
   * A `claude` process that outlives the app is invisible, keeps consuming
   * tokens, and can still write to the repository. This asserts the property
   * directly — the shell's own pid, checked after the app has exited — rather
   * than trusting that the shutdown hook was registered.
   */
  const configPath = testInfo.outputPath('hive-config.json');
  const stub = testInfo.outputPath('claude-stub.sh');
  const pidFile = testInfo.outputPath('pid.txt');
  writeStubCommand(stub, testInfo.outputPath('ran-in.txt'));
  writeConfig(configPath, { claudeCommand: stub });

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  const page = await app.firstWindow();
  await openSession(page);
  await expectFile(testInfo.outputPath('ran-in.txt'), REAL_DIRECTORY);

  // A long-lived child of the session's shell, so the check covers the whole
  // process *group* and not just the shell that started it.
  await page.evaluate(
    ([sessionId, path]) => {
      window.hive!.pty.write({
        sessionId: sessionId!,
        data: `sh -c 'echo $$ > "${path}"; sleep 300' &\n`,
      });
    },
    [SESSION, pidFile],
  );
  await expect.poll(() => read(pidFile), { timeout: 20_000 }).not.toBeNull();

  const descendant = Number(read(pidFile));
  expect(isAlive(descendant)).toBe(true);

  await app.close();

  await expect.poll(() => isAlive(descendant), { timeout: 20_000 }).toBe(false);
});

test('a session starts as the model and effort it was spawned with', async ({}, testInfo) => {
  /**
   * The story-109 defect, end to end.
   *
   * The picker offered a model and a thinking effort, recorded both on the
   * entity, and rendered them on the session's chip — and sent neither to the
   * process. Every session opened as whatever `claude` defaults to while the
   * app confidently said otherwise.
   *
   * Driven through `pty.spawn` rather than the picker UI on purpose: what needs
   * proving here is the chain the unit tests each see only one link of — the
   * IPC guard, main's command assembly, and a real `/bin/sh` parsing the
   * result. The picker's end of it is covered where the picker is.
   */
  const configPath = testInfo.outputPath('hive-config.json');
  const stub = testInfo.outputPath('claude-stub.sh');
  const argsFile = testInfo.outputPath('args.txt');
  writeArgsStub(stub, argsFile);
  writeConfig(configPath, { claudeCommand: stub });

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    await page.evaluate(
      ([sessionId, projectId]) =>
        window.hive!.pty.spawn({
          sessionId: sessionId!,
          projectId: projectId!,
          cols: 80,
          rows: 24,
          model: 'haiku',
          effort: 'low',
        }),
      [SESSION, PROJECT],
    );

    // Two flags, four words, in the order `claude` documents them — and
    // crucially nothing else beyond the identity flags, so `&& exit` did not
    // leak into the argument list.
    await expectArgs(argsFile, '--model haiku --effort low');

    // The identity flags are still asserted, just not by literal value: the
    // point of stripping them is to tolerate a uuid, not to stop covering them.
    expect(read(argsFile)).toContain('--session-id ');
  } finally {
    await app.close();
  }
});

test('a session spawned without a model gets the bare command', async ({}, testInfo) => {
  /**
   * The other half, and the one that protects a setting this app does not own.
   *
   * A fixture opened for the first time, or a `spawn` typed into the console
   * before the picker existed, names no model. Substituting a default here
   * would silently override whatever the user configured in `claude` itself —
   * so absent means *say nothing*, not *say the default out loud*.
   */
  const configPath = testInfo.outputPath('hive-config.json');
  const stub = testInfo.outputPath('claude-stub.sh');
  const argsFile = testInfo.outputPath('args.txt');
  writeArgsStub(stub, argsFile);
  writeConfig(configPath, { claudeCommand: stub });

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    await page.evaluate(
      ([sessionId, projectId]) =>
        window.hive!.pty.spawn({
          sessionId: sessionId!,
          projectId: projectId!,
          cols: 80,
          rows: 24,
        }),
      [SESSION, PROJECT],
    );

    await expectArgs(argsFile, '');
  } finally {
    await app.close();
  }
});

test('an unmapped project is refused by name, with the file to edit', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  writeConfig(configPath, { claudeCommand: 'claude', projects: [] });

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    const message = await page.evaluate(
      ([sessionId, projectId]) =>
        window
          .hive!.pty.spawn({
            sessionId: sessionId!,
            projectId: projectId!,
            cols: 80,
            rows: 24,
          })
          .then(
            () => 'no refusal',
            (cause: Error) => cause.message,
          ),
      ['ghost-session', 'apfm-web'],
    );

    // Names the project *and* the file. "Not mapped" alone sends the user
    // looking for a setting that does not exist.
    expect(message).toContain('apfm-web is not mapped');
    expect(message).toContain(configPath);
  } finally {
    await app.close();
  }
});

/** Kept so a stray `sleep` from a failed run cannot outlive the suite. */
test.afterAll(() => {
  try {
    execFileSync('pkill', ['-f', 'sleep 300'], { stdio: 'ignore' });
  } catch {
    // Nothing matched, which is the expected outcome.
  }
});
