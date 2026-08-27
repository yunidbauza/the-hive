import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * Settings: adding a local project folder, driven through the real app
 * (story 101).
 *
 * This is the only proof the whole slice works. The unit suite proves the
 * pieces against fakes — a stubbed snapshot renders a row, a mocked bridge
 * routes a verb — and none of that says whether the renderer's click reaches
 * main, whether main resolves and writes the path, whether the file on disk is
 * one the reader accepts, or whether the new project is spawnable without a
 * restart.
 *
 * `dialog.showOpenDialog` is stubbed **in main**, not bypassed. The renderer
 * still calls `chooseDirectory` and still echoes the returned path back through
 * `addProject`, so the round trip under test is the real one; only the native
 * sheet — which Playwright cannot drive — is replaced.
 */

/** Launch with a config file already on disk, plus a scratch repo to add. */
async function launchWithConfig(
  outputPath: (name: string) => string,
  contents: string,
): Promise<{
  app: ElectronApplication;
  page: Page;
  configPath: string;
  repoDir: string;
}> {
  const configPath = outputPath('hive-config.json');
  writeFileSync(configPath, contents);

  // A real directory, created for this test, that is not the developer's tree.
  const repoDir = outputPath('scratch-repo');
  mkdirSync(join(repoDir, '.git'), { recursive: true });

  const app = await launchHive({
    userDataDir: outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');

  return { app, page, configPath, repoDir };
}

/** Replace the native sheet with one that answers immediately. */
async function stubDirectoryDialog(
  app: ElectronApplication,
  filePaths: string[],
): Promise<void> {
  await app.evaluate(({ dialog }, paths) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dialog as any).showOpenDialog = async () => ({
      canceled: paths.length === 0,
      filePaths: paths,
    });
  }, filePaths);
}

const openSettings = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
};

const EMPTY_CONFIG = JSON.stringify(
  { '//': 'a comment the UI must not eat', version: 2, projects: [] },
  null,
  2,
);

test('adds a folder, shows it in the rail, and makes it spawnable', async ({}, testInfo) => {
  const { app, page, configPath, repoDir } = await launchWithConfig(
    (name) => testInfo.outputPath(name),
    EMPTY_CONFIG,
  );

  try {
    await stubDirectoryDialog(app, [repoDir]);
    await openSettings(page);

    // The empty state is the screen a fresh install actually sees.
    await expect(
      page.getByText(/add a folder to start a session in it/i),
    ).toBeVisible();

    await page.getByRole('button', { name: /add project/i }).click();

    // The row appears without a reload: every mutating verb returns the fresh
    // snapshot, so the renderer never has to ask again.
    await expect(page.getByText('scratch-repo').first()).toBeVisible();

    // The file on disk is what the reader accepts, and it is now v2.
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(written.version).toBe(2);
    expect(written.projects).toHaveLength(1);
    expect(written.projects[0].id).toBe('scratch-repo');
    // The comment survived the write.
    expect(written['//']).toBe('a comment the UI must not eat');

    // Close settings and confirm the project reached the left rail.
    await page.getByRole('button', { name: 'Close settings' }).click();
    await expect(
      page.getByRole('button', { name: /^scratch-repo/ }),
    ).toBeVisible();

    // …and the picker offers it as spawnable, which is the acceptance criterion
    // the whole story is named for.
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    const offered = page.getByRole('button', { name: /^scratch-repo/ }).first();
    await expect(offered).toBeVisible();
    await expect(offered).not.toContainText('unmapped');
  } finally {
    await app.close();
  }
});

test('a cancelled dialog writes nothing', async ({}, testInfo) => {
  const { app, page, configPath } = await launchWithConfig(
    (name) => testInfo.outputPath(name),
    EMPTY_CONFIG,
  );

  try {
    await stubDirectoryDialog(app, []);
    await openSettings(page);

    await page.getByRole('button', { name: /add project/i }).click();

    // No write, no error, no row: the user closed a dialog they opened.
    await expect(
      page.getByText(/add a folder to start a session in it/i),
    ).toBeVisible();
    expect(readFileSync(configPath, 'utf8')).toBe(EMPTY_CONFIG);
  } finally {
    await app.close();
  }
});

test('removing a project leaves every other line of the file intact', async ({}, testInfo) => {
  const { app, page, configPath, repoDir } = await launchWithConfig(
    (name) => testInfo.outputPath(name),
    EMPTY_CONFIG,
  );

  try {
    await stubDirectoryDialog(app, [repoDir]);
    await openSettings(page);
    await page.getByRole('button', { name: /add project/i }).click();
    await expect(page.getByText('scratch-repo').first()).toBeVisible();

    // Remove moved into the row's overflow menu in story 103.
    await page.getByRole('button', { name: 'Actions for scratch-repo' }).click();
    await page.getByRole('menuitem', { name: /remove/i }).click();

    await expect(
      page.getByText(/add a folder to start a session in it/i),
    ).toBeVisible();

    const after = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(after.projects).toEqual([]);
    // The comment key outlived both a write and a delete.
    expect(after['//']).toBe('a comment the UI must not eat');
  } finally {
    await app.close();
  }
});

