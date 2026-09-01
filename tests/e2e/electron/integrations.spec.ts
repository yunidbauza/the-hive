import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * Integrations & notifications, driven through the real app (story 106).
 *
 * The unit suite proves the pieces against fakes — a guard rejects a payload, an
 * injected runner returns canned `gh` output, a stubbed snapshot renders a
 * switch. What none of it can say is whether a click in the renderer reaches
 * main, whether main's write produces a file the reader accepts, or whether the
 * pane survives a machine where `gh` is genuinely absent. That is this file.
 *
 * `HIVE_CONFIG_PATH` points at a scratch file, so nothing here touches the
 * developer's own `~/.hive/config.json`.
 */

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

/** A config with one real project, and a comment the UI must not eat. */
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

const read = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

test('reports a gh state without throwing, installed or not', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openIntegrations(page);

  /**
   * Whether this runner has `gh` is not something to assert — both are valid
   * answers and CI machines differ. What must hold on every machine is that the
   * pane reaches a *verdict* rather than sitting on its probing line or
   * crashing,
   * which is what would happen if executing a subprocess from main went wrong.
   */
  await expect(page.locator('[data-probing]').first()).toBeHidden({
    timeout: 15_000,
  });

  // And whichever way it went, the token-source group states the promise.
  await expect(page.getByText(/does not store a token/i)).toBeVisible();

  await app.close();
});

/**
 * The hierarchy pass, in the shipped renderer (the settings half).
 *
 * The pane was six equal groups with nothing saying three were GitHub's and
 * three were Jira's. Three claims here that the unit suite cannot make: the
 * bands are real landmarks a screen reader can jump between, their eyebrows are
 * painted in the theme's brand rather than in body ink, and the groups inside
 * them draw no rules — the complaint the bands answer was too many lines, so a
 * band that kept them would have fixed nothing.
 *
 * A third band, Slack's, joined GitHub's and Jira's in HIVE-123 — the same
 * `SettingsProviderGroup` landmark, so the count below moved from two to three
 * rather than needing a different kind of assertion.
 */
test('groups the pane into three provider bands, and draws one line each', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openIntegrations(page);
  await expect(page.locator('[data-probing]').first()).toBeHidden({
    timeout: 15_000,
  });

  // The pane is the scrolling column the section header opens; every band and
  // group in this test lives inside it.
  const pane = page
    .getByRole('heading', { name: 'Integrations', level: 2 })
    .locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]');

  const github = page.getByRole('region', { name: 'GitHub' });
  const jira = page.getByRole('region', { name: 'Jira' });
  const slack = page.getByRole('region', { name: 'Slack' });

  await expect(github).toBeVisible();
  await expect(jira).toBeVisible();
  await expect(slack).toBeVisible();
  /*
    Three bands, and only three — scoped to the pane rather than counted
    page-wide. A page-global `getByRole('region')` would also fail for any
    landmark added anywhere else in the shell, reporting "the pane grew a
    fourth provider" for a change that had nothing to do with this pane.
  */
  await expect(pane.getByRole('region')).toHaveCount(3);

  // Each group sits under the provider that owns it, and says it once.
  await expect(github.getByRole('heading', { name: 'Token source' })).toBeVisible();
  await expect(github.getByRole('heading', { name: 'Command line' })).toBeVisible();
  await expect(jira.getByRole('heading', { name: 'Site' })).toBeVisible();
  await expect(slack.getByRole('heading', { name: 'Connection' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'PATH source' })).toHaveCount(0);

  /**
   * The eyebrow is brand, and the body text is not — asserted as painted
   * colour, which is the only form of the claim jsdom cannot resolve.
   */
  const eyebrow = github.getByRole('heading', { name: 'GitHub' });
  const groupTitle = github.getByRole('heading', { name: 'Token source' });
  const colourOf = (locator: typeof eyebrow): Promise<string> =>
    locator.evaluate((node) => getComputedStyle(node).color);

  expect(await colourOf(eyebrow)).not.toBe(await colourOf(groupTitle));

  // The band's own hairline is the only line in it.
  const rules = github.locator('section.border-b');
  await expect(rules).toHaveCount(0);

  /*
    The pane's own scroll container, reached from the band rather than from the
    title.

    This used to be `ancestor::div[1]` on the `h2`. `ancestor::` is a reverse
    axis, so position 1 is the *nearest* div — which is the section header's own
    two-line wrapper holding the title and its description, and nothing else.
    The evidence file was a screenshot of a heading, under a name promising the
    bands, and every assertion above it still passed.
  */
  await pane.screenshot({
    path: 'test-results/evidence/integrations-provider-bands.png',
  });

  await app.close();
});

/**
 * The notification preferences moved out of this pane in HIVE-75 and the specs
 * below did not follow them.
 *
 * They were written for story 106's three switches — `sessionDone`,
 * `sessionIdle`, `cloneDone`, each a boolean — living in Integrations. HIVE-75
 * replaced all of that: ten registered kinds, each a three-way delivery, in a
 * Notifications pane of their own. The specs went on asking Integrations for
 * switches that were no longer anywhere, and had been failing ever since.
 *
 * Rewritten rather than deleted, because what they were *for* is untouched by
 * any of that and is still only checkable here: a click in the renderer has to
 * reach main, main's write has to produce a file the reader accepts, and the
 * write has to be **partial** — a user's comments, unrelated keys and untouched
 * preferences all survive it. Fakes cannot answer any of those.
 */
