import { expect, test, type Page } from '@playwright/test';

/**
 * The new-session picker (stories 044, 070).
 *
 * The acceptance criterion is a *keyboard path*: New session → type a query →
 * Enter → a live terminal, hands never leaving the keyboard. That is a claim
 * about focus moving correctly through a modal, which only a browser can check.
 */

const APP_URL = '/?sim=0';

const stage = (page: Page) => page.getByRole('main');
const search = (page: Page) =>
  page.getByRole('textbox', { name: 'Search all projects' });
const openPicker = async (page: Page) => {
  await page.getByRole('button', { name: 'New session' }).click();
  await expect(search(page)).toBeVisible();
};

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
});

test('opens from the header with the search box already focused', async ({
  page,
}) => {
  await openPicker(page);

  await expect(stage(page).getByText('Start a new session')).toBeVisible();
  await expect(search(page)).toBeFocused();
});

test('the full keyboard path produces a live terminal', async ({ page }) => {
  await openPicker(page);

  await page.keyboard.type('referral');
  await page.keyboard.press('Enter');

  // A real xterm, seeded and open, without the mouse having been touched.
  const terminal = page.locator('[data-terminal-id="sess-01"]');
  await expect(terminal).toBeVisible();
  await expect(terminal).toContainText('new session on referral-api');
  await expect(terminal).toContainText(
    '· Ready — type below to give this session its task',
  );

  // And the message row is focused, so the next keystroke is the first task.
  await expect(page.getByRole('textbox', { name: 'Message sess-01' })).toBeFocused();
});

test('filters projects as you type, case-insensitively', async ({ page }) => {
  await openPicker(page);

  await page.keyboard.type('TERRA');

  await expect(
    stage(page).getByRole('button', { name: /^infra-terraform \d+ active$/ }),
  ).toBeVisible();
  await expect(
    stage(page).getByRole('button', { name: /^apfm-web \d+ active$/ }),
  ).toHaveCount(0);
});

test('says when nothing matches, and Enter does nothing', async ({ page }) => {
  await openPicker(page);

  await page.keyboard.type('nonsense');
  await expect(stage(page).getByText('no projects match "nonsense"')).toBeVisible();

  await page.keyboard.press('Enter');

  // Still on the picker: Enter means "the one I can see", and there is none.
  await expect(search(page)).toBeVisible();
});

test('a pinned pill starts a session in one click', async ({ page }) => {
  await openPicker(page);

  // `exact`: Playwright matches accessible names by substring, so without it
  // the pill and the search row ("design-system 1 active") both match.
  await stage(page)
    .getByRole('button', { name: 'design-system', exact: true })
    .click();

  await expect(page.locator('[data-terminal-id="sess-01"]')).toBeVisible();
  await expect(stage(page).getByText('feat/sess-01', { exact: true })).toBeVisible();
});

test('model and effort choices persist across openings', async ({ page }) => {
  await openPicker(page);
  await stage(page).getByRole('radio', { name: 'sonnet' }).click();
  await stage(page).getByRole('radio', { name: 'low' }).click();

  await page.keyboard.press('Escape');
  await openPicker(page);

  // Held in the store, so reopening cannot silently reset a deliberate choice.
  await expect(stage(page).getByRole('radio', { name: 'sonnet' })).toBeChecked();
  await expect(stage(page).getByRole('radio', { name: 'low' })).toBeChecked();
});

test('the steppers are arrow-key operable and cost one tab stop each', async ({
  page,
}) => {
  await openPicker(page);
  const radio = (name: string) => stage(page).getByRole('radio', { name });

  await radio('opus').focus();
  await page.keyboard.press('ArrowRight');

  await expect(radio('fable')).toBeChecked();
  // Focus follows selection, so the next arrow continues from here.
  await expect(radio('fable')).toBeFocused();

  // Clamped at the end rather than wrapping round to `haiku`.
  await page.keyboard.press('ArrowRight');
  await expect(radio('fable')).toBeChecked();

  /**
   * Tabbing out of the group lands on the *next* group, not on another model
   * dot — which is the observable proof of the roving tabindex. Without it a
   * keyboard user would pay four tab stops per stepper.
   */
  await page.keyboard.press('Tab');
  await expect(radio('high')).toBeFocused();
});

test('the chosen model reaches the spawned session', async ({ page }) => {
  await openPicker(page);
  await stage(page).getByRole('radio', { name: 'haiku' }).click();
  await stage(page).getByRole('radio', { name: 'max' }).click();

  await search(page).focus();
  await page.keyboard.type('advisor');
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-terminal-id="sess-01"]')).toContainText(
    '--model haiku --effort max',
  );
});

test('Escape restores exactly the previous view', async ({ page }) => {
  await page.getByRole('button', { name: /hero-refresh/ }).first().click();
  await expect(stage(page).getByText('feat/hero-refresh', { exact: true })).toBeVisible();

  await openPicker(page);
  await page.keyboard.press('Escape');

  // Not the orchestrator — the picker never touched `activeTab`.
  await expect(
    stage(page).getByText('feat/hero-refresh', { exact: true }),
  ).toBeVisible();
});

test('a spawned session appears everywhere derived state says it should', async ({
  page,
}) => {
  await openPicker(page);
  await page.keyboard.type('referral');
  await page.keyboard.press('Enter');

  // Left rail: the project's session list and its count.
  const rail = page.getByRole('navigation', { name: 'Projects, work, and agents' });
  // Exact: the row also renders the branch, `feat/sess-01`.
  await expect(rail.getByText('sess-01', { exact: true })).toBeVisible();

  // Orchestrator table and console transcript.
  await page.getByRole('button', { name: 'Back to orchestrator' }).click();
  await expect(
    stage(page).getByText('referral-api · feat/sess-01'),
  ).toBeVisible();
  await expect(page.locator('[data-terminal-id="orch"]')).toContainText(
    'spawned sess-01 on referral-api',
  );
});
