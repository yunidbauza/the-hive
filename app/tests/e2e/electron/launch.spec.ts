import { expect, test } from './fixtures/hive-app';

/**
 * The app boots (story 085).
 *
 * "It works in the browser build" is not "the desktop app works", and this is
 * the file that stops the two being confused.
 */

test('opens exactly one window, titled and visible', async ({ hive, page }) => {
  await page.waitForSelector('header');

  const window = await hive.evaluate(({ BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows();
    return {
      count: all.length,
      visible: all[0]!.isVisible(),
      title: all[0]!.getTitle(),
    };
  });

  // One window by design (story 000).
  expect(window.count).toBe(1);
  expect(window.visible).toBe(true);
  expect(window.title).toBe('The Hive');
});

test('renders the real app, not an empty shell', async ({ page }) => {
  // The whole premise of the epic: the renderer we already shipped IS the
  // desktop app's UI.
  await expect(page.locator('header')).toContainText('The Hive');
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible();
  await expect(page.locator('.xterm').first()).toBeVisible();
});

test('shows no white flash — the window paints the app background', async ({
  hive,
  page,
}) => {
  await page.waitForSelector('header');

  const background = await hive.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.getBackgroundColor(),
  );

  // --cc-bg. The default is white, and on a dark app that is the flash people
  // notice on every cold launch (story 081).
  expect(background.toLowerCase()).toBe('#10152a');
});

test('loads its assets from disk — no broken images', async ({ page }) => {
  // A root-relative asset URL resolves against the FILESYSTEM root under
  // file://, which 404s silently as a broken image (story 083).
  const mark = page.locator('header img').first();
  await expect(mark).toBeVisible();

  const width = await mark.evaluate((img: HTMLImageElement) => img.naturalWidth);
  expect(width).toBeGreaterThan(0);
});

test('is the desktop target, so it shows no demo chip', async ({ page }) => {
  await page.waitForSelector('header');

  await expect(page.getByText('demo', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => typeof window.hive)).toBe('object');
});
