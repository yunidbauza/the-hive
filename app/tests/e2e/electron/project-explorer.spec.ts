import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { launchHive, writeProjectConfig } from './fixtures/hive-app';

/**
 * The project explorer and the editor, in the built app.
 *
 * ## Why this cannot be a web spec
 *
 * Both surfaces need the preload bridge, which the browser target does not
 * have — there the panel deliberately says so and renders nothing else. And the
 * tree roots at a project from the workspace config, which the browser target
 * also does not have.
 *
 * ## What this reaches that the unit tests cannot
 *
 * That a real `readdir` in a real main process reaches a real tree; that
 * clicking a file puts its **actual bytes** on screen through CodeMirror; that
 * the noise filter applies to a directory that genuinely contains
 * `node_modules`; and — the one that no amount of mocking could establish —
 * that a file rewritten on disk under a clean buffer is silently reloaded.
 */

/** A repository shaped like the ones this app is used on. */
function writeFixtureRepo(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'react'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.github'), { recursive: true });

  writeFileSync(join(root, 'README.md'), '# Fixture\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  writeFileSync(join(root, 'src', 'app.ts'), 'export const answer = 42;\n');
  writeFileSync(join(root, 'node_modules', 'react', 'index.js'), 'module.exports={}\n');
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
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
  await page.waitForSelector('header');

  await page.getByRole('tab', { name: 'Explorer' }).click();
  return { app, page };
}

test('the tree lists the repository, hiding the noise', async ({}, testInfo) => {
  const repo = testInfo.outputPath('repo');
  const { app, page } = await launch((name) => testInfo.outputPath(name), repo);

  try {
    const tree = page.locator('[data-panel="explorer"]');

    await expect(tree.getByText('src', { exact: true })).toBeVisible();
    await expect(tree.getByText('README.md')).toBeVisible();

    /**
     * The point of the list. `.github` and `.gitignore` are dotfiles a person
     * opens; `.git` and `node_modules` are not — and a rule that hid every name
     * starting with a dot would hide all four.
     */
    await expect(tree.getByText('.github')).toBeVisible();
    await expect(tree.getByText('.gitignore')).toBeVisible();
    await expect(tree.getByText('node_modules')).toHaveCount(0);
    await expect(tree.getByText('.git', { exact: true })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('expanding reads lazily, and clicking a file opens it in the editor', async ({}, testInfo) => {
  const repo = testInfo.outputPath('repo');
  const { app, page } = await launch((name) => testInfo.outputPath(name), repo);

  try {
    const tree = page.locator('[data-panel="explorer"]');

    // Collapsed: the child was never read, so it is not in the DOM at all.
    await expect(tree.getByText('app.ts')).toHaveCount(0);

    await tree.getByRole('button', { name: 'src' }).click();
    await expect(tree.getByText('app.ts')).toBeVisible();

    await tree.getByRole('button', { name: 'app.ts' }).click();

    /**
     * The real bytes, rendered by a real CodeMirror.
     *
     * `.cm-content` is CodeMirror's own document element — if the editor failed
     * to construct, this is empty and the assertion says so rather than passing
     * on a div that happens to contain the text.
     */
    await expect(page.locator('.cm-content')).toContainText(
      'export const answer = 42;',
    );

    // Full-stage placement is the default, so the strip carries a way back.
    await expect(page.getByRole('tab', { name: 'Terminal' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'app.ts' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('the Terminal tab returns to the terminal without closing the file', async ({}, testInfo) => {
  const repo = testInfo.outputPath('repo');
  const { app, page } = await launch((name) => testInfo.outputPath(name), repo);

  try {
    const tree = page.locator('[data-panel="explorer"]');
    await tree.getByRole('button', { name: 'README.md' }).click();
    await expect(page.locator('.cm-content')).toContainText('# Fixture');

    await page.getByRole('tab', { name: 'Terminal' }).click();
    await expect(page.locator('.cm-content')).toHaveCount(0);
    // The tab survives, which is the difference between "go back" and "close".
    await expect(page.getByRole('tab', { name: 'README.md' })).toBeVisible();

    await page.getByRole('tab', { name: 'README.md' }).click();
    await expect(page.locator('.cm-content')).toContainText('# Fixture');
  } finally {
    await app.close();
  }
});

/**
 * **The claim the whole feature is arranged around.**
 *
 * You open a file to watch what a session does to it. A confirmation prompt
 * between you and that is friction carrying no information — so a clean buffer
 * is reloaded silently, and only a dirty one interrupts.
 *
 * Unreachable without a real watcher: the unit test asserts that `reconcile`
 * reloads, and this asserts that the OS told us to.
 */
test('a file rewritten on disk reloads under a clean buffer', async ({}, testInfo) => {
  const repo = testInfo.outputPath('repo');
  const { app, page } = await launch((name) => testInfo.outputPath(name), repo);

  try {
    const tree = page.locator('[data-panel="explorer"]');
    await tree.getByRole('button', { name: 'src' }).click();
    await tree.getByRole('button', { name: 'app.ts' }).click();
    await expect(page.locator('.cm-content')).toContainText('answer = 42');

    writeFileSync(join(repo, 'src', 'app.ts'), 'export const answer = 99;\n');

    await expect(page.locator('.cm-content')).toContainText('answer = 99', {
      timeout: 10_000,
    });
    // Silently: no banner, because there was nothing of the user's to protect.
    await expect(page.getByText(/Changed on disk/)).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('the split placement setting puts the terminal and the editor side by side', async ({}, testInfo) => {
  const repo = testInfo.outputPath('repo');
  const { app, page } = await launch((name) => testInfo.outputPath(name), repo);

  try {
    await page.locator('[data-panel="explorer"]')
      .getByRole('button', { name: 'README.md' })
      .click();
    await expect(page.locator('.cm-content')).toContainText('# Fixture');

    // In full placement the terminal is hidden behind the editor.
    await expect(page.locator('.xterm')).toBeHidden();

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Editor' }).click();
    await page.getByRole('radio', { name: 'Split' }).click();
    await page.keyboard.press('Escape');

    /**
     * Both on screen at once, and a divider between them. The terminal being
     * *visible* is the assertion: a split that rendered the editor over a
     * hidden terminal would satisfy every unit test and none of the point.
     */
    await expect(page.locator('.xterm')).toBeVisible();
    await expect(page.locator('.cm-content')).toContainText('# Fixture');
    await expect(page.getByRole('slider', { name: 'Resize the editor' })).toBeVisible();
    // No Terminal entry: it is already on screen.
    await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});
