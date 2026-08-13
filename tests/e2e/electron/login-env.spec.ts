import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * The login-shell environment import, driven through the real app (HIVE-84).
 *
 * This is the one spec that can reproduce the reported defect at all. The unit
 * suite proves the probe against disposable shells and the pane against a
 * stubbed status; neither can say whether a *packaged* main process actually
 * repairs its own `process.env` at boot, in time for the `gh` search, and
 * whether the answer survives the IPC round trip to the pane.
 *
 * ## How the defect is reproduced
 *
 * `PATH` is overridden at launch to exactly what a Finder-launched macOS app
 * inherits from launchd — `/usr/bin:/bin:/usr/sbin:/sbin`, the four entries the
 * bug report screenshot showed. Playwright normally launches with the runner's
 * full environment, which is the *terminal's*, so without this override the
 * bug is invisible to the suite: the app would already have a good `PATH` and
 * the import would correctly have nothing to do.
 *
 * ## Why the shell is a script this file writes
 *
 * The import runs the **configured** shell, so pointing the config at a stub
 * makes the whole chain deterministic on any machine. Asserting against the
 * runner's real login shell would mean asserting on whatever CI happens to
 * have in `.zshrc` — a test that passes on the author's laptop for reasons no
 * CI box shares.
 */

const DELIMITER = '__hive_login_env_boundary__';

/** A directory name distinctive enough that finding it proves the import ran. */
const IMPORTED_DIR = '/opt/hive-fixture/bin';

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

/**
 * A stand-in login shell that answers the probe and nothing else.
 *
 * It prints a banner first, deliberately: a real rc file does, and the parser
 * has to survive it here and not only in the unit test.
 */
function writeStubShell(path: string): string {
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      "echo 'nvm: Now using node v22.14.0'",
      `echo '${DELIMITER}'`,
      `echo "PATH=${IMPORTED_DIR}:/usr/bin:/bin"`,
      'echo "GH_TOKEN=a-value-that-must-never-be-rendered"',
      `echo '${DELIMITER}'`,
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(path, 0o755);
  return path;
}

function seed(
  outputPath: (name: string) => string,
  over: Record<string, unknown> = {},
): string {
  const repoDir = outputPath('scratch-repo');
  mkdirSync(join(repoDir, '.git'), { recursive: true });

  const configPath = outputPath('hive-config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        version: 2,
        shell: writeStubShell(outputPath('stub-login-shell')),
        claudeCommand: 'true; false',
        projects: [
          { id: 'scratch-repo', name: 'scratch-repo', path: repoDir, icon: 'ph-folder' },
        ],
        ...over,
      },
      null,
      2,
    ),
  );
  return configPath;
}

/** Exactly what launchd hands a Finder-launched app. The bug, reproduced. */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

test('adopts the login shell PATH when launched with launchd’s', async ({}, testInfo) => {
  const configPath = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
    env: { PATH: LAUNCHD_PATH },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openIntegrations(page);
  await expect(page.getByText('Checking…').first()).toBeHidden({ timeout: 15_000 });

  // The headline claim: the pane says the PATH came from the shell, naming it.
  await expect(page.getByText(/Imported from your login shell/)).toBeVisible();

  /**
   * The counts, which are the part a user reads to know it worked.
   *
   * Five, from a stub `PATH` of three and an inherited one of four: the union
   * keeps `/usr/sbin` and `/sbin`, which the shell did not mention, and
   * de-duplicates `/usr/bin` and `/bin`, which both had. That is the merge
   * behaving as specified — nothing launchd supplied is lost, and the `PATH`
   * does not grow by a duplicate on every launch.
   */
  await expect(page.getByText(/5 entries · the inherited PATH had 4/)).toBeVisible();

  await app.close();
});

test('names an imported token but never renders its value', async ({}, testInfo) => {
  const configPath = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
    // `GH_TOKEN` deliberately absent from the launch environment, so the stub
    // shell's value is the one that gets imported.
    env: { PATH: LAUNCHD_PATH },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openIntegrations(page);
  await expect(page.getByText('Checking…').first()).toBeHidden({ timeout: 15_000 });

  await expect(page.getByText('GH_TOKEN')).toBeVisible();

  // The security property, asserted against the whole rendered pane rather
  // than one element: a credential must not reach the renderer at all.
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('a-value-that-must-never-be-rendered');

  await app.close();
});

test('honours importLoginEnv: false, and says the PATH is the inherited one', async ({}, testInfo) => {
  const configPath = seed((name) => testInfo.outputPath(name), {
    importLoginEnv: false,
  });
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
    env: { PATH: LAUNCHD_PATH },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openIntegrations(page);
  await expect(page.getByText('Checking…').first()).toBeHidden({ timeout: 15_000 });

  await expect(
    page.getByText(/Inherited from whatever launched this app/),
  ).toBeVisible();
  await expect(page.getByText(/4 entries/)).toBeVisible();
  // The one thing that must NOT have happened.
  await expect(page.getByText(/Imported from your login shell/)).toBeHidden();

  await app.close();
});

test('reports a broken login shell without breaking the pane', async ({}, testInfo) => {
  const shellPath = testInfo.outputPath('angry-shell');
  writeFileSync(shellPath, '#!/bin/sh\necho "broken rc" >&2\nexit 3\n', 'utf8');
  chmodSync(shellPath, 0o755);

  const configPath = seed((name) => testInfo.outputPath(name), {
    shell: shellPath,
  });
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
    env: { PATH: LAUNCHD_PATH },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openIntegrations(page);
  await expect(page.getByText('Checking…').first()).toBeHidden({ timeout: 15_000 });

  // A failed probe is a failed observation: the app still runs, the pane still
  // renders, and it says what happened rather than showing a broken section.
  await expect(page.getByText(/Your login shell could not be read/)).toBeVisible();
  await expect(page.getByText(/exited with status 3/)).toBeVisible();

  await app.close();
});

/**
 * The toggle, end to end.
 *
 * Separate from the unit test for the reason every other config spec in this
 * suite is: only a real launch can prove a click reaches main, main's write
 * produces a file the reader accepts, and the write is partial.
 */
test('the Runtime switch writes the key without disturbing the file', async ({}, testInfo) => {
  const configPath = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
    env: { PATH: LAUNCHD_PATH },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Runtime' })
    .click();

  const toggle = page.getByRole('switch', { name: /Import my login shell/ });
  await expect(toggle).toBeChecked();
  await toggle.click();

  const { readFileSync } = await import('node:fs');
  await expect
    .poll(
      () =>
        (JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>)
          .importLoginEnv,
      { timeout: 10_000 },
    )
    .toBe(false);

  // Nothing else was restated by the write.
  const written = JSON.parse(readFileSync(configPath, 'utf8')) as Record<
    string,
    unknown
  >;
  expect((written.projects as unknown[]).length).toBe(1);
  expect(written.claudeCommand).toBe('true; false');

  await app.close();
});
