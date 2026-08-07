import { readFileSync, writeFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * The Jira settings pane, driven through the real app (HIVE-67).
 *
 * The unit suite proves the pieces against fakes — a guard rejects a payload, an
 * injected `safeStorage` reports each of the four credential states, a stubbed
 * status renders each one's copy. What none of it can say is whether typing in
 * the renderer reaches main, whether main's write produces a `jira` block the
 * reader accepts on the next load, or whether the pane survives a machine with
 * no credential at all. That is this file.
 *
 * **Two of the four states are covered here, not four**, and the split is
 * deliberate. `none` and `env` are reachable in a real app. `unavailable` needs
 * a machine whose `safeStorage` cannot encrypt, which macOS and Windows CI
 * runners are not, and `stored` would mean writing a token into the runner's
 * real keychain. Those two are proven in
 * `tests/features/settings/components/jira-credential-group.test.tsx`, where
 * the store is injected and the assertion is exact.
 *
 * ## Why every launch below names JIRA_API_KEY
 *
 * `launchHive` spreads `process.env`, so the app inherits the shell it was
 * started from — and whoever is working on a Jira integration is exactly the
 * person who has `JIRA_API_KEY` exported. Without {@link CLEAN}, the
 * "nothing is configured" tests pass on CI and fail on the machine of the
 * person writing the feature, which is the worst place for a suite to disagree
 * with itself. An empty value reads as unset by design (`auth.ts`), so this
 * clears the variable rather than merely overwriting it.
 */

/** A launch environment with no ambient Jira credential. */
const CLEAN = { JIRA_API_KEY: '' };

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

/** A config with no `jira` block, and a comment the UI must not eat. */
function seed(outputPath: (name: string) => string): string {
  const configPath = outputPath('hive-config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        '//': 'a comment the UI must not eat',
        version: 2,
        shell: '/bin/sh',
        claudeCommand: 'claude',
        projects: [],
      },
      null,
      2,
    ),
  );
  return configPath;
}

const read = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

test('renders both groups, and says no token is stored', async ({}, testInfo) => {
  const configPath = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
    env: CLEAN,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openIntegrations(page);

  await expect(page.getByRole('heading', { name: 'Jira site' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'API token' })).toBeVisible();

  // Nothing configured: empty fields, and a sentence rather than a blank card.
  await expect(page.getByLabel('Site')).toHaveValue('');
  await expect(page.getByLabel('Account email')).toHaveValue('');
  await expect(page.getByText(/No token stored/i)).toBeVisible();

  await app.close();
});

test('a typed site reaches the config file and survives a reopen', async ({}, testInfo) => {
  const configPath = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
    env: CLEAN,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openIntegrations(page);

  await page.getByLabel('Site').fill('behiques.atlassian.net');
  await page.getByLabel('Site').press('Enter');
  await page.getByLabel('Account email').fill('me@example.com');
  await page.getByLabel('Account email').press('Enter');

  // The round trip that matters: renderer → main → disk → reader → renderer.
  await expect
    .poll(() => read(configPath).jira, { timeout: 5_000 })
    .toEqual({ site: 'behiques.atlassian.net', email: 'me@example.com' });

  // Story 101's promise: a hand-written comment rides across every write.
  expect(read(configPath)['//']).toBe('a comment the UI must not eat');

  // Close the pane and reopen it: the values came back through the snapshot,
  // not out of component state that happened to survive.
  await page.keyboard.press('Escape');
  await openIntegrations(page);
  await expect(page.getByLabel('Site')).toHaveValue('behiques.atlassian.net');

  await app.close();
});

test('an emptied field clears the key rather than storing an empty string', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 2,
      projects: [],
      jira: { site: 'behiques.atlassian.net', email: 'me@example.com' },
    }),
  );

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
    env: CLEAN,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openIntegrations(page);
  await expect(page.getByLabel('Site')).toHaveValue('behiques.atlassian.net');

  await page.getByLabel('Site').fill('');
  await page.getByLabel('Site').press('Enter');

  // `""` would be a site named "" and a request to https:///rest/api/3/myself.
  await expect
    .poll(() => read(configPath).jira, { timeout: 5_000 })
    .toEqual({ email: 'me@example.com' });

  await app.close();
});

test('names JIRA_API_KEY when the app was launched with one', async ({}, testInfo) => {
  const configPath = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
    env: { JIRA_API_KEY: 'ATATT-not-a-real-token' },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openIntegrations(page);

  await expect(page.getByText('JIRA_API_KEY')).toBeVisible();
  await expect(
    page.getByText(/that is the token being used/i),
  ).toBeVisible();

  // The value is never rendered — only the fact that the variable is set.
  await expect(page.locator('body')).not.toContainText('ATATT-not-a-real-token');

  await app.close();
});

test('reports an unconfigured site instead of hanging on the test button', async ({}, testInfo) => {
  const configPath = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
    env: CLEAN,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openIntegrations(page);
  await page.getByRole('button', { name: 'Test connection' }).click();

  // A verb that answers rather than throwing: no site is a sentence, not a
  // rejected invoke and not a ten-second wait for a request never made.
  await expect(page.getByText(/No Jira site is configured/i)).toBeVisible({
    timeout: 5_000,
  });

  await app.close();
});
