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

/** A stand-in for `claude`: records that it ran, with its cwd, then exits. */
function writeStubCommand(path: string, marker: string): void {
  writeFileSync(
    path,
    `#!/bin/sh\nprintf 'stub-claude-started\\n'\npwd > '${marker}'\n`,
    { encoding: 'utf8' },
  );
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

test('the shell outlives the command it bootstrapped', async ({}, testInfo) => {
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

    /**
     * The reason the bootstrap is written as *input* rather than passed as
     * `$SHELL -l -c claude`: with `-c`, the shell exits when the command does
     * and the user is left looking at a corpse in the middle of a repository
     * they were working in, unable to run `git diff` or start another turn.
     */
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