test('a directory that is not a repository is added anyway, and says so', async ({}, testInfo) => {
  const { app, page } = await launchWithConfig(
    (name) => testInfo.outputPath(name),
    EMPTY_CONFIG,
  );

  try {
    // A real directory with no `.git` in it.
    const plain = testInfo.outputPath('plain-directory');
    mkdirSync(plain, { recursive: true });
    await stubDirectoryDialog(app, [plain]);
    await openSettings(page);

    await page.getByRole('button', { name: /add project/i }).click();

    // A PTY needs a cwd, not a repo. Refusing would be the app inventing a
    // rule the shell does not have, so it reports rather than blocks.
    await expect(page.getByText('plain-directory').first()).toBeVisible();
    await expect(page.getByText('no git')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('creates a skill from Settings, beside the config', async ({}, testInfo) => {
  /**
   * The Skills pane, end to end (HIVE-96).
   *
   * The unit suite proves the pane against a mocked bridge, and
   * `tests/live/skills-conformance.test.ts` proves a real `claude` loads what
   * main generates. Neither says whether a click in this pane reaches main,
   * whether main builds the path from the validated name rather than from
   * anything the renderer sent, or whether the file lands where the next spawn
   * will read it. That gap is what this covers.
   *
   * The skills root is `dirname(configPath())/skills`, and the harness points
   * `HIVE_CONFIG_PATH` at this test's own output directory — so the file below
   * is written into the test's scratch space and never into the developer's
   * real `~/.hive`. That is the whole reason the root is derived from the
   * config path instead of `homedir()`.
   */
  const { app, page, configPath } = await launchWithConfig(
    (name) => testInfo.outputPath(name),
    EMPTY_CONFIG,
  );

  try {
    await openSettings(page);
    await page.getByRole('button', { name: 'Skills' }).click();

    // The screen a fresh install actually sees. Anchored on the invitation
    // rather than a bare "No skills yet." — the creature, the phrase and this
    // line already report the emptiness, so the label was the one of the four
    // that said nothing the others did not.
    await expect(
      page.getByText(/write one and every session you start will have it/i),
    ).toBeVisible();

    await page.getByRole('button', { name: '+ New skill' }).click();

    await page
      .getByLabel('Skill source')
      .fill(
        '---\nname: standup\ndescription: Summarise the day\n---\nSummarise it.\n',
      );
    await page.getByRole('button', { name: 'Save' }).click();

    // The row appears without a reload: the write returns the fresh snapshot.
    await expect(page.getByRole('button', { name: '/standup' })).toBeVisible();

    const written = readFileSync(
      join(dirname(configPath), 'skills', 'standup', 'SKILL.md'),
      'utf8',
    );
    expect(written).toContain('name: standup');
    expect(written).toContain('Summarise it.');
  } finally {
    await app.close();
  }
});

test('renames a skill by its frontmatter, leaving one folder', async ({}, testInfo) => {
  /**
   * The whole of HIVE-99, on a real disk.
   *
   * The unit suites prove each half — the pane asks and calls `renameSkill`,
   * main's runtime moves a folder — and neither can prove the thing the story
   * is actually about, which is a **count of directories** after a click in
   * the built app. The bug it replaces was invisible to every assertion of
   * that kind: the save succeeded, the row appeared, the new file was correct,
   * and a second skill quietly stayed behind serving the old command.
   *
   * So the load-bearing line here is the `readdirSync`. Everything above it is
   * setup.
   */
  const { app, page, configPath } = await launchWithConfig(
    (name) => testInfo.outputPath(name),
    EMPTY_CONFIG,
  );
  const skillsDir = join(dirname(configPath), 'skills');

  try {
    await openSettings(page);
    await page.getByRole('button', { name: 'Skills' }).click();
    await page.getByRole('button', { name: '+ New skill' }).click();
    await page
      .getByLabel('Skill source')
      .fill('---\nname: standup\ndescription: Summarise the day\n---\nOne.\n');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('button', { name: '/standup' })).toBeVisible();

    /*
      Rename it the only way the pane offers: edit the name in the frontmatter.
      The body changes in the same edit, because that is the realistic case and
      because the move and the write are two verbs — a rename that dropped the
      edit would leave the folder right and the file stale.
    */
    await page
      .getByLabel('Skill source')
      .fill('---\nname: stand-up\ndescription: Summarise the day\n---\nTwo.\n');
    await page.getByRole('button', { name: 'Save' }).click();

    // It asks before moving a file the user did not ask to delete.
    await expect(
      page.getByRole('alertdialog', { name: 'Rename /standup to /stand-up?' }),
    ).toBeVisible();
    expect(readdirSync(skillsDir).sort()).toEqual(['standup']);

    await page.getByRole('button', { name: 'Rename' }).click();

    await expect(page.getByRole('button', { name: '/stand-up' })).toBeVisible();
    await expect(page.getByRole('button', { name: '/standup' })).toHaveCount(0);

    // The line this test exists for: one folder, and it is the new one.
    expect(readdirSync(skillsDir).sort()).toEqual(['stand-up']);

    // And the edit that caused the rename is in it — the move carried the
    // folder, the write that followed carried the body.
    const moved = readFileSync(join(skillsDir, 'stand-up', 'SKILL.md'), 'utf8');
    expect(moved).toContain('name: stand-up');
    expect(moved).toContain('Two.');
  } finally {
    await app.close();
  }
});
