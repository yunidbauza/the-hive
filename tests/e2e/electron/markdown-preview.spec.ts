import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { launchHive, startSession, writeProjectConfig } from './fixtures/hive-app';

/**
 * The markdown preview in the built app.
 *
 * What only the real app shows: a file opened from a real tree renders, a
 * rewrite on disk reaches the preview through the real watcher, and a relative
 * link is answered by the real `fs:resolve` in main.
 */

function writeFixtureRepo(root: string): void {
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Fixture\n\nRead [the guide](docs/guide.md).\n');
  writeFileSync(join(root, 'docs', 'guide.md'), '# Guide\n\nHello.\n');
}

async function launch(outputPath: (name: string) => string, repo: string) {
  writeFixtureRepo(repo);
  writeProjectConfig(outputPath('hive-config.json'), { id: 'fixture', path: repo });
  const app = await launchHive({
    userDataDir: outputPath('user-data'),
    configPath: outputPath('hive-config.json'),
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('nav[aria-label="Places"]');
  await startSession(page, 'fixture');
  await page
    .getByRole('complementary', { name: 'Session panel' })
    .getByRole('tab', { name: /^Files/ })
    .click();
  return { app, page };
}

test('a markdown file opens rendered, follows the disk, and follows its links', async ({}, testInfo) => {
  const repo = testInfo.outputPath('repo');
  const { app, page } = await launch((name) => testInfo.outputPath(name), repo);

  try {
    await page.locator('[data-panel="explorer"]').getByRole('button', { name: 'README.md' }).click();
    const preview = page.locator('[data-markdown-preview]');
    await expect(preview.getByRole('heading', { name: 'Fixture' })).toBeVisible();

    writeFileSync(join(repo, 'README.md'), '# Rewritten\n\nRead [the guide](docs/guide.md).\n');
    await expect(preview.getByRole('heading', { name: 'Rewritten' })).toBeVisible({
      timeout: 10_000,
    });

    await preview.getByRole('button', { name: 'the guide' }).click();
    await expect(page.getByRole('tab', { name: 'guide.md' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(preview.getByRole('heading', { name: 'Guide' })).toBeVisible();

    await page.getByRole('radio', { name: 'Split' }).click();
    await expect(page.locator('.cm-content')).toContainText('# Guide');
    await expect(preview.getByRole('heading', { name: 'Guide' })).toBeVisible();

    await page.getByRole('radio', { name: 'Source' }).click();
    await expect(preview).toHaveCount(0);
  } finally {
    await app.close();
  }
});
