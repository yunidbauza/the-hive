import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * Integrations & notifications, driven through the real app (story 106).
 *
 * The unit suite proves the pieces against fakes — a guard rejects a payload, an
 * injected runner returns canned `gh` output, a stubbed snapshot renders a
 * switch. What none of it can say is whether a click in the renderer reaches
 * main, whether main's write produces a file the reader accepts, or whether the
 * pane survives a machine where `gh` is genuinely absent. That is this file.
 *
 * `HIVE_CONFIG_PATH` points at a scratch file, so nothing here touches the
 * developer's own `~/.hive/config.json`.
 */

const openIntegrations = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Integrations' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Integrations', level: 2 }),
  ).toBeVisible();
};

/** A config with one real project, and a comment the UI must not eat. */
function seed(outputPath: (name: string) => string) {
  const repoDir = outputPath('scratch-repo');
  mkdirSync(join(repoDir, '.git'), { recursive: true });

  const configPath = outputPath('hive-config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        '//': 'a comment the UI must not eat',
        version: 2,
        shell: '/bin/sh',
        claudeCommand: 'claude',
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

test('reports a gh state without throwing, installed or not', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openIntegrations(page);

  /**
   * Whether this runner has `gh` is not something to assert — both are valid
   * answers and CI machines differ. What must hold on every machine is that the
   * pane reaches a *verdict* rather than sitting on "Checking…" or crashing,
   * which is what would happen if executing a subprocess from main went wrong.
   */
  await expect(page.getByText('Checking…').first()).toBeHidden({ timeout: 15_000 });

  // And whichever way it went, the token-source group states the promise.
  await expect(page.getByText(/does not store a token/i)).toBeVisible();

  await app.close();
});

test('offers only the three classes that have a real event behind them', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openIntegrations(page);

  await expect(page.getByRole('switch')).toHaveCount(3);
  // `waiting` is not derivable from a pty (story 096), so it must not appear —
  // not even disabled.
  await expect(page.getByRole('switch', { name: /waiting/i })).toHaveCount(0);

  await app.close();
});

test('a toggled switch lands in the file, comments intact', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openIntegrations(page);

  // The file starts with no block at all: reading applies the defaults in
  // memory and writes nothing.
  expect(read(configPath).notifications).toBeUndefined();

  await page.getByRole('switch', { name: /session finishes/i }).click();

  await expect
    .poll(() => (read(configPath).notifications as Record<string, unknown>)?.sessionDone)
    .toBe(false);

  const written = read(configPath);
  expect(written['//']).toBe('a comment the UI must not eat');
  // Only the class the user moved is written. The other two are defaulted in
  // memory, so a later change to the defaults still reaches this user.
  expect(written.notifications).toEqual({ sessionDone: false });
  // And nothing else in the file was restated.
  expect(written.claudeCommand).toBe('claude');
  expect((written.projects as unknown[])?.length).toBe(1);

  await app.close();
});

test('a second toggle does not restate the first', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openIntegrations(page);

  await page.getByRole('switch', { name: /session goes quiet/i }).click();
  await expect
    .poll(() => (read(configPath).notifications as Record<string, unknown>)?.sessionIdle)
    .toBe(true);

  await page.getByRole('switch', { name: /clone finishes/i }).click();
  await expect
    .poll(() => (read(configPath).notifications as Record<string, unknown>)?.cloneDone)
    .toBe(false);

  // `sessionDone` was never touched, so it must still be absent — the partial
  // write is what keeps an untouched class out of the user's file.
  expect(read(configPath).notifications).toEqual({
    sessionIdle: true,
    cloneDone: false,
  });

  await app.close();
});

test('a hand-written class survives a save made through the UI', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  // The interesting conformance case: a block written by hand, including a key
  // this build has never heard of.
  const document = read(configPath);
  writeFileSync(
    configPath,
    JSON.stringify(
      { ...document, notifications: { sessionDone: false, waiting: true } },
      null,
      2,
    ),
  );

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openIntegrations(page);

  // The hand-written value is what the switch shows.
  await expect(
    page.getByRole('switch', { name: /session finishes/i }),
  ).toHaveAttribute('aria-checked', 'false');

  await page.getByRole('switch', { name: /clone finishes/i }).click();

  await expect
    .poll(() => (read(configPath).notifications as Record<string, unknown>)?.cloneDone)
    .toBe(false);

  // The unknown key survives: the mutation spreads the block rather than
  // rebuilding it, so a class a later story adds is not eaten by this one.
  expect(read(configPath).notifications).toEqual({
    sessionDone: false,
    waiting: true,
    cloneDone: false,
  });

  await app.close();
});
