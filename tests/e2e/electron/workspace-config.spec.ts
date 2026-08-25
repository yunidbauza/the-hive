import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * The workspace config, driven through the real app (story 090).
 *
 * Its own file rather than an addition to `launch.spec.ts` because every case
 * here needs a **different config file written before launch**, which the
 * shared `hive` fixture cannot express — it launches once, with an empty
 * profile, by design.
 *
 * This is the only place the story's UI claims are actually proven. A green
 * unit test shows the badge renders when a fake snapshot is injected; it says
 * nothing about whether main reads the file, resolves the path, survives a
 * malformed one, and gets the verdict across the bridge.
 */

/** Launch with a specific config file already on disk. */
async function launchWithConfig(
  outputPath: (name: string) => string,
  contents: string | null,
) {
  const configPath = outputPath('hive-config.json');
  if (contents !== null) writeFileSync(configPath, contents);

  const app = await launchHive({
    userDataDir: outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');
  return { app, page, configPath };
}

/**
 * "Unmapped" means *declared but unresolvable*, not *absent from the config*.
 *
 * This test used to declare one project and assert that a second — one of five
 * seeded into the store — still appeared in the rail marked `unmapped`. That
 * only worked because the rail merged seeded projects into the config's list.
 * With the config as the sole source, a project it never declares is not in the
 * rail to be marked anything, so both are declared here and one is pointed at a
 * path that does not exist.
 */
test('a valid mapping makes its project spawnable and an unresolvable one unmapped', async ({}, testInfo) => {
  // A real directory that certainly exists: the repo this suite is running in.
  const realDirectory = join(import.meta.dirname, '../../..');
  const { app, page } = await launchWithConfig(
    (name) => testInfo.outputPath(name),
    JSON.stringify({
      version: 1,
      /*
        `name` is declared, not left to the fallback (HIVE-104). The rail draws
        the display name now, and `resolve.ts` fills a missing one from the
        mapped directory's *basename* — so omitting it here would label the row
        after whatever folder this checkout happens to live in. This spec is
        about mapping, not naming; pinning the name keeps it that way.
      */
      projects: [
        { id: 'apfm-web', name: 'apfm-web', path: realDirectory },
        {
          id: 'referral-api',
          name: 'referral-api',
          path: '/nowhere/that/exists',
        },
      ],
    }),
  );

  try {
    // The left rail's projects panel is the default tab.
    const mapped = page.getByRole('button', { name: /^apfm-web/ });
    await expect(mapped).toBeVisible();
    await expect(mapped).not.toContainText('unmapped');

    // Declared, but its path is not there — so the rail says so.
    await expect(
      page.getByRole('button', { name: /^referral-api/ }),
    ).toContainText('unmapped');

    // And the picker refuses the ones it cannot open. `exact` matters: a
    // pinned pill's accessible name is the bare id, while the search row below
    // it also carries a count ("apfm-web 3 active").
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'apfm-web', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole('button', { name: 'referral-api', exact: true }),
    ).toBeDisabled();
  } finally {
    await app.close();
  }
});

test('an invalid entry surfaces its reason without blocking launch', async ({}, testInfo) => {
  const { app, page } = await launchWithConfig(
    (name) => testInfo.outputPath(name),
    JSON.stringify({
      version: 1,
      projects: [{ id: 'apfm-web', path: '/definitely/not/here' }],
    }),
  );

  try {
    // The app launched — that is half the assertion, and the half that matters
    // most: one mistyped path must never stop the app starting.
    await expect(page.locator('header')).toContainText('The Hive');

    const row = page.getByRole('button', { name: /^apfm-web/ });
    await expect(row).toContainText('unmapped');
    // The status reason travels all the way to the tooltip, verbatim.
    await expect(row.getByTitle(/missing/)).toBeVisible();
  } finally {
    await app.close();
  }
});

test('a malformed file still launches the app, with nothing spawnable', async ({}, testInfo) => {
  const { app, page } = await launchWithConfig(
    (name) => testInfo.outputPath(name),
    '{ this is not json at all',
  );

  try {
    await expect(page.locator('header')).toContainText('The Hive');

    /**
     * An unreadable config declares nothing, so the rail lists nothing — and
     * says why rather than sitting blank.
     *
     * It used to assert `apfm-web` was present and marked `unmapped`, because
     * five projects were seeded into the store and the rail merged them in
     * whatever the config said. That merge is what made a broken config look
     * like a working app with five repositories in it.
     */
    await expect(page.getByText(/No projects mapped/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /^apfm-web/ })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('a first run writes a template and offers a way to add a project', async ({}, testInfo) => {
  // `contents: null` — no file at all, which is the normal state on a fresh
  // machine and must not be an error.
  const { app, page, configPath } = await launchWithConfig(
    (name) => testInfo.outputPath(name),
    null,
  );

  try {
    expect(existsSync(configPath)).toBe(true);

    // The template is a valid document, not a stub the next read chokes on.
    const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
      version: number;
      projects: unknown[];
    };
    // Story 101 took CONFIG_VERSION to 2, and the template emits whatever this
    // build writes. A v1 file the user already has still loads unchanged.
    expect(written.version).toBe(2);
    expect(written.projects).toEqual([]);

    await page.getByRole('button', { name: 'New session', exact: true }).click();

    /**
     * Story 090 printed `configPath` here and story 101 replaced it with a
     * button, deliberately: naming a file the user has never opened is not an
     * instruction, and that dead end is the whole reason story 101 exists.
     *
     * The path is still discoverable — it is the last line of the settings
     * Projects section — but it is no longer the *only* thing the app offers a
     * user who cannot start a session.
     */
    await expect(page.getByText(/no projects yet/)).toBeVisible();
    await expect(page.getByRole('button', { name: /add project/i })).toBeVisible();
    await expect(page.getByText(configPath, { exact: false })).not.toBeVisible();
  } finally {
    await app.close();
  }
});

test('HIVE_CONFIG_PATH wins over ~/.hive/config.json', async ({}, testInfo) => {
  // Prove the override by pointing at a directory the developer's real config
  // could not name: a scratch path created for this test only.
  const scratch = testInfo.outputPath('scratch-repo');
  mkdirSync(scratch, { recursive: true });

  const { app, page } = await launchWithConfig(
    (name) => testInfo.outputPath(name),
    // `name` declared for the reason the mapping spec above gives: without it
    // the rail's label would be `basename(scratch)` rather than the id.
    JSON.stringify({
      version: 1,
      projects: [{ id: 'apfm-web', name: 'apfm-web', path: scratch }],
    }),
  );

  try {
    await expect(
      page.getByRole('button', { name: /^apfm-web/ }),
    ).not.toContainText('unmapped');
  } finally {
    await app.close();
  }
});
