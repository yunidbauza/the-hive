import { expect, test } from '@playwright/test';

/**
 * The PRS tab with nothing behind it, in a real browser.
 *
 * ## What this spec exists to catch
 *
 * The panel used to be seeded: four sample pull requests — #482, #219, #495,
 * #77 — naming repositories the user did not have, in a target with no Electron,
 * no main process and no `gh`. The same seed loaded on the desktop side, so a
 * real sweep replaced somebody else's pull requests with the user's a moment
 * after launch.
 *
 * The load-bearing assertion is the negative one: no seeded PR number reaches
 * the DOM, in any state. A unit test can assert the store is empty; only a real
 * browser can prove nothing paints it — including a one-frame flash, since a
 * number that appears and vanishes still appears.
 */

const APP_URL = '/?sim=0';

const prsTab = (page: import('@playwright/test').Page) =>
  page
    .getByRole('tablist', { name: 'Activity sections' })
    .getByRole('tab', { name: /^PRs/i });

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
  await page.waitForSelector('header');
  await prsTab(page).click();
});

test('explains that pull requests need the desktop app', async ({ page }) => {
  const prs = page.locator('[data-panel="prs"]');
  await expect(prs).toBeVisible();

  // A browser has no bridge, therefore no `gh`. A configuration answer, which
  // the panel gives rather than sitting blank or spinning forever.
  await expect(prs.getByText(/need the desktop app/i)).toBeVisible();
});

test('paints no pull request at all', async ({ page }) => {
  const prs = page.locator('[data-panel="prs"]');

  await expect(prs.getByRole('button')).toHaveCount(0);
  await expect(prs.getByRole('link')).toHaveCount(0);
});

/** The regression guard for the whole change. */
test('never renders a seeded PR', async ({ page }) => {
  for (const number of ['#482', '#219', '#495', '#77']) {
    await expect(page.getByText(number, { exact: true })).toHaveCount(0);
  }

  await expect(page.getByText('Hero: semantic token refactor')).toHaveCount(0);
  await expect(page.getByText('apfm-web')).toHaveCount(0);
});

/** The skeleton is for a read in flight, and a browser never has one. */
test('settles rather than leaving a skeleton on screen', async ({ page }) => {
  await expect(page.getByLabel('Loading pull requests')).toHaveCount(0);
});

/**
 * The states that belong to a *desktop* sweep must not leak into a browser,
 * where they would name a failure that did not happen.
 */
test('claims neither staleness nor a failed sweep', async ({ page }) => {
  const prs = page.locator('[data-panel="prs"]');

  await expect(prs.getByText(/may be out of date/i)).toHaveCount(0);
  await expect(prs.getByText(/No open pull requests/i)).toHaveCount(0);
  await expect(prs.getByRole('button', { name: /try again/i })).toHaveCount(0);
});
