import { TITLEBAR_HEIGHT } from '../../../electron/shared/window';

import { expect, test } from './fixtures/hive-app';

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
  await page.getByRole('button', { name: 'New session' }).click();

  await expect(page.getByText('Start a new session')).toBeVisible();
});

test('the model chip starts on the left rail edge, not the header midpoint', async ({
  page,
}) => {
  // The chip is conditional on a session; the app boots into the orchestrator,
  // which deliberately has no model of its own.
  await page.getByRole('button', { name: /hero-refresh/ }).first().click();

  const chip = page.getByRole('banner').getByTitle(/\(1M\)/);
  await expect(chip).toBeVisible();

  const railWidth = await page
    .locator('nav')
    .first()
    .evaluate((element) => element.getBoundingClientRect().width);
  const chipBox = await chip.boundingBox();

  /**
   * Desktop has no `demo` chip, so the model chip is first in the cluster and
   * lands on the rail's edge itself — the assertion the web suite cannot make,
   * because there the `demo` chip owns that line.
   */
  expect(Math.round(chipBox!.x)).toBe(Math.round(railWidth));

  const headerBox = await page.getByRole('banner').boundingBox();
  const headerMid = headerBox!.x + headerBox!.width / 2;
  expect(Math.abs(chipBox!.x + chipBox!.width / 2 - headerMid)).toBeGreaterThan(2);
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
   * 56px, and every term of it is a layout constant rather than a measurement:
   * 16 (the header's own `px-4`) + 30 (the logo tile) + 10 (`gap-2.5`). This is
   * the *wordmark*, so the brand block itself starts at 16 — the same left
   * margin the traffic lights use one row up.
   *
   * The old assertion on this element was `>= 78`, the width of the inset that
   * kept it clear of the lights. Its going below 78 is the regression this
   * inverts; the exact 56 is what stops the inset creeping back in some other
   * form.
   */
  expect(brandX).toBeLessThan(78);
  expect(Math.round(brandX)).toBe(16 + 30 + 10);
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
