import { expect, test } from '@playwright/test';

/**
 * The picker's heading, in a real browser (HIVE-73).
 *
 * ## Why this spec exists
 *
 * `openPicker` gained an optional ticket key, and the header's button passed it
 * straight to `onClick` — which would have handed React's `MouseEvent` in as
 * that key and produced a picker headed "Start a session for [object Object]".
 * TypeScript caught it, but the shape of the bug is a rendered string, so the
 * guard belongs where strings are actually rendered.
 *
 * ## What this cannot cover, and why it is not here
 *
 * The other half of HIVE-73 — clicking `new session` on a ticket card and
 * seeing the picker name that ticket — needs a ticket on screen, and neither
 * e2e target can produce one. The browser target has no bridge, so no Jira and
 * no config; the electron target has both, but the suite has no Jira stub, and
 * `client.ts` builds every request as `https://${site}`, so standing one up
 * means an HTTPS server with a certificate the app will accept. That is its own
 * piece of infrastructure rather than a line in this file. The ticket-side
 * behaviour is covered at the unit level in
 * `tests/features/sessions/components/new-session-picker.test.tsx` and
 * `tests/features/work/components/ticket-card.test.tsx`.
 */

const APP_URL = '/?sim=0';

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
  await page.waitForSelector('header');
});

test('the header opens a picker with no ticket on it', async ({ page }) => {
  await page.getByRole('button', { name: 'New session' }).click();

  const picker = page.getByRole('dialog');
  await expect(picker).toBeVisible();

  await expect(
    picker.getByText('Start a new session', { exact: true }),
  ).toBeVisible();
  await expect(
    picker.getByText('Pick a project — a Claude Code terminal will open for it'),
  ).toBeVisible();
});

/**
 * The precise failure the header fix prevents. A MouseEvent reaching the
 * heading renders as `[object Object]`, and no other assertion here would
 * notice — the dialog would still be visible and still have a title.
 */
test('never renders an object as the ticket key', async ({ page }) => {
  await page.getByRole('button', { name: 'New session' }).click();

  await expect(page.getByText(/\[object Object\]/)).toHaveCount(0);
  await expect(page.getByText(/Start a session for/)).toHaveCount(0);
});

test('the model and effort steppers are on the picker', async ({ page }) => {
  await page.getByRole('button', { name: 'New session' }).click();

  const picker = page.getByRole('dialog');
  await expect(picker.getByRole('radio', { name: 'opus' })).toBeChecked();
  await expect(picker.getByRole('radio', { name: 'high' })).toBeChecked();
});

test('escape closes it', async ({ page }) => {
  await page.getByRole('button', { name: 'New session' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.keyboard.press('Escape');

  await expect(page.getByRole('dialog')).toHaveCount(0);
});
