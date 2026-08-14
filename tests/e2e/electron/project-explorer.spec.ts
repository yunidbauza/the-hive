import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  launchHive,
  startSession,
  writeProjectConfig,
} from './fixtures/hive-app';

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

/**
 * The session's own terminal, not "any xterm on the page".
 *
 * `launch` opens a session now (HIVE-93), and the overmind console is an xterm
 * surface too — so a bare `.xterm` matches two elements and trips Playwright's
 * strict mode. Before this change these specs ran with no session at all, which
 * is why one loose selector used to be unambiguous.
 */
const sessionTerminal = (page: Page) =>
  page.locator('[data-terminal-id^="sess-"] .xterm');

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

  /**
   * A session first — the explorer follows the one on screen (HIVE-93).
   *
   * This helper used to click straight through to the Explorer tab and find a
   * tree, because the panel fell back to the first mapped project when no session
   * was open. That fallback is gone: a tree for a repository nothing on screen is
   * working in invited the user to open files from it, so the panel now shows
   * nothing instead. Every test below is about the tree, so every one of them
   * needs a session in `fixture`.
   *
   * The no-session state has its own test at the bottom of this file.
   */
  await startSession(page, 'fixture');

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
    await expect(sessionTerminal(page)).toBeHidden();

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Editor' }).click();
    await page.getByRole('radio', { name: 'Split' }).click();
    await page.keyboard.press('Escape');

    /**
     * Both on screen at once, and a divider between them. The terminal being
     * *visible* is the assertion: a split that rendered the editor over a
     * hidden terminal would satisfy every unit test and none of the point.
     */
    await expect(sessionTerminal(page)).toBeVisible();
    await expect(page.locator('.cm-content')).toContainText('# Fixture');
    await expect(page.getByRole('slider', { name: 'Resize the editor' })).toBeVisible();
    // No Terminal entry: it is already on screen.
    await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

/**
 * The tree follows the session, and shows nothing when there is none (HIVE-93).
 *
 * Driven in a real window because this is a *navigation* property: the panel has
 * to stop showing a repository the moment the stage stops showing a session in
 * it, and the unit test can only prove the hook's answer. What it could not
 * prove is that leaving the session actually re-renders the panel.
 *
 * The state used to be unreachable: the explorer fell back to the last-visited
 * project and then to the first mapped one, so every row in it opened a file from
 * a repository nothing on screen was working in.
 */
test('the explorer empties when the overmind tab is showing', async ({}, testInfo) => {
  const repo = testInfo.outputPath('repo');
  const { app, page } = await launch((name) => testInfo.outputPath(name), repo);

  try {
    const tree = page.locator('[data-panel="explorer"]');

    // The session is open, so the tree is there.
    await expect(tree.getByText('README.md')).toBeVisible();

    await page.getByRole('button', { name: 'Back to overmind' }).click();

    // And now it is not — with a sentence naming the way back, rather than a
    // blank column or a stale tree.
    await expect(tree.getByText('README.md')).toHaveCount(0);
    await expect(tree.getByText(/No session open/i)).toBeVisible();
    /*
      Specifically NOT the setup message: projects are mapped, so sending the
      user to Settings would blame them for something that is not broken.
    */
    await expect(tree.getByText(/No projects mapped/i)).toHaveCount(0);
  } finally {
    await app.close();
  }
});

/**
 * The bell shows the inbox instead of marking it read (HIVE-93).
 *
 * Here rather than in the web project because the rail's INBOX tab is what has
 * to become active, and that is a real click on real chrome — the unit test can
 * assert the store call, not that the tab the user sees changes.
 */
test('the header bell reveals the Inbox tab', async ({}, testInfo) => {
  const repo = testInfo.outputPath('repo');
  const { app, page } = await launch((name) => testInfo.outputPath(name), repo);

  try {
    // `launch` leaves the Explorer tab selected, so the inbox is genuinely not
    // the current tab when the bell is clicked.
    await expect(page.getByRole('tab', { name: /^Explorer/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await page.getByRole('button', { name: /^Inbox —/ }).click();

    await expect(page.getByRole('tab', { name: /^Inbox/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Nothing to read on a fresh launch, and the label says so rather than
    // offering to mark anything.
    await expect(
      page.getByRole('button', { name: 'Inbox — nothing unread' }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});