const openNotifications = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Notifications' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Notifications', level: 2 }),
  ).toBeVisible();
};

/** Choose a delivery on the control for one kind, by its registry label. */
const choose = async (
  page: Page,
  label: RegExp,
  delivery: 'Off' | 'Inbox' | 'System',
): Promise<void> => {
  await page
    .getByRole('radiogroup', { name: label })
    .getByRole('radio', { name: delivery, exact: true })
    .click();
};

const prefs = (path: string): Record<string, unknown> =>
  (read(path).notifications ?? {}) as Record<string, unknown>;

test('a chosen delivery lands in the file, comments intact', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openNotifications(page);

  // The file starts with no block at all: reading applies the registry defaults
  // in memory and writes nothing.
  expect(read(configPath).notifications).toBeUndefined();

  await choose(page, /blocked on you/i, 'Off');

  await expect.poll(() => prefs(configPath)['session.blocked']).toBe('off');

  const written = read(configPath);
  expect(written['//']).toBe('a comment the UI must not eat');
  // Only the kind the user moved is written. Every other kind is defaulted in
  // memory, so a later change to the defaults still reaches this user.
  expect(written.notifications).toEqual({ 'session.blocked': 'off' });
  // And nothing else in the file was restated.
  expect(written.claudeCommand).toBe('claude');
  expect((written.projects as unknown[])?.length).toBe(1);

  await app.close();
});

test('a second choice does not restate the first', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openNotifications(page);

  await choose(page, /blocked on you/i, 'Inbox');
  await expect.poll(() => prefs(configPath)['session.blocked']).toBe('inbox');

  await choose(page, /clone finishes/i, 'Off');
  await expect.poll(() => prefs(configPath)['clone.done']).toBe('off');

  // `session.input_needed` was never touched, so it must still be absent —
  // the partial write is what keeps an untouched kind out of the user's file.
  expect(read(configPath).notifications).toEqual({
    'session.blocked': 'inbox',
    'clone.done': 'off',
  });

  await app.close();
});

/**
 * The waiting-on-you kind, driven end to end.
 *
 * Worth its own case rather than folding into the one above: it is the newest
 * entry in the registry, so a control that never reached the pane — a missing
 * glyph, a kind the section iterates past — would show up here and nowhere
 * else in this suite.
 */
test('offers the waiting-on-you kind, and saves it', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openNotifications(page);

  await choose(page, /runs out of instructions/i, 'Inbox');

  await expect
    .poll(() => prefs(configPath)['session.input_needed'])
    .toBe('inbox');

  await app.close();
});

/**
 * The yours-again kind (HIVE-89), driven end to end for the same reason: it is
 * the newest entry — and a revived name, so this is also what proves the pane
 * treats it as a live kind rather than the retired one it used to be. Every
 * delivery is exercised because the kind defaults to `both`, and `System` is
 * the one a defaulted control would already show.
 */
test('offers the yours-again kind, and saves every delivery', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openNotifications(page);

  const group = page.getByRole('radiogroup', { name: /becomes yours again/i });
  await expect(group).toBeVisible();
  await expect(group.getByRole('radio', { name: 'System', exact: true })).toBeChecked();

  await choose(page, /becomes yours again/i, 'Off');
  await expect.poll(() => prefs(configPath)['session.idle']).toBe('off');

  await choose(page, /becomes yours again/i, 'Inbox');
  await expect.poll(() => prefs(configPath)['session.idle']).toBe('inbox');

  await choose(page, /becomes yours again/i, 'System');
  await expect.poll(() => prefs(configPath)['session.idle']).toBe('both');

  await app.close();
});

test('a hand-written block survives a save made through the UI', async ({}, testInfo) => {
  const { configPath } = seed((name) => testInfo.outputPath(name));
  /**
   * The interesting conformance case: a block written by hand, holding both a
   * current key and one of the **legacy booleans** story 106 wrote.
   *
   * The legacy key is the point. `resolveNotificationPrefs` migrates it on read
   * and `parse.ts` tolerates it rather than reporting it, precisely so a config
   * written before HIVE-75 is not quietly reset — and the only way to know that
   * still holds through a real load and a real save is to do one.
   *
   * `sessionIdle` no longer migrates anywhere — HIVE-83 retired `session.idle`
   * outright, and HIVE-89's revival of that kind deliberately left the boolean
   * unpointed — so this also proves the narrower promise that survives it: a
   * key this build can no longer use still round-trips untouched rather than
   * being dropped.
   */
  const document = read(configPath);
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...document,
        notifications: { 'session.blocked': 'off', sessionIdle: true },
      },
      null,
      2,
    ),
  );

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('header');

  await openNotifications(page);

  // The hand-written value is what the control shows, not the registry default.
  await expect(
    page
      .getByRole('radiogroup', { name: /blocked on you/i })
      .getByRole('radio', { name: 'Off', exact: true }),
  ).toBeChecked();

  await choose(page, /clone finishes/i, 'Off');

  await expect.poll(() => prefs(configPath)['clone.done']).toBe('off');

  // Both prior keys survive: the mutation spreads the block rather than
  // rebuilding it, so neither the current key nor the legacy one is eaten.
  expect(read(configPath).notifications).toEqual({
    'session.blocked': 'off',
    sessionIdle: true,
    'clone.done': 'off',
  });

  await app.close();
});
