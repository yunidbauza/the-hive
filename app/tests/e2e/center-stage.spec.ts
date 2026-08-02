import { expect, test, type Page } from '@playwright/test';

/**
 * Center stage view states (stories 040, 070).
 *
 * The claim under test is the story's first acceptance criterion: **exactly one
 * state visible at a time**, with no flash of the wrong one on switch. That is
 * a rendering claim, so it belongs in a browser — `resolve-view.test.ts` proves
 * the machine, this proves what reaches the screen.
 */

const APP_URL = '/?sim=0';

const stage = (page: Page) => page.getByRole('main');
const metaBar = (page: Page) => stage(page).getByTitle('Back to orchestrator (←)');
const pickerTitle = (page: Page) => stage(page).getByText('Start a new session');
const visibleTerminals = (page: Page) =>
  stage(page).locator('[data-testid="terminal-surface"]:not([style*="display: none"])');

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
});

test('opens on the orchestrator, with a terminal and no meta bar', async ({
  page,
}) => {
  await expect(visibleTerminals(page)).toHaveCount(1);
  await expect(metaBar(page)).toHaveCount(0);
  await expect(pickerTitle(page)).toHaveCount(0);
});

test('shows the meta bar above the terminal in a session', async ({ page }) => {
  await page.getByRole('button', { name: /hero-refresh/ }).first().click();

  await expect(metaBar(page)).toBeVisible();
  await expect(
    stage(page).getByText('feat/hero-refresh', { exact: true }),
  ).toBeVisible();
  await expect(
    stage(page).getByText('Refactor hero to semantic tokens'),
  ).toBeVisible();
  await expect(stage(page).getByText('#482 · open')).toBeVisible();
  await expect(visibleTerminals(page)).toHaveCount(1);
});

test('renames a blocked session to "needs input" on the bar', async ({ page }) => {
  await page.getByRole('button', { name: /lead-form/ }).first().click();

  await expect(stage(page).getByText('needs input')).toBeVisible();
});

test('shows agent chips instead of branch and PR for an agent', async ({
  page,
}) => {
  await page.getByRole('tab', { name: /Agents/ }).click();
  await page.getByRole('button', { name: /slack-agent/ }).first().click();

  await expect(stage(page).getByText('dedicated agent')).toBeVisible();
  await expect(stage(page).getByText('online')).toBeVisible();
});

test('the back pill returns to the orchestrator', async ({ page }) => {
  await page.getByRole('button', { name: /hero-refresh/ }).first().click();
  await expect(metaBar(page)).toBeVisible();

  await metaBar(page).click();

  await expect(metaBar(page)).toHaveCount(0);
  await expect(visibleTerminals(page)).toHaveCount(1);
});

test.describe('the picker', () => {
  test('replaces the stage and hides every terminal', async ({ page }) => {
    await page.getByRole('button', { name: /hero-refresh/ }).first().click();

    await page.getByRole('button', { name: 'New session' }).click();

    await expect(pickerTitle(page)).toBeVisible();
    // Exactly one state: the terminal and the meta bar are both gone.
    await expect(visibleTerminals(page)).toHaveCount(0);
    await expect(metaBar(page)).toHaveCount(0);
  });

  test('Escape restores the session that was underneath', async ({ page }) => {
    await page.getByRole('button', { name: /hero-refresh/ }).first().click();
    await page.getByRole('button', { name: 'New session' }).click();
    await expect(pickerTitle(page)).toBeVisible();

    await page.keyboard.press('Escape');

    // Not the orchestrator: the picker never touched `activeTab`.
    await expect(pickerTitle(page)).toHaveCount(0);
    await expect(
    stage(page).getByText('feat/hero-refresh', { exact: true }),
  ).toBeVisible();
    await expect(visibleTerminals(page)).toHaveCount(1);
  });

  test('leaves the terminal scrollback intact', async ({ page }) => {
    await page.getByRole('button', { name: /hero-refresh/ }).first().click();
    const terminal = page.locator('[data-terminal-id="hero-refresh"]');
    await expect(terminal.locator('.xterm')).toHaveCount(1);

    await page.getByRole('button', { name: 'New session' }).click();
    await page.keyboard.press('Escape');

    // One instance throughout — the picker hides the terminal region, it does
    // not unmount it.
    await expect(terminal.locator('.xterm')).toHaveCount(1);
    await expect(terminal).toContainText('swapped hardcoded hex');
  });
});

test('never lets the stage itself scroll', async ({ page }) => {
  await page.getByRole('button', { name: /hero-refresh/ }).first().click();

  const overflows = await stage(page).evaluate(
    (node) => node.scrollHeight > node.clientHeight,
  );

  // Only the terminal region scrolls. A stage-level scrollbar would mean the
  // meta bar could push the terminal out of view.
  expect(overflows).toBe(false);
});
