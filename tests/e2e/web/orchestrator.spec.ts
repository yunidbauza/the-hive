import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The ledger verbs on the browser target (HIVE-113).
 *
 * Two claims a unit test cannot make, for the same reason: the transcript is
 * drawn by a real xterm, and `__mocks__/@xterm/` replaces the library wholesale
 * under vitest. The store suite proves which `TermLine`s were pushed; only a
 * browser proves they were *painted*, and the browser build renders with
 * xterm's DOM renderer, so the text is in the document to be read.
 *
 * The refusals matter here rather than anywhere else. There is no desktop
 * bridge in this target, so `ask` and `answer` have nothing to write to and
 * `ledger` has an empty mirror — and the failure this guards against is not an
 * error but a *silence*: a verb that parsed, did nothing, and said nothing.
 */

const APP_URL = '/?sim=0';

const console_ = (page: Page): Locator =>
  page.getByRole('textbox', { name: 'Overmind command' });

const transcript = (page: Page): Locator => page.getByRole('main').locator('.xterm');

const run = async (page: Page, command: string): Promise<void> => {
  const field = console_(page);
  await field.click();
  await field.fill(command);
  await field.press('Enter');
};

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
  await page.waitForSelector('header');
  await expect(transcript(page)).toBeVisible();
});

/**
 * `help` is the only place the grammar is discoverable without already knowing
 * it exists, so a verb missing from it is a verb nobody finds.
 */
test('help lists the ledger verbs with their arguments', async ({ page }) => {
  await run(page, 'help');

  const rows = transcript(page);
  await expect(rows).toContainText('ledger [--open]');
  // `<agent>`, since HIVE-126 gave every verb one target type: a session has a
  // terminal you can open and read, so a question to one is `send`.
  await expect(rows).toContainText('ask <agent> <message>');
  await expect(rows).toContainText('answer <id> <text>');
});

for (const command of ['ledger', 'ask sess-a hello', 'answer a12 main']) {
  test(`${command} refuses without the desktop app`, async ({ page }) => {
    await run(page, command);

    await expect(transcript(page)).toContainText('needs the desktop app');
  });
}

/**
 * The echo is not the answer.
 *
 * A verb that only echoed what was typed would satisfy a naive "the text is on
 * screen" assertion, because `❯ ledger` contains the word. This pins the
 * refusal as a line of its own, after the echo.
 */
test('the refusal is a line of its own, not just the echo', async ({ page }) => {
  await run(page, 'ledger');

  /*
    Settle first. `innerText()` is a single non-retrying read, so without an
    auto-retrying assertion ahead of it this races xterm's paint — it passed
    alone and failed under a loaded parallel run, which is the signature.
  */
  await expect(transcript(page)).toContainText('needs the desktop app');

  const text = (await transcript(page).innerText()).split('\n');
  const echo = text.findIndex((row) => row.includes('ledger') && row.includes('❯'));
  const refusal = text.findIndex((row) => row.includes('needs the desktop app'));

  expect(echo).toBeGreaterThanOrEqual(0);
  expect(refusal).toBeGreaterThan(echo);
});
