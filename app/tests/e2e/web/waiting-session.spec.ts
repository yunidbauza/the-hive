import { expect, test, type Page } from '@playwright/test';

/**
 * The payoff loop (stories 043, 070).
 *
 * This is the product's core promise, and story 043 names it the one flow that
 * must be verified in a browser rather than against a mocked terminal: open a
 * blocked session, read the amber question in a *real* xterm, answer it below,
 * and watch the status clear everywhere.
 */

const APP_URL = '/?sim=0';

const stage = (page: Page) => page.getByRole('main');
const terminalFor = (page: Page, id: string) =>
  page.locator(`[data-terminal-id="${id}"]`);
const messageInput = (page: Page, id: string) =>
  page.getByRole('textbox', { name: `Message ${id}` });

const openSession = async (page: Page, id: string) => {
  await page.getByRole('button', { name: new RegExp(id) }).first().click();
  await expect(terminalFor(page, id)).toBeVisible();
};

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
});

test('a blocked session shows its question and its meta bar says so', async ({
  page,
}) => {
  await openSession(page, 'lead-form');

  // Painted by xterm from the fixture transcript, in the amber the palette
  // reserves for questions.
  await expect(terminalFor(page, 'lead-form')).toContainText(
    'Permission needed: yarn prisma migrate dev',
  );
  await expect(stage(page).getByText('needs input')).toBeVisible();
});

test('answering a blocked session resumes it everywhere', async ({ page }) => {
  await openSession(page, 'lead-form');

  await messageInput(page, 'lead-form').fill('y');
  await messageInput(page, 'lead-form').press('Enter');

  // The echo lands in the real terminal immediately…
  await expect(terminalFor(page, 'lead-form')).toContainText('❯ y');
  await expect(messageInput(page, 'lead-form')).toHaveValue('');

  // …and after the round-trip the session acknowledges and resumes.
  await expect(terminalFor(page, 'lead-form')).toContainText(
    '● Acknowledged — working on it',
    { timeout: 10_000 },
  );
  await expect(stage(page).getByText('working', { exact: true })).toBeVisible();
  await expect(stage(page).getByText('needs input')).toHaveCount(0);
});

test('the status clears in the rails too, not just the meta bar', async ({
  page,
}) => {
  await openSession(page, 'lead-form');
  const rail = page.getByRole('navigation', { name: 'Projects, work, and agents' });
  await expect(rail.getByText('needs input').first()).toBeVisible();

  await messageInput(page, 'lead-form').fill('y');
  await messageInput(page, 'lead-form').press('Enter');

  // One status change, every surface — the reason status is derived rather
  // than stored per panel.
  await expect(rail.getByText('working').first()).toBeVisible({ timeout: 10_000 });
});

test('the message row autofocuses when a session opens', async ({ page }) => {
  await openSession(page, 'hero-refresh');

  // Hands never leave the keyboard: open a session, start typing.
  await expect(messageInput(page, 'hero-refresh')).toBeFocused();
});

test('clicking the terminal focuses the message row', async ({ page }) => {
  await openSession(page, 'hero-refresh');
  await page.getByRole('button', { name: 'Switch to light theme' }).focus();
  await expect(messageInput(page, 'hero-refresh')).not.toBeFocused();

  await terminalFor(page, 'hero-refresh').click({ position: { x: 40, y: 30 } });

  await expect(messageInput(page, 'hero-refresh')).toBeFocused();
});

test('selecting terminal text does not steal the selection', async ({ page }) => {
  await openSession(page, 'hero-refresh');
  const screen = terminalFor(page, 'hero-refresh').locator('.xterm-screen');
  const box = await screen.boundingBox();

  await page.mouse.move(box!.x + 8, box!.y + 6);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width - 40, box!.y + 6, { steps: 12 });
  await page.mouse.up();

  /**
   * Focusing an input collapses the document selection, so a naive
   * focus-on-click would delete the highlight the drag had only just made.
   */
  const selected = await page.evaluate(
    () => window.getSelection()?.toString() ?? '',
  );
  const overlay = await terminalFor(page, 'hero-refresh')
    .locator('.xterm-selection div')
    .count();
  expect(selected.length > 0 || overlay > 0).toBe(true);
});

