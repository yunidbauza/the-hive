import { join } from 'node:path';

import { TITLEBAR_HEIGHT } from '../../../electron/shared/window';

import {
  expect,
  launchHive,
  startSession,
  test,
  writeProjectConfig,
} from './fixtures/hive-app';

/** A project id, and a directory that certainly exists on any machine here. */
const PROJECT = 'nova-web';
const REAL_DIRECTORY = join(import.meta.dirname, '../../..');

/**
 * Window chrome (story 085).
 *
 * `titleBarStyle: 'hiddenInset'` removes the native title bar so the app's own
 * 56px header is the only bar. That has consequences the renderer has to
 * honour, and this file is where they stop being assumed.
 */

test('has no native title bar stacked above the app header', async ({
  hive,
  page,
}) => {
  await page.waitForSelector('header');

  const chrome = await hive.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const bounds = window.getBounds();
    const content = window.getContentBounds();
    return { titleBarHeight: bounds.height - content.height };
  });

  // Two stacked bars is exactly what hiddenInset exists to prevent.
  expect(chrome.titleBarHeight).toBe(0);
});

test('the header is the window’s drag region', async ({ page }) => {
  // Without a native title bar there is nothing else to grab, so this is the
  // difference between a movable window and a stuck one.
  const region = await page
    .locator('header')
    .evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region'));

  expect(region).toBe('drag');
});

test('every control in the header stays clickable inside that drag region', async ({
  page,
}) => {
  // A drag region swallows clicks from its children unless they opt out, so
  // this is the regression that would make the whole header inert.
  const regions = await page
    .locator('header button')
    .evaluateAll((buttons) =>
      buttons.map((button) =>
        getComputedStyle(button).getPropertyValue('-webkit-app-region'),
      ),
    );

  expect(regions.length).toBeGreaterThan(0);
  expect(regions.every((region) => region === 'no-drag')).toBe(true);
});

test('the New session button actually responds to a click', async ({ page }) => {
  // The end-to-end version of the assertion above: no-drag is only meaningful
  // if the click lands.
  await page.getByRole('button', { name: 'New session', exact: true }).click();

  await expect(page.getByText('Start a new session')).toBeVisible();
});

/**
 * This one launches its own app rather than taking the shared fixture.
 *
 * The chip is conditional on an active session, and the app boots into the
 * orchestrator, which deliberately has no model of its own. It used to get a
 * session by clicking `hero-refresh` — one of ten seeded into the store at
 * boot. Nothing is seeded now, so the session has to be started, and starting
 * one needs a *mapped* project, which needs a config the shared fixture does
 * not write.
 */
test('the model chip starts on the left rail edge, not the header midpoint', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  writeProjectConfig(configPath, { id: PROJECT, path: REAL_DIRECTORY });

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    await startSession(page, PROJECT);

    /**
     * Found by test id, not by its label.
     *
     * This read `getByTitle(/\(1M\)/)` and had been failing since the window
     * suffix stopped being hardcoded and started being derived from
     * `metrics.contextWindow` (`session-metrics.ts`). This suite stubs `claude`
     * out entirely — `STUB_CLAUDE_COMMAND` is `true; false` — so no status line
     * ever reports a window, and the chip correctly renders `Opus 4.5 · high`
     * with no suffix at all. `session-metrics.test.ts` pins that exact
     * behaviour: `chipLabel({}, 'opus', 'high')` must *not* contain `(1M)`.
     *
     * So the locator was asserting the opposite of the specified contract, in
     * the one suite that can never satisfy it. The unit tests were updated when
     * the label changed and this was not — which is also why nothing caught it:
     * a locator that never matches fails as a timeout, and a timeout reads like
     * a slow app rather than a wrong query.
     *
     * The alignment measured below is about where the chip sits, not what it
     * says, so it has no business depending on a model's reported window.
     */
    const chip = page.getByRole('banner').getByTestId('model-chip');
    await expect(chip).toBeVisible();

    const railWidth = await page
      .locator('nav')
      .first()
      .evaluate((element) => element.getBoundingClientRect().width);
    const chipBox = await chip.boundingBox();

    /**
     * Desktop has no `demo` chip, so the model chip is first in the cluster and
     * lands on the rail's edge itself — the assertion the web suite cannot
     * make, because there the `demo` chip owns that line.
     */
    expect(Math.round(chipBox!.x)).toBe(Math.round(railWidth));

    const headerBox = await page.getByRole('banner').boundingBox();
    const headerMid = headerBox!.x + headerBox!.width / 2;
    expect(Math.abs(chipBox!.x + chipBox!.width / 2 - headerMid)).toBeGreaterThan(2);
  } finally {
    await app.close();
  }
});

