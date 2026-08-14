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

/**
 * A single `PATH` entry whose text contains newlines (HIVE-86).
 *
 * Modelled on what `~/.zshrc` produces when a command substitution inside the
 * value fails — `export PATH="$PATH:$(npm bin -g)"` on npm 9+ — but **not a
 * verbatim copy of it**. npm's real message contains colons
 * (`Unknown command: "bin"`), which `PATH` would split into several junk
 * entries; the colon-bearing original is used in the unit fixture, where entry
 * counting is not what is being asserted. Here the colons are removed so this
 * stays exactly one entry and the pane's count is a fixed number. The property
 * under test — a newline inside a value — is unaffected by that edit.
 *
 * It is placed **before** {@link IMPORTED_DIR} on purpose: a parser that ended
 * a variable at the first newline would drop everything after it, so
 * `IMPORTED_DIR` would never arrive. That makes this the end-to-end guard for
 * the truncation defect, through the real main process rather than a unit.
 *
 * No double quotes either, since the stub interpolates it into a double-quoted
 * shell word.
 */
const NOISY_ENTRY =
  '/opt/hive-noisy/bin\nUnknown command - bin\n\nTo see a list of supported npm commands, run\n  npm help';

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
 *
 * The transcript is **NUL-delimited** (HIVE-86), matching
 * `LOGIN_ENV_PROBE_ARGS`. The `PATH` it reports deliberately carries an
 * embedded newline — the shape a real `~/.zshrc` produces when a command
 * substitution in the value fails — so this proves end-to-end, through the
 * real main process and the real Settings pane, that such a `PATH` arrives
 * whole rather than truncated at the newline.
 */
function writeStubShell(path: string): string {
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      "echo 'nvm: Now using node v22.14.0'",
      `printf '\\0%s\\0' '${DELIMITER}'`,
      `printf '%s\\0' "PATH=${NOISY_ENTRY}:${IMPORTED_DIR}:/usr/bin:/bin" \\`,
      '  "GH_TOKEN=a-value-that-must-never-be-rendered" \\',
      `  '${DELIMITER}'`,
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
  await expect(page.locator('[data-probing]').first()).toBeHidden({
    timeout: 15_000,
  });

  // The headline claim: the pane says the PATH came from the shell, naming it.
  await expect(page.getByText(/Imported from your login shell/)).toBeVisible();

  /**
   * The counts, which are the part a user reads to know it worked.
   *
   * Six, from a stub `PATH` of four and an inherited one of four: the union
   * keeps `/usr/sbin` and `/sbin`, which the shell did not mention, and
   * de-duplicates `/usr/bin` and `/bin`, which both had. That is the merge
   * behaving as specified — nothing launchd supplied is lost, and the `PATH`
   * does not grow by a duplicate on every launch.
   *
   * The stub's fourth entry is {@link NOISY_ENTRY}, which contains newlines and
   * still counts as exactly one entry. Under the pre-HIVE-86 parser it would
   * have been the *last* entry to survive, taking `IMPORTED_DIR` with it, and
   * this count would read 4.
   */
  await expect(page.getByText(/6 entries · the inherited PATH had 4/)).toBeVisible();

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
  await expect(page.locator('[data-probing]').first()).toBeHidden({
    timeout: 15_000,
  });

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
  await expect(page.locator('[data-probing]').first()).toBeHidden({
    timeout: 15_000,
  });

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
  await expect(page.locator('[data-probing]').first()).toBeHidden({
    timeout: 15_000,
  });

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