test('ArrowLeft on an empty prompt returns to the orchestrator', async ({
  page,
}) => {
  await openSession(page, 'hero-refresh');

  await messageInput(page, 'hero-refresh').press('ArrowLeft');

  // Back to the fleet table.
  await expect(stage(page).getByText('SESSION', { exact: true })).toBeVisible();
});

test('an agent accepts a message and stays online', async ({ page }) => {
  await page.getByRole('tab', { name: /Agents/ }).click();
  await openSession(page, 'slack-agent');

  await messageInput(page, 'slack-agent').fill('status?');
  await messageInput(page, 'slack-agent').press('Enter');

  await expect(terminalFor(page, 'slack-agent')).toContainText(
    '● Acknowledged — working on it',
    { timeout: 10_000 },
  );
  // Agents are long-lived workers; `working` is a session lifecycle state.
  await expect(stage(page).getByText('online')).toBeVisible();
});

test('a task-less spawned session invites a first instruction', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New session' }).click();
  await page.keyboard.press('Escape');

  // Spawned from the console, since the real picker lands in story 044.
  const console_ = page.getByRole('textbox', { name: 'Orchestrator command' });
  await console_.fill('spawn apfm-web ');
  await console_.press('Enter');
  await console_.fill('spawn apfm-web first task');
  await console_.press('Enter');

  await expect(stage(page).getByText('first task', { exact: true })).toBeVisible();
});

const activityRail = (page: Page) =>
  page.getByRole('complementary', { name: 'Activity' });

test('the inbox jumps to the session that is blocked', async ({ page }) => {
  const rail = activityRail(page);

  // The rail opens on the inbox, with the unread count on its tab.
  await expect(rail.getByRole('tab', { name: /Inbox/ })).toBeVisible();

  await rail.getByText('lead-form needs approval').click();

  // The payoff: one click from "something needs you" to the amber prompt.
  await expect(terminalFor(page, 'lead-form')).toBeVisible();
  await expect(terminalFor(page, 'lead-form')).toContainText(
    'Permission needed: yarn prisma migrate dev',
  );
});

test('reading a notification decrements both badges', async ({ page }) => {
  const rail = activityRail(page);
  const inboxTab = rail.getByRole('tab', { name: /Inbox/ });

  await expect(inboxTab).toContainText('3');

  await rail.getByText('lead-form needs approval').click();

  await expect(inboxTab).toContainText('2');
  // The header bell reads the same count.
  await expect(
    page.getByRole('button', { name: /Mark 2 unread notifications as read/ }),
  ).toBeVisible();
});

test('the PRs tab lists what is shippable with its badges', async ({ page }) => {
  const rail = activityRail(page);
  await rail.getByRole('tab', { name: /PRs/ }).click();

  await expect(rail.getByText('2 open findings')).toBeVisible();
  await expect(rail.getByText('approved')).toBeVisible();
  await expect(rail.getByText('checks running')).toBeVisible();
  await expect(rail.getByText('merged')).toBeVisible();

  // A PR opens the session that owns it, not a browser tab.
  await rail.getByText('Hero: semantic token refactor').click();
  await expect(terminalFor(page, 'hero-refresh')).toBeVisible();
});

test('the activity tab logs a routed message', async ({ page }) => {
  await openSession(page, 'lead-form');
  await messageInput(page, 'lead-form').fill('y');
  await messageInput(page, 'lead-form').press('Enter');

  const rail = activityRail(page);
  await rail.getByRole('tab', { name: /Activity/ }).click();

  await expect(rail.getByText('Routed your message to lead-form')).toBeVisible();
});

/**
 * Story 050's third criterion — rail hidden, terminal refits — has no E2E here
 * because **no control toggles the rail yet**: `toggleActivityRail` exists in
 * the ui-store and nothing in the UI calls it. The unmount half is asserted in
 * `tests/components/layout/app-shell.test.tsx`, and the refit half is 042's
 * ResizeObserver, covered in the terminal specs. When a story adds the toggle,
 * the browser-level assertion belongs here.
 */
