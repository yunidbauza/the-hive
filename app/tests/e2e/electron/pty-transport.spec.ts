import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * The seam, cashed in (story 094).
 *
 * The unit suite proves `PtyTransport` against a stubbed bridge; story 093's
 * spec proves the IPC path with no terminal on it. Neither can answer the
 * question this story actually asks — **does opening a session in the desktop
 * app run a real shell?** — because answering it needs a real pty on one end
 * and a real xterm on the other.
 *
 * ## Why these assert files rather than screen text
 *
 * Story 095 attaches the WebGL renderer to every interactive terminal, and a
 * WebGL-rendered xterm paints into canvases: `.xterm-rows` is never populated
 * and the transcript leaves the DOM entirely, so `toContainText` reads `''` no
 * matter what is on screen. These specs originally read the screen; they were
 * rewritten rather than given a handle into the renderer.
 *
 * Asserting what the shell *did* — a marker file it wrote — is strictly
 * stronger evidence anyway: it proves the bytes reached a process and were
 * executed, not merely that something was echoed back.
 */

/** A directory that certainly exists on any machine running this. */
const REAL_DIRECTORY = join(import.meta.dirname, '../../..');

const SESSION = 'hero-refresh';
const PROJECT = 'apfm-web';

/**
 * `claudeCommand` is pointed at a marker-writing stub (story 096).
 *
 * Two reasons, both load-bearing. A spec must never start the real `claude` —
 * it would consume tokens and touch the working tree. And the bootstrap is
 * written into the shell shortly after its first output, so a spec that sends
 * its own command in that window has the two interleaved and the shell runs
 * neither; waiting for the stub's marker is how these specs know the shell is
 * theirs.
 */
function writeConfig(path: string, bootstrapMarker: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      // `sh`, so this holds wherever CI runs it.
      shell: '/bin/sh',
      claudeCommand: `printf bootstrapped > '${bootstrapMarker}'`,
      projects: [{ id: PROJECT, path: REAL_DIRECTORY }],
    }),
  );
}

/** Send a line to the session's pty through the bridge, as a keystroke would. */
async function shell(page: Page, command: string): Promise<void> {
  await page.evaluate(
    ([sessionId, data]) => {
      window.hive!.pty.write({ sessionId: sessionId!, data: data! });
    },
    [SESSION, `${command}\n`],
  );
}

/** Poll for a file the shell was told to write. */
async function expectFile(path: string, contents: string): Promise<void> {
  await expect
    .poll(() => (existsSync(path) ? readFileSync(path, 'utf8').trim() : null), {
      timeout: 15_000,
    })
    .toBe(contents);
}

test('opening a session runs a real shell in the mapped project', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  const bootstrapped = testInfo.outputPath('bootstrapped.txt');
  writeConfig(configPath, bootstrapped);
  const marker = testInfo.outputPath('where.txt');

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    await page.getByRole('button', { name: new RegExp(SESSION) }).first().click();
    await expect(page.locator(`[data-terminal-id="${SESSION}"]`)).toBeVisible();
    // The bootstrap has run, so the shell is idle and the next command is ours.
    await expectFile(bootstrapped, 'bootstrapped');

    // `pwd` proves both halves at once: a process is alive, and main resolved
    // its cwd from the workspace config rather than spawning it anywhere.
    await shell(page, `pwd > '${marker}'`);

    await expectFile(marker, REAL_DIRECTORY);
  } finally {
    await app.close();
  }
});

test('a session keeps running while the user looks at something else', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  const bootstrapped = testInfo.outputPath('bootstrapped.txt');
  writeConfig(configPath, bootstrapped);
  const before = testInfo.outputPath('before.txt');
  const away = testInfo.outputPath('away.txt');

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    await page.getByRole('button', { name: new RegExp(SESSION) }).first().click();
    await expect(page.locator(`[data-terminal-id="${SESSION}"]`)).toBeVisible();
    // The bootstrap has run, so the shell is idle and the next command is ours.
    await expectFile(bootstrapped, 'bootstrapped');

    // Prove the shell is up before navigating away, so the assertion after the
    // switch cannot pass by accident on a session that never started.
    await shell(page, `echo up > '${before}'`);
    await expectFile(before, 'up');

    await page.getByRole('button', { name: /lead-form/ }).first().click();

    /**
     * The disposer contract under test: unmounting a surface happens on every
     * tab switch, and a transport that killed the pty there would end a running
     * agent because the user glanced at something else.
     */
    await shell(page, `echo still-running > '${away}'`);
    await expectFile(away, 'still-running');
  } finally {
    await app.close();
  }
});

test('an exit reports its code, and signal 0 rather than no signal', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  const bootstrapped = testInfo.outputPath('bootstrapped.txt');
  writeConfig(configPath, bootstrapped);

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    await page.getByRole('button', { name: new RegExp(SESSION) }).first().click();
    await expect(page.locator(`[data-terminal-id="${SESSION}"]`)).toBeVisible();
    // The bootstrap has run, so the shell is idle and the next command is ours.
    await expectFile(bootstrapped, 'bootstrapped');

    const exit = await page.evaluate((sessionId) => {
      return new Promise<{ exitCode: number; signal?: number }>((resolve) => {
        const off = window.hive!.pty.onExit((event) => {
          if (event.sessionId !== sessionId) return;
          off();
          resolve({ exitCode: event.exitCode, signal: event.signal });
        });
        window.hive!.pty.write({ sessionId, data: 'exit 3\n' });
      });
    }, SESSION);

    expect(exit.exitCode).toBe(3);

    /**
     * The trap, asserted at the boundary where it is real.
     *
     * `node-pty` reports a numeric signal on *every* exit and uses `0` for "no
     * signal" — it does not omit the field. A renderer that tests only for
     * `undefined` sends every ordinary exit down the signal branch and renders
     * `session terminated (signal 0)` where it should say
     * `session exited (code 3)`. That bug shipped once in review; this is the
     * guard that keeps the contract's shape asserted rather than assumed.
     */
    expect(exit.signal).toBe(0);
  } finally {
    await app.close();
  }
});
