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

test('the header clears the traffic lights', async ({ page }) => {
  await page.waitForSelector('header');

  const paddingLeft = await page
    .locator('header > div')
    .first()
    .evaluate((element) => getComputedStyle(element).paddingLeft);

  // The lights float over our header at { x: 16, y: 20 } (story 081); without
  // this inset they sit on top of the wordmark.
  expect(paddingLeft).toBe('78px');
});
