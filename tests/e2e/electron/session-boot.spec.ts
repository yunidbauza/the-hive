import { join } from 'node:path';

import {
  test as base,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

import {
  launchHive,
  startSession,
  writeProjectConfig,
} from './fixtures/hive-app';

/**
 * The boot cover, in the packaged app (HIVE-101).
 *
 * ## What this can prove that a component test cannot
 *
 * That the cover is drawn **over a terminal that is still there**. The unit
 * tests assert the classes; only a real browser can show that the terminal
 * underneath kept its box — and that box is not cosmetic, because xterm sizes
 * the pty from a measured cell and cannot measure inside a zero-height element.
 * A cover implemented as a swap would pass every unit test in this feature and
 * resize the pty to nonsense.
 *
 * ## And why the *fallback* is what is tested here
 *
 * A session in this harness has no working `claude` to report itself up — no
 * credentials, and the binary exits immediately — so no ready signal ever
 * arrives. That is not a limitation of the test, it is the exact failure the
 * cover had to survive: a session whose Claude never starts has its explanation
 * sitting in the terminal underneath, and an overlay that waits forever hides
 * it. So this is the honest environment in which to prove the way out works.
 */
const test = base;

const PROJECT = 'apfm-web';
const REAL_DIRECTORY = join(import.meta.dirname, '../../..');

/**
 * A launched app that already has a project mapped.
 *
 * The shared `hive` fixture launches before a spec body runs, so a config
 * written in `beforeEach` arrives too late — `session-branch.spec.ts` takes the
 * same route for the same reason.
 */
async function withProject(
  outputPath: (name: string) => string,
): Promise<{ app: ElectronApplication; page: Page }> {
  const configPath = outputPath('hive-config.json');
  writeProjectConfig(configPath, { id: PROJECT, path: REAL_DIRECTORY });

  const app = await launchHive({
    userDataDir: outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');

  return { app, page };
}

test('a starting session is covered, and the terminal keeps its box underneath', async ({}, testInfo) => {
  const { app, page } = await withProject((name) => testInfo.outputPath(name));
  try {
  const id = await startSession(page, PROJECT);

  const cover = page.getByTestId('session-boot-cover');
  await expect(cover).toBeVisible();
  await expect(cover).toContainText('press any key to watch it boot');

  const terminal = page.locator(`[data-terminal-id="${id}"]`);
  const terminalBox = await terminal.boundingBox();
  const coverBox = await cover.boundingBox();

  expect(terminalBox).not.toBeNull();
  expect(coverBox).not.toBeNull();

  /*
    Laid out, not hidden. A terminal collapsed to nothing is the failure this
    exists for — xterm would measure a zero cell and size the pty from it.
  */
  expect(terminalBox!.height).toBeGreaterThan(50);
  expect(terminalBox!.width).toBeGreaterThan(50);

  // And the cover really is on top of it, rather than beside it.
  expect(coverBox!.y).toBeGreaterThanOrEqual(terminalBox!.y - 1);
  expect(coverBox!.height).toBeLessThanOrEqual(terminalBox!.height + 1);
  } finally {
    await app.close();
  }
});

test('the meta bar stays readable while a session starts', async ({}, testInfo) => {
  const { app, page } = await withProject((name) => testInfo.outputPath(name));
  try {
  /*
    The cover fills the terminal's box, not the stage. The branch and status
    above it are the only things on screen that say *which* session is starting,
    and they are worth reading while it does.
  */
  await startSession(page, PROJECT);

  await expect(page.getByTestId('session-boot-cover')).toBeVisible();
  await expect(page.getByTestId('session-meta-bar')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('any key lifts the cover, even though nothing ever reported itself ready', async ({}, testInfo) => {
  const { app, page } = await withProject((name) => testInfo.outputPath(name));
  try {
  await startSession(page, PROJECT);
  const cover = page.getByTestId('session-boot-cover');
  await expect(cover).toBeVisible();

  await page.keyboard.press('a');

  /*
    The way out a user can find, and the reason the sixty-second timeout is
    defensible: nobody is ever actually held here. The keystroke is also on its
    way to the pty, so the character both reaches the shell and reveals the
    terminal it landed in.
  */
  await expect(cover).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('going back to the overmind and returning finds the session still covered', async ({}, testInfo) => {
  const { app, page } = await withProject((name) => testInfo.outputPath(name));
  try {
  /*
    The cover is state on the session, not on the surface. A tab switch that
    dropped it would uncover a session that is still booting — and, worse, would
    make the cover look like an animation that plays once.
  */
  const id = await startSession(page, PROJECT);
  await expect(page.getByTestId('session-boot-cover')).toBeVisible();

  await page.getByRole('button', { name: 'Back to overmind' }).click();
  await expect(page.getByTestId('session-boot-cover')).toHaveCount(0);

  /*
    From the projects rail, not the fleet table: both draw a row for this
    session and an unanchored role query matches each of them. The rail is the
    honest choice of the two — it is where somebody who navigated away would
    actually click to come back.
  */
  await page
    .getByRole('navigation', { name: /^Projects/ })
    .getByRole('button', { name: new RegExp(`^${id}\\b`) })
    .click();

  await expect(page.getByTestId('session-boot-cover')).toBeVisible();
  } finally {
    await app.close();
  }
});
