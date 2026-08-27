import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { launchHive, writeProjectConfig } from './fixtures/hive-app';

/**
 * Starting a session from the projects tree, in the built app.
 *
 * ## Why this cannot be a web spec
 *
 * `useProjects()` reads the workspace config and only the config, and the
 * browser target has no config at all — so the PROJECTS tree is permanently
 * empty there and this control never renders. The desktop app is the only place
 * the surface exists.
 *
 * What the unit tests cannot reach, and this can: that the click runs through a
 * real main process, that the spawn it asks for is granted, and that a terminal
 * actually opens — plus the one regression the whole design is arranged around,
 * that the tree's link and the header's button stay two distinguishable
 * controls.
 */

/** A real directory that certainly exists: the repo this suite runs in. */
const REAL_DIRECTORY = join(import.meta.dirname, '../../..');

async function launch(outputPath: (name: string) => string) {
  const app = await launchHive({
    userDataDir: outputPath('user-data'),
    configPath: outputPath('hive-config.json'),
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');
  return { app, page };
}

test('the tree starts a session, and the link stays below the last one', async ({}, testInfo) => {
  writeProjectConfig(testInfo.outputPath('hive-config.json'), {
    id: 'nova-web',
    path: REAL_DIRECTORY,
  });

  const { app, page } = await launch((name) => testInfo.outputPath(name));

  try {
    const tree = page.locator('[data-panel="projects"]');
    const rows = tree.locator('> div > *');
    const link = page.getByRole('button', { name: 'New session in nova-web' });

    // Nothing is running, so the link sits directly under the folder row.
    await expect(rows).toHaveCount(2);
    await expect(rows.last()).toHaveAccessibleName('New session in nova-web');

    /**
     * The regression this whole arrangement is guarding.
     *
     * `fixtures/hive-app.ts`'s `startSession` clicks the header button by
     * accessible name to open the picker. Playwright matches names as a
     * case-insensitive **substring**, so `New session` alone now finds the
     * header button and every tree link — hence `exact` there and here. Pinned
     * as an assertion rather than left implicit: if a later change renames the
     * header button, this fails loudly instead of silently clicking a link.
     */
    await expect(
      page.getByRole('button', { name: 'New session', exact: true }),
    ).toHaveCount(1);
    // Scoped to the tree rather than counted page-wide: the claim is "the link
    // is one of the loose matches", and a page-global count would also fail
    // for a second project in this config, or any future control whose name
    // happens to contain the words.
    await expect(tree.getByRole('button', { name: 'New session' })).toHaveCount(
      1,
    );

    const rail = page.getByRole('navigation', {
      name: 'Projects, work, and agents',
    });
    await rail.screenshot({
      path: 'test-results/evidence/projects-new-session-empty.png',
    });

    await link.click();

    // A real terminal, from a real spawn — no picker in between.
    const terminal = page.locator('[data-terminal-id^="sess-"]').last();
    await expect(terminal).toBeVisible();

    // And the tree grew a session row *above* the link, which stays last.
    await expect(rows).toHaveCount(3);
    await expect(rows.last()).toHaveAccessibleName('New session in nova-web');

    await rail.screenshot({
      path: 'test-results/evidence/projects-new-session-running.png',
    });
  } finally {
    await app.close();
  }
});

/**
 * The rail draws the display name, in the built app (HIVE-104).
 *
 * The bug this pins was a *field* mistake, not a propagation one: the row
 * rendered `project.id`, which a rename deliberately never touches, so the old
 * label survived every reload. Worth an electron spec rather than leaving it to
 * jsdom because the claim is about what the shipped renderer paints out of a
 * config file main actually read — and because the fixture that made this
 * unprovable (`name` pinned to `id`) lived here.
 *
 * A restart is not simulated; the spec *is* the restart. The app boots against
 * a config whose two fields disagree, which is the state a renamed project is
 * left in on disk.
 */
test('the tree labels a project with its name, not its id', async ({}, testInfo) => {
  writeProjectConfig(testInfo.outputPath('hive-config.json'), {
    id: 'nova-web',
    name: 'NOVA Web',
    path: REAL_DIRECTORY,
  });

  const { app, page } = await launch((name) => testInfo.outputPath(name));

  try {
    const tree = page.locator('[data-panel="projects"]');

    await expect(tree.getByText('NOVA Web')).toBeVisible();
    // Both halves: a row printing name *and* id would pass the first alone.
    await expect(tree.getByText('nova-web', { exact: true })).toHaveCount(0);
    // The start link speaks the same name the row shows.
    await expect(
      tree.getByRole('button', { name: 'New session in NOVA Web' }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test('a project whose path does not resolve offers a refusal, not a start', async ({}, testInfo) => {
  writeFileSync(
    testInfo.outputPath('hive-config.json'),
    JSON.stringify({
      version: 2,
      shell: '/bin/sh',
      claudeCommand: 'true; false',
      projects: [
        { id: 'nova-web', name: 'nova-web', path: REAL_DIRECTORY, icon: 'ph-cube' },
        {
          id: 'referral-api',
          name: 'referral-api',
          path: '/nowhere/that/exists',
          icon: 'ph-cube',
        },
      ],
    }),
  );

  const { app, page } = await launch((name) => testInfo.outputPath(name));

  try {
    // The link is rendered rather than hidden: the affordance stays where the
    // user expects it and explains itself instead of vanishing.
    const refused = page.getByRole('button', {
      name: 'New session in referral-api',
    });
    await expect(refused).toBeVisible();
    await expect(refused).toBeDisabled();
    await expect(refused).toHaveAttribute('title', /nowhere\/that\/exists|missing/);

    await expect(
      page.getByRole('button', { name: 'New session in nova-web' }),
    ).toBeEnabled();
  } finally {
    await app.close();
  }
});

/**
 * The hierarchy pass, in the shipped renderer (the rail half).
 *
 * The claim is about *painted colour*, which no unit test can make: jsdom
 * resolves no custom properties, so `text-brand` there is a class name and
 * nothing more. What has to hold is that a project and the sessions under it
 * end up different colours, and that this survives a theme change — because
 * the whole reason the rule uses `brand` rather than a literal is that every
 * theme already carries one.
 *
 * Two themes, through the real controls, rather than by writing `data-theme`
 * from the page: a theme the user cannot actually select proves nothing.
 */
test('paints a project apart from its sessions, in every theme', async ({}, testInfo) => {
  writeProjectConfig(testInfo.outputPath('hive-config.json'), {
    id: 'nova-web',
    name: 'NOVA Web',
    path: REAL_DIRECTORY,
  });

  const { app, page } = await launch((name) => testInfo.outputPath(name));

  try {
    const tree = page.locator('[data-panel="projects"]');
    const rail = page.getByRole('navigation', {
      name: 'Projects, work, and agents',
    });

    // A session to be different *from*. The link spawns one straight away.
    await page.getByRole('button', { name: 'New session in NOVA Web' }).click();
    await expect(page.locator('[data-terminal-id^="sess-"]').last()).toBeVisible();

    const projectName = tree.getByText('NOVA Web');
    const sessionName = tree.locator('[aria-current="true"] span').first();

    const colourOf = (locator: typeof projectName): Promise<string> =>
      locator.evaluate((node) => getComputedStyle(node).color);

    const darkProject = await colourOf(projectName);
    const darkSession = await colourOf(sessionName);

    expect(darkProject).not.toBe(darkSession);
    await rail.screenshot({
      path: 'test-results/evidence/projects-hierarchy-hive-dark.png',
    });

    // A different theme, with a brand in a different hue entirely.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Appearance' })
      .click();
    await page.getByRole('button', { name: 'Cinder Built in' }).click();
    await page.getByRole('button', { name: 'Close settings' }).click();

    const cinderProject = await colourOf(projectName);

    // The project moved with the theme — so it is reading a token, not a hex.
    expect(cinderProject).not.toBe(darkProject);
    // And it is still not the colour of the session beneath it.
    expect(cinderProject).not.toBe(await colourOf(sessionName));

    await rail.screenshot({
      path: 'test-results/evidence/projects-hierarchy-cinder.png',
    });
  } finally {
    await app.close();
  }
});
