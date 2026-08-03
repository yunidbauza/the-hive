import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * The seam, cashed in (story 094).
 *
 * The unit suite proves `PtyTransport` against a stubbed bridge; story 093's
 * spec proves the IPC path with no terminal on it. Neither can answer the
 * question this story actually asks — **does opening a session in the desktop
 * app show a live shell?** — because answering it needs a real pty on one end
 * and a real xterm on the other.
 *
 * That is also why the ack loop is only genuinely closed here. Story 093's spec
 * had to stand in for xterm's write callback by hand; this one has the real
 * one, and a session that streams output without stalling is the proof that the
 * renderer half of flow control is connected.
 */

/** A directory that certainly exists on any machine running this. */
const REAL_DIRECTORY = join(import.meta.dirname, '../../..');

/** The fixture session used throughout the e2e suite, and its project. */
const SESSION = 'hero-refresh';
const PROJECT = 'apfm-web';

function writeConfig(path: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      // `sh`, so this holds wherever CI runs it.
      shell: '/bin/sh',
      projects: [{ id: PROJECT, path: REAL_DIRECTORY }],
    }),
  );
}

test('opening a session shows a live shell, not a recording', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  writeConfig(configPath);

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    await page.getByRole('button', { name: new RegExp(SESSION) }).first().click();

    const terminal = page.locator(`[data-terminal-id="${SESSION}"]`);
    await expect(terminal).toBeVisible();

    /**
     * A marker written *into the running shell*, then read back off the
     * rendered terminal.
     *
     * Asserting on a prompt would be asserting on the user's `$PS1`, which
     * varies per machine and is empty under `sh -c` on some systems. Echoing a
     * token proves the same thing more strongly: a process is alive, it is
     * attached to this surface, and its output reached xterm.
     *
     * The write goes through the bridge rather than the keyboard because
     * typing into the terminal is story 095 — until then `write` is reachable
     * but nothing calls it from a keypress.
     */
    await page.evaluate((sessionId) => {
      window.hive!.pty.write({
        sessionId,
        data: 'echo HIVE_LIVE_SHELL_OK\n',
      });
    }, SESSION);

    await expect(terminal).toContainText('HIVE_LIVE_SHELL_OK', { timeout: 15_000 });
  } finally {
    await app.close();
  }
});

test('a session keeps running while the user looks at something else', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  writeConfig(configPath);

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    await page.getByRole('button', { name: new RegExp(SESSION) }).first().click();
    const terminal = page.locator(`[data-terminal-id="${SESSION}"]`);
    await expect(terminal).toBeVisible();

    // Prove the shell is up before navigating away, so the assertion after the
    // switch cannot pass by accident on a session that never started.
    await page.evaluate((sessionId) => {
      window.hive!.pty.write({ sessionId, data: 'echo BEFORE_LEAVING\n' });
    }, SESSION);
    await expect(terminal).toContainText('BEFORE_LEAVING', { timeout: 15_000 });

    await page.getByRole('button', { name: /lead-form/ }).first().click();

    /**
     * Output produced while the surface is not the visible one.
     *
     * This is the disposer contract under test: unmounting a surface happens on
     * every tab switch, and a transport that killed the pty there would end a
     * running agent because the user glanced at something else.
     */
    await page.evaluate((sessionId) => {
      window.hive!.pty.write({ sessionId, data: 'echo WHILE_AWAY\n' });
    }, SESSION);

    await page.getByRole('button', { name: new RegExp(SESSION) }).first().click();

    await expect(terminal).toContainText('WHILE_AWAY', { timeout: 15_000 });
    // And the earlier transcript is still there — coming back is not a reset.
    await expect(terminal).toContainText('BEFORE_LEAVING');
  } finally {
    await app.close();
  }
});

test('an exited session says so, and leaves its transcript readable', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  writeConfig(configPath);

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    await page.getByRole('button', { name: new RegExp(SESSION) }).first().click();
    const terminal = page.locator(`[data-terminal-id="${SESSION}"]`);
    await expect(terminal).toBeVisible();

    await page.evaluate((sessionId) => {
      window.hive!.pty.write({ sessionId, data: 'echo LAST_WORDS; exit 3\n' });
    }, SESSION);

    // The lifecycle line belongs to the transcript, in the place it happened —
    // and it carries the code, because a non-zero exit is information.
    await expect(terminal).toContainText('session exited (code 3)', {
      timeout: 15_000,
    });
    // The output before it survives: an exit notice is not a clear-screen.
    await expect(terminal).toContainText('LAST_WORDS');
  } finally {
    await app.close();
  }
});
