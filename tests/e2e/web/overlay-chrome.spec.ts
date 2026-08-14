import { expect, test } from '@playwright/test';

/**
 * The header and rails stay live while a full-stage overlay is open.
 *
 * Both overlays fill the centre stage and leave the surrounding chrome on
 * screen on purpose. Radix's default modality then marked that chrome
 * `aria-hidden` with `pointer-events: none`, so the theme toggle, the bell,
 * New session and every rail tab looked live and did nothing — and the click
 * that reached none of them dismissed the overlay instead. Toggling the theme
 * from settings took two clicks: one to lose your place, one to act.
 *
 * These are browser-only claims. Nothing in a unit test can see
 * `pointer-events`, because happy-dom performs no layout and never resolves
 * whether a click would land.
 */

const APP_URL = '/?sim=0';

const themeButton = (page: import('@playwright/test').Page) =>
  page.locator('header button[aria-label*="Switch to"]');

/** The body attribute the theme actually writes. Dark leaves it unset. */
const theme = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.body.dataset.theme ?? 'dark');

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
  await page.waitForSelector('header');
});

test('the header stays clickable while settings is open', async ({ page }) => {
  await page.getByRole('banner').getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('button', { name: 'Close settings' })).toBeVisible();

  /**
   * The two properties that made the chrome a lie. Asserted directly rather
   * than through a click, so a regression names its own cause.
   */
  await expect(page.locator('header')).not.toHaveAttribute('aria-hidden', 'true');
  expect(
    await page.locator('header').evaluate((h) => getComputedStyle(h).pointerEvents),
  ).toBe('auto');

  const before = await theme(page);
  await themeButton(page).click();

  // It acted…
  await expect.poll(() => theme(page)).not.toBe(before);
  // …and it did not cost the user their place.
  await expect(page.getByRole('button', { name: 'Close settings' })).toBeVisible();
});

test('the header stays clickable while the picker is open', async ({ page }) => {
  await page.getByRole('banner').getByRole('button', { name: 'New session' }).click();
  await expect(page.getByPlaceholder('search all projects…')).toBeVisible();

  const before = await theme(page);
  await themeButton(page).click();

  await expect.poll(() => theme(page)).not.toBe(before);
  await expect(page.getByPlaceholder('search all projects…')).toBeVisible();
});

/**
 * The two routes out that must survive losing outside-dismissal. Escape is the
 * one a keyboard user reaches for; the button is the one everyone else does.
 */
test('settings still closes on Escape and on its own button', async ({ page }) => {
  const gear = page.getByRole('banner').getByRole('button', { name: 'Settings' });

  await gear.click();
  await expect(page.getByRole('button', { name: 'Close settings' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Close settings' })).toBeHidden();

  await gear.click();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('button', { name: 'Close settings' })).toBeHidden();
});

test('the picker still closes on Escape', async ({ page }) => {
  await page.getByRole('banner').getByRole('button', { name: 'New session' }).click();
  await expect(page.getByPlaceholder('search all projects…')).toBeVisible();

  await page.keyboard.press('Escape');

  await expect(page.getByPlaceholder('search all projects…')).toBeHidden();
});
