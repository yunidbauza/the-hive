import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * Runtime settings, driven through the real app (story 104).
 *
 * The unit suite proves the pieces against fakes — a guard rejects a payload, a
 * mocked bridge routes a verb, a stubbed snapshot renders a row. None of that
 * says whether the renderer's keystroke reaches main, whether main's write
 * produces a file the reader accepts, or whether the PATH diagnostic can see a
 * real filesystem. That is what this covers.
 *
 * `HIVE_CONFIG_PATH` points at a scratch file, so nothing here touches the
 * developer's own `~/.hive/config.json`.
 */

const openRuntime = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Runtime' })
    .click();
  await expect(page.getByRole('heading', { name: 'Runtime', level: 2 })).toBeVisible();
};

/** A config with one real project directory, and a comment the UI must not eat. */
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

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

test('edits the default shell and preserves the file’s comments', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openRuntime(page);

  const shell = page.getByRole('textbox', { name: 'Shell' });
  await expect(shell).toHaveValue('/bin/sh');
  await shell.fill('/bin/zsh');
  await shell.press('Enter');

  await expect
    .poll(() => read(configPath).shell)
    .toBe('/bin/zsh');

  const written = read(configPath);
  // The whole-file write must not eat the comment or restate the other field.
  expect(written['//']).toBe('a comment the UI must not eat');
  expect(written.claudeCommand).toBe('claude');

  await app.close();
});

test('sets and clears a per-project override', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openRuntime(page);
  await page
    .getByRole('combobox', { name: 'Project' })
    .selectOption('scratch-repo');

  const override = page.getByRole('textbox', { name: 'Shell override' });
  // Empty means inherit; the inherited value is only a placeholder.
  await expect(override).toHaveValue('');
  await override.fill('/bin/bash');
  await override.press('Enter');

  await expect
    .poll(() => read(configPath).projects[0].shell)
    .toBe('/bin/bash');

  await override.fill('');
  await override.press('Enter');

  // Cleared means the key is gone — not `""`, which would spawn a shell named
  // `""` and fail with a message no user could act on.
  await expect
    .poll(() => 'shell' in read(configPath).projects[0])
    .toBe(false);

  await app.close();
});

test('saves per-project environment variables', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openRuntime(page);
  await page
    .getByRole('combobox', { name: 'Project' })
    .selectOption('scratch-repo');

  await page.getByRole('button', { name: 'Add variable' }).click();
  await page.getByRole('textbox', { name: 'Variable 1 name' }).fill('API_URL');
  await page
    .getByRole('textbox', { name: 'Variable 1 value' })
    .fill('https://example.test');
  await page.getByRole('button', { name: 'Save variables' }).click();

  await expect
    .poll(() => read(configPath).projects[0].env)
    .toEqual({ API_URL: 'https://example.test' });

  await app.close();
});

test('the diagnostic reports the PATH it actually searched', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openRuntime(page);
  await page.getByRole('button', { name: 'Check the default command' }).click();

  /**
   * `claude` is genuinely unlikely to be on the PATH of a CI runner, and that
   * is the case worth proving: the diagnostic must explain *why* rather than
   * assert the command is missing. Either verdict is acceptable here — what is
   * asserted is that a real answer came back from a real filesystem.
   */
  const verdict = page.getByText(/claude/).first();
  await expect(verdict).toBeVisible();
  await expect(page.getByText('Searched')).toBeVisible();

  await app.close();
});