test('the traffic lights get their own row above the header', async ({ page }) => {
  await page.waitForSelector('header');

  /**
   * The header used to carry a 78px inset so the wordmark cleared the lights
   * `hiddenInset` floats over it, which put three system buttons immediately
   * beside the brand. They have their own strip now, so this asserts the
   * inverse of what it used to: the header sits *below* the strip, and the
   * brand starts at the header's own `px-4` rather than pushed clear of
   * something overlapping it.
   */
  const strip = page.getByTestId('title-bar');
  await expect(strip).toBeVisible();

  const stripBox = (await strip.boundingBox())!;
  const headerBox = (await page.getByRole('banner').boundingBox())!;

  // The strip is the top of the window, and the header begins where it ends.
  expect(Math.round(stripBox.y)).toBe(0);
  expect(Math.round(headerBox.y)).toBe(Math.round(stripBox.y + stripBox.height));

  const brandX = await page
    .getByText('The Hive')
    .first()
    .evaluate((element) => element.getBoundingClientRect().x);

  /**
   * 16 (the header's own `px-4`) + the mark + 10 (`gap-2.5`). This is the
   * *wordmark*, so the brand block itself starts at 16 — the same left margin
   * the traffic lights use one row up.
   *
   * The old assertion was `>= 78`, the width of the inset that kept the brand
   * clear of the floating lights. Its going below 78 is the regression this
   * inverts; pinning the exact start is what stops the inset creeping back in
   * some other form.
   *
   * ## Why the mark's width is measured rather than written down (HIVE-100)
   *
   * It used to be the literal `30`, because the mark was a square 30px tile.
   * The tile is now the hive sprite, which is 166×180 — so a 34px-tall mark is
   * 31.4px wide, and *no* integer is the right one to hardcode. Measuring it
   * keeps the assertion about the thing it was always about — that the brand
   * block starts at the header's own padding with one gap between its two
   * parts — rather than about a sprite's aspect ratio, which is not this
   * spec's business and would break it again on any future art change.
   */
  const markWidth = await page
    .locator('header [data-creature]')
    .first()
    .evaluate((element) => element.getBoundingClientRect().width);

  expect(brandX).toBeLessThan(78);
  expect(Math.round(brandX)).toBe(Math.round(16 + markWidth + 10));
});

test('the lights are positioned inside the strip, not over the header', async ({
  hive,
  page,
}) => {
  await page.waitForSelector('header');

  /**
   * The half a page screenshot cannot prove.
   *
   * The traffic lights are drawn by macOS *over* the window, outside the web
   * contents entirely, so `page.screenshot()` shows the strip and never the
   * buttons in it. Asked from the main process instead, this is the actual
   * claim: the buttons are inside the 32px strip rather than floating over the
   * 56px header below it.
   */
  const lights = await hive.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    return window.getWindowButtonPosition();
  });

  // macOS draws them 12px across, so the whole button clears the strip's edge.
  expect(lights).not.toBeNull();
  expect(lights!.y).toBeGreaterThanOrEqual(0);
  expect(lights!.y + 12).toBeLessThanOrEqual(TITLEBAR_HEIGHT);
  // Same left margin as the wordmark one row down.
  expect(lights!.x).toBe(16);
});

test('the strip is draggable, so the window can still be moved', async ({ page }) => {
  // Without a native title bar the drag regions are the only way to move the
  // window. The strip is 32px of otherwise-empty panel; if it is not draggable
  // it is dead space.
  const region = await page
    .getByTestId('title-bar')
    .evaluate((element) =>
      getComputedStyle(element).getPropertyValue('-webkit-app-region'),
    );

  expect(region).toBe('drag');
});

test('the chip cluster still lands on the rail edge', async ({
  page,
}) => {
  await page.waitForSelector('header');

  // The brand's fixed 252px width is what puts the chips on the rail's edge,
  // and it survives the inset's removal because it was never about the lights.
  const railWidth = await page
    .locator('nav')
    .first()
    .evaluate((element) => element.getBoundingClientRect().width);
  const clusterX = await page
    .getByTestId('header-chips')
    .evaluate((element) => element.getBoundingClientRect().x);

  expect(Math.round(clusterX)).toBe(Math.round(railWidth));
});
