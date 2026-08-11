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

import { dockBadge, launchHive } from './fixtures/hive-app';

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

/**
 * What a raised notification does *outside* the window.
 *
 * A clone is the one producer this suite can drive end to end, and it is a
 * `both` kind — so finishing one exercises the whole delivery path in the real
 * app: the hub raises, the dock badge is pushed, and `present()` hands the OS a
 * notification whose refusal, if there is one, must reach the settings pane
 * rather than being swallowed.
 *
 * The refusal itself is **platform-dependent and asserted as such**. On the Mac
 * this was written on, `Notification.isSupported()` answers `true` and every
 * `show()` then fails with `UNErrorDomain error 1`; on a machine where delivery
 * works it stays `null`. What is invariant — and what used to be missing
 * entirely — is that the app now has an answer either way, and that the badge
 * counts regardless.
 */
test('badges the dock and reports how the OS answered', async ({}, testInfo) => {
  const { app, page } = await launchOnCloneForm((name) =>
    testInfo.outputPath(name),
  );

  try {
    /**
     * Nothing has happened yet, so nothing is claimed.
     *
     * Coalesced rather than matched against a `/undefined/` pattern: off macOS
     * `dockBadge` resolves the real `undefined`, and `expect(undefined)
     * .toMatch()` fails outright with "received value must be a string" — it
     * never stringifies the value, so the pattern could not match however it
     * was written. That would have errored this spec on its first assertion on
     * Linux and Windows instead of skipping the dock checks below, which is the
     * intent.
     */
    expect((await dockBadge(app)) ?? '').toBe('');

    const remote = makeBareRemote();
    const parent = mkdtempSync(join(tmpdir(), 'hive-parent-'));

    await page.getByLabel(/repository url/i).fill(remote);
    await stubDirectoryDialog(app, [parent]);
    await page.getByRole('button', { name: /choose/i }).click();
    await page.getByRole('button', { name: 'Clone' }).click();

    await expect(
      page.getByRole('button', { name: /add project/i }),
    ).toBeVisible({ timeout: 30_000 });

    /**
     * One unread row, and the dock says so. Polled because the badge is pushed
     * from main after the clone's own event, not before the button appears.
     *
     * Skipped where there is no dock at all rather than asserted loosely — a
     * spec that passes on Linux because `undefined` is falsy is a spec that
     * would go on passing after the badge stopped being set on macOS.
     */
    const badge = await dockBadge(app);
    if (badge !== undefined) {
      await expect.poll(() => dockBadge(app), { timeout: 10_000 }).toBe('1');
    }

    /**
     * Asked through `notifications.delivery()`, which is the verb the pane
     * itself polls — so this exercises the real path rather than a second one
     * that happens to carry the same two facts.
     */
    const status = await page.evaluate(() =>
      (
        window as unknown as {
          hive: {
            notifications: {
              delivery: () => Promise<{
                supported: boolean;
                refused: string | null;
              }>;
            };
          };
        }
      ).hive.notifications.delivery(),
    );

    /**
     * Printed, because the answer differs by machine and the run is the only
     * record of which branch below was taken. A green tick alone cannot say
     * whether this platform delivered the notification or refused it.
     */
    console.info(
      `[hive-e2e] desktop notifications: supported=${status.supported} refused=${String(status.refused)} badge=${String(badge)}`,
    );

    // The field exists and carries a real answer — the thing that was silence.
    expect(status).toHaveProperty('refused');
    expect(
      status.refused === null || typeof status.refused === 'string',
    ).toBe(true);

    /**
     * And when it *is* a refusal, the pane says so rather than going on
     * offering a delivery that has never been delivered.
     */
    if (status.refused !== null) {
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByRole('button', { name: 'Notifications' })
        .click();
      await expect(page.getByText(/refused this app/i)).toBeVisible();
    }
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

    /**
     * **Pre-existing red, corrected here rather than left failing.**
     *
     * Unrelated to HIVE-78. HIVE-75 gave clone failures a notification, so the
     * message now appears twice — once in the clone view and once in the inbox
     * row — and an unscoped `getByText` is a strict-mode violation against two
     * correct elements. `.first()` says "the clone view told the user", which is
     * what this test has always meant; the inbox copy has its own coverage.
     */
    await expect(page.getByText(/git exited with code/i).first()).toBeVisible({
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
