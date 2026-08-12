import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * Advanced & diagnostics, driven through the real app (story 107).
 *
 * The unit suite proves the pieces against fakes — a mocked bridge routes a
 * verb, a stubbed snapshot renders a row. What it cannot say is whether main's
 * reset produces a file the reader accepts, or whether `appInfo()` answers with
 * real versions over a real channel. That is what this covers.
 *
 * **Reveal is deliberately not driven.** `shell.showItemInFolder` opens a real
 * Finder window on whatever machine is running the suite, which is not
 * something to do to CI. Its contract is covered where it can be: the preload
 * test asserts the channel and that no argument is forwarded, and
 * `security.spec.ts` asserts it is on the bridge's exact key set.
 *
 * `HIVE_CONFIG_PATH` points at a scratch file, so nothing here touches the
 * developer's own `~/.hive/config.json`.
 */

const openAdvanced = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Advanced' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Advanced', level: 2 }),
  ).toBeVisible();
};

/**
 * A config with one real project, a comment, and an unknown key.
 *
 * All three matter: reset is the one write that must discard *every* one of
 * them, and a seed carrying only projects would pass while the preservation
 * rule silently kept leaking through.
 */
function seed(outputPath: (name: string) => string) {
  const repoDir = outputPath('scratch-repo');
  mkdirSync(join(repoDir, '.git'), { recursive: true });

  const configPath = outputPath('hive-config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        '//mine': 'a comment reset is allowed to eat',
        version: 2,
        shell: '/bin/sh',
        futureKey: 'something this build does not know',
        projects: [
          { id: 'scratch-repo', name: 'scratch-repo', path: repoDir, icon: 'ph-folder' },
        ],
      },
      null,
      2,
    ),
  );

  return { configPath, repoDir };
}

const read = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

test('reports the config path and this build’s versions', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openAdvanced(page);

  await expect(page.getByText(configPath)).toBeVisible();

  /*
    Real versions over a real channel — the unit test can only prove plumbing.

    `exact` throughout: unpackaged, `app.getPath('logs')` answers
    `~/Library/Logs/Electron`, so a loose "Electron" also matches the log path
    two groups below and the assertion stops meaning what it says.
  */
  await expect(page.getByText('Electron', { exact: true })).toBeVisible();
  await expect(page.getByText('Chromium', { exact: true })).toBeVisible();
  await expect(page.getByText(/writes no log file/i)).toBeVisible();

  // Nothing has spawned in this window, so the omitted-not-empty distinction
  // main keeps must reach the screen as a sentence.
  await expect(page.getByText(/no session has run yet/i)).toBeVisible();

  await app.close();
});

test('reload re-reads a file edited underneath the running app', async ({}, testInfo) => {
  const { configPath, repoDir } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openAdvanced(page);

  /*
    The whole reason this button exists. The epic declined a config watcher, so
    an edit made outside the app reaches it by exactly one route — and if that
    route did not work, the decision to decline the watcher would have left the
    product with no way to pick up a hand edit at all.
  */
  const second = testInfo.outputPath('scratch-repo-two');
  mkdirSync(join(second, '.git'), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        version: 2,
        projects: [
          { id: 'scratch-repo', name: 'scratch-repo', path: repoDir, icon: 'ph-folder' },
          { id: 'scratch-two', name: 'scratch-two', path: second, icon: 'ph-folder' },
        ],
      },
      null,
      2,
    ),
  );

  await page.getByRole('button', { name: 'Reload' }).click();

  await expect(page.getByText('Reloaded — 2 projects.')).toBeVisible();

  await app.close();
});

test('reset writes the template and empties the project list', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  // Prove there is something to lose before losing it.
  expect((read(configPath).projects as unknown[]).length).toBe(1);

  await openAdvanced(page);

  await page.getByRole('button', { name: 'Reset to template' }).click();
  await expect(
    page.getByRole('alertdialog', { name: 'Reset the config file?' }),
  ).toBeVisible();
  await expect(page.getByText(/1 project,/)).toBeVisible();

  await page.getByRole('button', { name: 'Reset config' }).click();

  await expect
    .poll(() => (read(configPath).projects as unknown[]).length)
    .toBe(0);

  const written = read(configPath);
  // Still the *commented* template, not a bare `{ projects: [] }`.
  expect(written['//']).toContain('The Hive');
  expect(written.version).toBe(2);
  // The one write that discards what it did not put there.
  expect(written['//mine']).toBeUndefined();
  expect(written.futureKey).toBeUndefined();
  expect(written.shell).toBeUndefined();

  // And the renderer installed the snapshot main returned, without a reload.
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Projects' })
    .click();
  await expect(page.getByText('scratch-repo')).toHaveCount(0);

  await app.close();
});

test('cancelling the confirmation leaves the file alone', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openAdvanced(page);

  await page.getByRole('button', { name: 'Reset to template' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();

  await expect(page.getByRole('button', { name: 'Reset to template' })).toBeVisible();
  expect(read(configPath)['//mine']).toBe('a comment reset is allowed to eat');
  expect((read(configPath).projects as unknown[]).length).toBe(1);

  await app.close();
});
