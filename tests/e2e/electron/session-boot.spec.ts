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
 * it. So this is the honest environment in which to prove the ways out work.
 *
 * That environment turned out to reproduce a **real** failure exactly (HIVE-103):
 * a folder Claude Code has not been trusted with produces a session whose pty
 * falls silent with a question on it and never reports anything either. The
 * quiet escape is tested here for that reason and not by arrangement.
 *
 * ## A note on timing, for whoever edits these
 *
 * The cover now lifts on its own about two seconds after the pty goes quiet,
 * and in this harness it does go quiet. The specs that assert the cover is
 * *present* therefore race that clock. Measured over ten repeats of this file:
 * they finish at 1.3–1.6s, and the quiet uncover lands at 4.0–4.3s — a margin
 * of roughly two and a half seconds, and 50/50 green. Adding a slow step to one
 * of them is what would spend that margin, so measure again if you do.
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

test('a boot that goes quiet uncovers itself, with nobody touching it', async ({}, testInfo) => {
  /**
   * The escape a real user needed (HIVE-103).
   *
   * A session opened in a folder Claude Code has not been trusted with draws a
   * trust prompt on the shell's own screen and waits. Claude never starts, so
   * no `SessionStart` fires and no ready signal is ever coming — and the
   * question sits behind the cover until the user thinks to press a key.
   *
   * **This harness reproduces that faithfully rather than by arrangement.** Its
   * session has no working `claude` either, so its pty falls silent and stays
   * silent, which is the same observable: main reports `idle` after two seconds
   * of quiet, and a boot with nothing left to say has nothing left to hide.
   *
   * No keystroke here, deliberately — that is the *other* escape, and this
   * spec is void if it borrows it. The generous timeout is what makes the
   * assertion meaningful: it is far below `BOOT_COVER_TIMEOUT_MS`, so passing
   * cannot be the sixty-second fallback arriving early.
   */
  const { app, page } = await withProject((name) => testInfo.outputPath(name));
  try {
  await startSession(page, PROJECT);
  const cover = page.getByTestId('session-boot-cover');
  await expect(cover).toBeVisible();

  await expect(cover).toHaveCount(0, { timeout: 15_000 });

  // And the terminal it was hiding is the thing now on screen.
  await expect(page.getByTestId('session-meta-bar')).toBeVisible();
  } finally {
    await app.close();
  }
});
