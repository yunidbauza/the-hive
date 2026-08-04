import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * Cloning a repository, driven through the real app (story 102).
 *
 * This is the only proof the slice works end to end. The unit suite covers each
 * piece against fakes — a validated URL, a spawn payload, a stubbed bridge — and
 * none of that says whether the renderer's click reaches main, whether main
 * really spawns `git` in a PTY, whether the clone lands on disk, or whether the
 * resulting entry is one the config reader accepts.
 *
 * **No network.** A bare repository in a temp directory is a real remote as far
 * as `git` is concerned, so CI clones at local-disk speed and never depends on
 * a forge being up.
 */

/** A bare repo on disk — a real remote, with no network involved. */
function makeBareRemote(): string {
  const root = mkdtempSync(join(tmpdir(), 'hive-remote-'));
  const source = join(root, 'src');
  const identity = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Hive',
    GIT_AUTHOR_EMAIL: 'hive@example.com',
    GIT_COMMITTER_NAME: 'Hive',
    GIT_COMMITTER_EMAIL: 'hive@example.com',
  };

  execFileSync('git', ['init', '-q', source]);
  execFileSync(
    'git',
    ['-C', source, 'commit', '-q', '--allow-empty', '-m', 'init'],
    { env: identity },
  );

  const bare = join(root, 'demo-repo.git');
  execFileSync('git', ['clone', '-q', '--bare', source, bare], {
    env: identity,
  });
  return bare;
}

/**
 * Replace the native sheet with one that answers immediately.
 *
 * Copied from `settings.spec.ts`, which owns the original — one spec file
 * importing another would couple them. Stubbed **in main**, not bypassed: the
 * renderer still calls `chooseDirectory` and still echoes the path back, so the
 * round trip under test is the real one.
 */
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

const EMPTY_CONFIG = JSON.stringify({ version: 2, projects: [] }, null, 2);

/** Launch against an empty config, and land on the clone form. */
async function launchOnCloneForm(
  outputPath: (name: string) => string,
): Promise<{ app: ElectronApplication; page: Page; configPath: string }> {
  const configPath = outputPath('hive-config.json');
  writeFileSync(configPath, EMPTY_CONFIG);

  const app = await launchHive({
    userDataDir: outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: /clone from url/i }).click();

  return { app, page, configPath };
}

test('clones a repository and registers it as a project', async ({}, testInfo) => {
  const { app, page, configPath } = await launchOnCloneForm((name) =>
    testInfo.outputPath(name),
  );

  try {
    const remote = makeBareRemote();
    const parent = mkdtempSync(join(tmpdir(), 'hive-parent-'));
    /**
     * macOS symlinks `/var` to `/private/var`, and main `realpath`s every path
     * it accepts — so what lands in the config and on the row is the resolved
     * form, not the one the dialog handed back. Asserting against `parent`
     * would fail for a reason that has nothing to do with cloning.
     */
    const resolved = join(realpathSync(parent), 'demo-repo');

    await page.getByLabel(/repository url/i).fill(remote);
    await stubDirectoryDialog(app, [parent]);
    await page.getByRole('button', { name: /choose/i }).click();

    // Named before it exists — the whole point of deriving the folder in main.
    await expect(page.getByText(join(parent, 'demo-repo'))).toBeVisible();

    await page.getByRole('button', { name: 'Clone' }).click();

    /**
     * Success returns to the list. Waiting for the list's own button rather
     * than the repo name, because the name is on screen during the clone too —
     * the heading reads "Cloning demo-repo".
     */
    await expect(
      page.getByRole('button', { name: /add project/i }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(resolved)).toBeVisible();

    expect(existsSync(join(resolved, '.git'))).toBe(true);

    const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
      projects: { id: string; origin: string; path: string }[];
    };
    const entry = written.projects.find((project) => project.id === 'demo-repo');
    expect(entry).toBeDefined();
    expect(entry?.origin).toBe('cloned');
    expect(entry?.path).toBe(resolved);
  } finally {
    await app.close();
  }
});

test('a failed clone leaves no directory behind', async ({}, testInfo) => {
  const { app, page } = await launchOnCloneForm((name) =>
    testInfo.outputPath(name),
  );

  try {
    const parent = mkdtempSync(join(tmpdir(), 'hive-parent-'));
    const missing = join(tmpdir(), 'definitely-not-a-repo.git');

    await page.getByLabel(/repository url/i).fill(missing);
    await stubDirectoryDialog(app, [parent]);
    await page.getByRole('button', { name: /choose/i }).click();
    await page.getByRole('button', { name: 'Clone' }).click();

    await expect(page.getByText(/git exited with code/i)).toBeVisible({
      timeout: 30_000,
    });

    // The epic's rule, proven against a real filesystem.
    expect(existsSync(join(parent, 'definitely-not-a-repo'))).toBe(false);
  } finally {
    await app.close();
  }
});

test('refuses a URL that git would read as a flag', async ({}, testInfo) => {
  const { app, page } = await launchOnCloneForm((name) =>
    testInfo.outputPath(name),
  );

  try {
    const parent = mkdtempSync(join(tmpdir(), 'hive-parent-'));

    await page.getByLabel(/repository url/i).fill('--upload-pack=touch /tmp/pwned');
    await stubDirectoryDialog(app, [parent]);
    await page.getByRole('button', { name: /choose/i }).click();
    await page.getByRole('button', { name: 'Clone' }).click();

    await expect(page.getByText(/cannot start with/i)).toBeVisible();
    // Still on the form: a refusal is something to fix, not a failed clone.
    await expect(page.getByLabel(/repository url/i)).toBeVisible();
  } finally {
    await app.close();
  }
});
