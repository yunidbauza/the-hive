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

test('the header clears the traffic lights', async ({ page }) => {
  await page.waitForSelector('header');

  /**
   * Asserted as geometry, not as padding on a particular element. The lights
   * float over our header at `{ x: 16, y: 20 }` (story 081) and are ~12px
   * across with a 16px inset, so anything starting before ~78px is underneath
   * them. Which element carries that offset is an implementation detail — it
   * has already moved once, when the inset had to stop pushing the chip
   * cluster off the rail's edge.
   */
  const brandX = await page
    .getByText('The Hive')
    .first()
    .evaluate((element) => element.getBoundingClientRect().x);

  expect(brandX).toBeGreaterThanOrEqual(78);
});

test('the chip cluster still lands on the rail edge despite that inset', async ({
  page,
}) => {
  await page.waitForSelector('header');

  // The inset is absorbed inside the brand's fixed width precisely so this
  // stays true; padding the zone around it would push the cluster to 346.
  const railWidth = await page
    .locator('nav')
    .first()
    .evaluate((element) => element.getBoundingClientRect().width);
  const clusterX = await page
    .getByTestId('header-chips')
    .evaluate((element) => element.getBoundingClientRect().x);

  expect(Math.round(clusterX)).toBe(Math.round(railWidth));
});
