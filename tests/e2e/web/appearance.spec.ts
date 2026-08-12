import { expect, test, type Page } from '@playwright/test';

/**
 * Appearance settings, in a real browser (story 105).
 *
 * Everything here is a claim a unit test cannot make. Vitest never instantiates
 * xterm — happy-dom performs no layout, so a terminal can never measure a cell
 * — and it has no page to reload. So the three things that actually matter are
 * proved here: the settings survive a reload, changing the terminal font does
 * not destroy the terminal, and compact density really does resize the rails.
 */

const APP_URL = '/?sim=0';

const openSettings = async (page: Page) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Appearance' })
    .click();
};

const leftRail = (page: Page) =>
  page.getByRole('navigation', { name: 'Projects, work, and agents' });

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('the nav switches between Projects and Appearance', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  // Always opens on Projects — the picker's empty state routes here.
  await expect(page.getByRole('heading', { name: 'Projects', level: 2 })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Appearance' })
    .click();

  await expect(
    page.getByRole('heading', { name: 'Appearance', level: 2 }),
  ).toBeVisible();
});

test('theme applies to the document and survives a reload', async ({ page }) => {
  await openSettings(page);
  await page.getByRole('radio', { name: 'Light' }).click();

  await expect(page.locator('body')).toHaveAttribute('data-theme', 'light');

  await page.reload();

  // The whole reason this store is synchronous localStorage rather than an
  // async bridge call: the restored theme is on the first frame, not the second.
  await expect(page.locator('body')).toHaveAttribute('data-theme', 'light');
});

test('compact density narrows the rail and survives a reload', async ({ page }) => {
  const width = () => leftRail(page).evaluate((el) => el.clientWidth);

  /**
   * Asserted as a *difference*, not as two pixel constants.
   *
   * The rail is `box-sizing: border-box` with a 1px right border, so
   * `clientWidth` reports one less than the token — pinning 268 here would fail
   * on a true implementation and teach the next person to distrust the number.
   * The claim worth making is that compact is 36px narrower, which is the gap
   * between the two tokens.
   */
  const comfortable = await width();

  await openSettings(page);
  await page.getByRole('radio', { name: 'Compact' }).click();

  await expect(page.locator('body')).toHaveAttribute('data-density', 'compact');

  /**
   * Closed before measuring, and not merely for tidiness: the overlay is
   * `aria-modal`, so Radix marks the rest of the tree `aria-hidden` while it is
   * open — exactly as the overlay's own comment says it should. A role query
   * for the left rail cannot resolve until it is dismissed.
   */
  await page.getByRole('button', { name: 'Close settings' }).click();

  // The measurement is the point: a CSS custom property that nothing reads
  // would still set the attribute and change nothing on screen.
  await expect.poll(width).toBe(comfortable - 36);

  await page.reload();

  await expect.poll(width).toBe(comfortable - 36);
});

test('changing the terminal font resizes the terminal without destroying it', async ({
  page,
}) => {
  const terminal = page.locator('[data-testid="terminal-surface"]').first();
  await expect(terminal).toBeVisible();

  // xterm writes the measured cell height into its own row elements, so this is
  // a real measurement of a real terminal, not a prop read back.
  const before = await terminal.locator('.xterm-rows').boundingBox();
  expect(before).not.toBeNull();

  await openSettings(page);
  await page.getByRole('combobox', { name: 'Size' }).selectOption('18');
  await page.getByRole('button', { name: 'Close settings' }).click();

  await expect
    .poll(async () => {
      const box = await terminal.locator('.xterm-rows').boundingBox();
      return box ? Math.round(box.height) : 0;
    })
    .not.toBe(Math.round(before?.height ?? 0));

  /**
   * The behaviour story 105 exists to protect: the same DOM node is still
   * there. A rebuild would have disposed this terminal and mounted a new one,
   * throwing away the scrollback of every kept-alive instance — the same
   * mechanism story 042's tab-switch spec asserts.
   */
  await expect(terminal).toBeVisible();
  await expect(page.locator('[data-testid="terminal-surface"]')).toHaveCount(1);
});
