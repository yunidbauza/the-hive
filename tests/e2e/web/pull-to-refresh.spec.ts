import { expect, test, type Page } from '@playwright/test';

/**
 * Overscroll-to-refresh, driven by a real wheel.
 *
 * The unit tests dispatch synthetic `WheelEvent`s at a hook. What only a
 * browser can answer is whether the gesture reaches it at all: the listener is
 * attached to a scroll container the panel never renders — it is the rail's
 * `role="tabpanel"` wrapper, found by walking up from the panel's own root —
 * and `{ passive: false }` has to hold for `preventDefault` to stop the rail
 * bouncing against the indicator. happy-dom has no scrolling and no passive
 * listener semantics, so it cannot fail either of those.
 */

const APP_URL = '/?sim=0';

const leftRail = (page: Page) =>
  page.getByRole('navigation', { name: 'Projects, work, and agents' });

const activityRail = (page: Page) =>
  page.getByRole('complementary', { name: 'Activity' });

/**
 * Hold the gesture open.
 *
 * One big wheel would arm and release inside the same tick, and the labels
 * would be gone before an assertion could see them. Real trackpads emit a
 * stream, so this does too — each delta resets the release timer, which keeps
 * the indicator on screen for exactly as long as the fingers are moving.
 */
async function pull(page: Page, notches: number): Promise<void> {
  for (let i = 0; i < notches; i += 1) {
    await page.mouse.wheel(0, -24);
    await page.waitForTimeout(40);
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
  await page.waitForSelector('header');
});

test('the work list says what the pull will do, then does it', async ({ page }) => {
  await leftRail(page).getByRole('tab', { name: /^Work/ }).click();

  const panel = page.locator('[data-panel="work"]');
  await expect(panel).toBeVisible();
  await panel.hover();

  // Short of the threshold: an offer, not a promise.
  await pull(page, 2);
  await expect(page.getByText('Pull to refresh')).toBeVisible();

  // Past it.
  await pull(page, 3);
  await expect(page.getByText('Release to refresh')).toBeVisible();

  // Let go — the indicator finishes and clears itself.
  await expect(page.getByRole('status')).toHaveCount(0, { timeout: 5000 });
});

test('the PR list pulls too', async ({ page }) => {
  await activityRail(page).getByRole('tab', { name: /^PRs/ }).click();

  const panel = page.locator('[data-panel="prs"]');
  await expect(panel).toBeVisible();
  await panel.hover();

  await pull(page, 2);
  await expect(page.getByText('Pull to refresh')).toBeVisible();

  await expect(page.getByRole('status')).toHaveCount(0, { timeout: 5000 });
});

/**
 * The gesture belongs to two panels, not to the rails they sit in. Inbox
 * shares the activity rail's scroll container with PRs, so a listener attached
 * one level too high would fire here as well.
 */
test('the inbox, sharing the same scroll container, does not pull', async ({
  page,
}) => {
  await activityRail(page).getByRole('tab', { name: /^Inbox/ }).click();
  await page.locator('[data-panel="inbox"]').hover();

  await pull(page, 4);

  await expect(page.getByText(/Pull to refresh|Release to refresh/)).toHaveCount(0);
});

/**
 * The PRs header is pinned; only the list moves.
 *
 * A unit test can assert the search row renders outside the scrolling element.
 * It cannot assert that the element *scrolls* and the row *does not*, because
 * that needs a real overflow, which needs layout. The viewport is deliberately
 * short so the panel's own content is taller than the space it has — the
 * browser target has no GitHub bridge and therefore no PR cards to overflow
 * with.
 */
test('the PR search row stays put while the list scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 240 });
  await page.goto(APP_URL);
  await page.waitForSelector('header');
  await activityRail(page).getByRole('tab', { name: /^PRs/ }).click();

  const panel = page.locator('[data-panel="prs"]');
  await expect(panel).toBeVisible();

  const before = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-panel="prs"]')!;
    const scroller = root.querySelector<HTMLElement>('.overflow-y-auto')!;
    const input = root.querySelector<HTMLElement>('input')!;
    return {
      // The whole point: the control is not inside the thing that scrolls.
      inputInsideScroller: scroller.contains(input),
      // The rail's own scroller has nothing left to scroll.
      railOverflows: root.parentElement!.scrollHeight > root.parentElement!.clientHeight,
      canScroll: scroller.scrollHeight > scroller.clientHeight,
      inputY: input.getBoundingClientRect().y,
    };
  });

  expect(before.inputInsideScroller).toBe(false);
  expect(before.railOverflows).toBe(false);
  // Guards the assertion below from passing vacuously on content that fits.
  expect(before.canScroll).toBe(true);

  const after = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-panel="prs"]')!;
    const scroller = root.querySelector<HTMLElement>('.overflow-y-auto')!;
    scroller.scrollTop = 9999;
    return {
      scrolled: scroller.scrollTop,
      inputY: root.querySelector<HTMLElement>('input')!.getBoundingClientRect().y,
    };
  });

  expect(after.scrolled).toBeGreaterThan(0);
  expect(after.inputY).toBe(before.inputY);
});
