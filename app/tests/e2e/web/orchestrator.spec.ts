import { expect, test, type Page } from '@playwright/test';

/**
 * Orchestrator console (stories 041, 070).
 *
 * The grammar itself is covered exhaustively by unit tests — parser and
 * executor both. What only a browser can show is that the table, the real
 * xterm transcript, and the command row are wired to the same state: type
 * `send lead-form y` here and the amber question in *that* session's terminal
 * gets answered.
 */

const APP_URL = '/?sim=0';

const stage = (page: Page) => page.getByRole('main');
const console_ = (page: Page) =>
  page.getByRole('textbox', { name: 'Orchestrator command' });
const orchTerminal = (page: Page) => page.locator('[data-terminal-id="orch"]');

const run = async (page: Page, command: string) => {
  await console_(page).fill(command);
  await console_(page).press('Enter');
};

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
});

test('renders the fleet table with its two groups', async ({ page }) => {
  // `exact` matters: the boot transcript also says "10 sessions".
  await expect(stage(page).getByText('SESSION', { exact: true })).toBeVisible();
  await expect(
    stage(page).getByText('PROJECT · BRANCH', { exact: true }),
  ).toBeVisible();

  // 8 active + 2 ended, the fixture split the story names. The divider says
  // ENDED rather than COMPLETED because the group now holds two different
  // endings — work that finished, and a process that quit (story 108).
  await expect(stage(page).getByText('ENDED')).toBeVisible();
  await expect(stage(page).getByText('apfm-web · feat/hero-refresh')).toBeVisible();
});

test('shows the command row and the hint bar together', async ({ page }) => {
  // The concept shows both in the orchestrator view; the hint bar is what says
  // the console is read-only.
  await expect(console_(page)).toBeVisible();
  await expect(stage(page).getByText('orchestrator ❯')).toBeVisible();
  await expect(
    stage(page).getByText('read-only — the orchestrator coordinates in the background'),
  ).toBeVisible();
});

test('echoes commands into the real terminal transcript', async ({ page }) => {
  await run(page, 'help');

  // Not a DOM log — this text is painted by xterm from the store transcript.
  await expect(orchTerminal(page)).toContainText('❯ help');
  await expect(orchTerminal(page)).toContainText('spawn <repo> <task>');
});

test('status lists every session with its state', async ({ page }) => {
  await run(page, 'status');

  await expect(orchTerminal(page)).toContainText('hero-refresh');
  await expect(orchTerminal(page)).toContainText('needs input');
});

test('reports an unknown command and points at help', async ({ page }) => {
  await run(page, 'frobnicate');

  await expect(orchTerminal(page)).toContainText('command not found: frobnicate');
});

test('clear empties the transcript', async ({ page }) => {
  await expect(orchTerminal(page)).toContainText('maestro v0.4.2');

  await run(page, 'clear');

  await expect(orchTerminal(page)).toContainText('console cleared');
  await expect(orchTerminal(page)).not.toContainText('maestro v0.4.2');
});

test('open switches the stage to that session', async ({ page }) => {
  await run(page, 'open webhooks');

  await expect(
    stage(page).getByText('feat/partner-webhooks', { exact: true }),
  ).toBeVisible();
});

test.describe('the send demo flow', () => {
  test('routes a message into the blocked session and resumes it', async ({
    page,
  }) => {
    // `lead-form` is the fixture parked on a permission prompt — the story's
    // payoff moment, driven entirely from the console.
    await run(page, 'send lead-form y');

    await expect(orchTerminal(page)).toContainText('routed → lead-form');

    await page.getByRole('button', { name: /lead-form/ }).first().click();
    const session = page.locator('[data-terminal-id="lead-form"]');
    await expect(session).toContainText('❯ [orchestrator] y');

    // After the acknowledgement delay the session reports itself working, on
    // its meta bar and everywhere else the status is derived.
    await expect(session).toContainText('Working…', { timeout: 10_000 });
    // The meta bar's chip has flipped from "needs input" to "working". The
    // fleet table is not on screen here — the stage shows one state at a time —
    // so this is the only place the word appears.
    await expect(stage(page).getByText('working', { exact: true })).toBeVisible();
    await expect(stage(page).getByText('needs input')).toHaveCount(0);
  });

  test('rejects a session that does not exist', async ({ page }) => {
    await run(page, 'send nope hello');

    await expect(orchTerminal(page)).toContainText('no such session: nope');
  });
});

test.describe('spawn', () => {
  test('creates a session on a known project and opens it', async ({ page }) => {
    await run(page, 'spawn apfm-web tidy the footer');

    // The new session opens immediately, with its seeded transcript.
    // Exact: the seeded transcript also contains `task: tidy the footer`.
    await expect(
      stage(page).getByText('tidy the footer', { exact: true }),
    ).toBeVisible();
  });

  test('rejects a repo that is not a project', async ({ page }) => {
    await run(page, 'spawn not-a-repo do things');

    await expect(orchTerminal(page)).toContainText('unknown repo: not-a-repo');
  });
});

test.describe('keyboard', () => {
  test('moves the selection with the arrow keys and opens with Enter', async ({
    page,
  }) => {
    await console_(page).focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    // Second row of nav order is `lead-form`.
    await expect(
      stage(page).getByText('fix/lead-form-validation', { exact: true }),
    ).toBeVisible();
  });

  test('sends typed text to the prompt rather than the selection', async ({
    page,
  }) => {
    await console_(page).focus();
    await page.keyboard.type('status');

    // Typing must not move the caret in the table.
    await expect(console_(page)).toHaveValue('status');
    await expect(console_(page)).toBeFocused();
  });
});
