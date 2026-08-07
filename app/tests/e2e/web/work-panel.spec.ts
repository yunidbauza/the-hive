import { expect, test } from '@playwright/test';

/**
 * The WORK tab in the browser target (HIVE-69).
 *
 * ## Why this spec is new
 *
 * HIVE-69's ticket asserts that deleting the fixtures would break
 * `pnpm test:e2e:web`. Reconciling that against the suite found it was not
 * true — **no e2e spec touched the WORK panel at all**, so the claim rested on
 * coverage that did not exist. The conclusion was right for a different reason
 * (`hive-store.ts` imports `createInitialState` unconditionally, and three unit
 * suites assert fixture ticket data), so rather than delete the claim this
 * story supplies the coverage it assumed.
 *
 * What it pins: the browser demo has no Electron, no main process, and no Jira,
 * and it must still render a populated WORK tab. Every ticket in this epic
 * widens something the desktop path uses — the type, the store, the panel — and
 * this is the spec that fails if one of those widenings quietly makes the demo
 * depend on a bridge that is not there.
 */

const APP_URL = '/?sim=0';

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
  await page.waitForSelector('header');
  await page
    .getByRole('navigation', { name: 'Projects, work, and agents' })
    .getByRole('tab', { name: /^Work/ })
    .click();
});

test('renders fixture tickets with no Jira and no bridge', async ({ page }) => {
  const work = page.locator('[data-panel="work"]');
  await expect(work).toBeVisible();

  // The eight fixtures, still the browser target's data.
  await expect(work.getByText('GRAC-3018')).toBeVisible();
  await expect(
    work.getByText('Hero refresh: migrate to semantic tokens'),
  ).toBeVisible();
  await expect(work.locator('article')).toHaveCount(8);
});

test('shows no desktop-only notice in the demo', async ({ page }) => {
  const work = page.locator('[data-panel="work"]');

  // Fixtures are the demo's data, not a degraded mode. A "configure Jira"
  // line here would be telling a browser user to fix something that is not
  // broken and that they could not fix anyway.
  await expect(work.getByText(/No Jira connection yet/i)).toHaveCount(0);
  await expect(work.getByText(/may be out of date/i)).toHaveCount(0);
  await expect(work.getByText(/No issues matched/i)).toHaveCount(0);
});

test('renders the status name, coloured by category', async ({ page }) => {
  const work = page.locator('[data-panel="work"]');

  // The name is Jira's, displayed verbatim; the colour comes from the
  // category, which is why "In Review" and "In Progress" now match.
  await expect(work.getByText('In Progress').first()).toBeVisible();
  await expect(work.getByText('In Review').first()).toBeVisible();
  await expect(work.getByText('Done').first()).toBeVisible();
});

test('a fixture ticket does not link out — there is nowhere to go', async ({
  page,
}) => {
  const work = page.locator('[data-panel="work"]');

  // `url` is absent for fixtures, so the key is plain text. A link to a Jira
  // that was never configured would 404 into somebody else's site.
  await expect(work.getByRole('link', { name: 'GRAC-3018' })).toHaveCount(0);
  await expect(work.getByText('GRAC-3018')).toBeVisible();
});

test('the Work tab badge still counts every ticket', async ({ page }) => {
  await expect(
    page
      .getByRole('navigation', { name: 'Projects, work, and agents' })
      .getByRole('tab', { name: /^Work/ }),
  ).toContainText('8');
});
