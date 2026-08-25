import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The overmind prompt grows as it fills, and stops.
 *
 * A browser-only claim, and unavoidably so: `useAutoGrow` measures
 * `scrollHeight` and a computed line height, and happy-dom performs no layout,
 * so under a unit test every one of those numbers is `0` or `NaN`. The unit
 * suite can prove the hook is wired up and that it never writes a nonsense
 * height; only a real layout engine can prove the row actually changes size.
 *
 * Which makes this the half of the story the user can see. "The textarea should
 * increase in size" is a claim about pixels, and pixels are measured here.
 */

const APP_URL = '/?sim=0';

const console_ = (page: Page): Locator =>
  page.getByRole('textbox', { name: 'Overmind command' });

const heightOf = async (field: Locator): Promise<number> => {
  const box = await field.boundingBox();
  if (!box) throw new Error('the console row is not laid out');
  return box.height;
};

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
  await page.waitForSelector('header');
});

test('Shift+Enter adds a line and the row grows to match', async ({ page }) => {
  const field = console_(page);
  await field.click();

  const oneLine = await heightOf(field);

  await page.keyboard.type('first');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('second');

  // The value gained a line break rather than being submitted and cleared.
  await expect(field).toHaveValue('first\nsecond');

  const twoLines = await heightOf(field);
  expect(twoLines).toBeGreaterThan(oneLine);
});

test('the row shrinks back when the lines are removed', async ({ page }) => {
  /**
   * The ratchet this could so easily have been. `scrollHeight` reports the
   * content height *or the element's own height, whichever is larger*, so a
   * hook that measures without first clearing `height` can only ever grow the
   * row — leaving a prompt permanently ten lines tall after one long paste.
   */
  const field = console_(page);
  await field.click();

  const oneLine = await heightOf(field);

  await page.keyboard.type('a');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('b');
  expect(await heightOf(field)).toBeGreaterThan(oneLine);

  await field.fill('a');

  expect(await heightOf(field)).toBe(oneLine);
});

test('a narrowed row re-measures instead of clipping in silence', async ({ page }) => {
  /**
   * Height depends on content **and** width, but only the content is a React
   * `value`. Narrow the window after the row has been sized and the same text
   * needs more height than it has — and because the hook pins `overflow-y`, the
   * failure is not a scrollbar but *silent clipping*: the element keeps its old
   * height with the overflow hidden, and most of a draft becomes unreachable
   * with nothing on screen to say so.
   *
   * Reproduced by resizing rather than typing, because typing would change
   * `value` and mask the bug behind the dependency that already works.
   */
  const field = console_(page);
  await field.click();

  await field.fill(
    'a reasonably long instruction that will certainly wrap once the pane narrows',
  );

  await page.setViewportSize({ width: 900, height: 800 });

  // The assertion the old code failed: content taller than the box, with the
  // overflow hidden, is text the user cannot reach by any means.
  const clipped = await field.evaluate((el) => ({
    scroll: el.scrollHeight,
    client: el.clientHeight,
    overflowY: getComputedStyle(el).overflowY,
  }));

  expect(clipped.overflowY === 'hidden' && clipped.scroll > clipped.client).toBe(
    false,
  );
});

test('the arrows edit a soft-wrapped command instead of moving the selection', async ({
  page,
}) => {
  /**
   * The guard keyed on `value.includes('\n')` until review caught this: a long
   * command with no newline in it still **wraps** onto a second row, and the
   * caret then has somewhere to go that the string knows nothing about. Keying
   * on the text re-created the exact trap the guard exists to prevent.
   *
   * Browser-only, necessarily — soft wrap is a layout outcome, and happy-dom
   * has no layout to produce one.
   */
  const field = console_(page);
  await field.click();

  const oneLine = await heightOf(field);

  // Long enough to wrap at the default width, and deliberately free of any
  // newline — the whole point is that the string looks single-line.
  const command = `spawn nova-web ${'rework the onboarding flow and its empty states '.repeat(4)}`;
  await field.fill(command);

  // Premise check: it really did wrap. Without this the test passes vacuously.
  expect(await heightOf(field)).toBeGreaterThan(oneLine);

  const atEnd = await field.evaluate(
    (el: HTMLTextAreaElement) => el.selectionStart,
  );
  await page.keyboard.press('ArrowUp');
  const afterUp = await field.evaluate(
    (el: HTMLTextAreaElement) => el.selectionStart,
  );

  /**
   * The precise claim: the key was **not** `preventDefault`ed, so the browser
   * moved the caret up a visual row. Had the guard still keyed on `\n`, the
   * console would have swallowed it to move the fleet selection and the caret
   * would have stayed pinned at the end.
   */
  expect(afterUp).toBeLessThan(atEnd);
  await expect(field).toHaveValue(command);
});

test('growth stops at the cap instead of swallowing the stage', async ({ page }) => {
  /**
   * The cap exists because this row takes its height out of the terminal above
   * it. Uncapped, a pasted stack trace pushes the thing the user is actually
   * watching off the top of the screen.
   *
   * Asserted as a *ratio* rather than a pixel count: the row is styled to the
   * terminal font size, which is a user setting, so a hard-coded height here
   * would be a second place to update and would fail for a reason that has
   * nothing to do with this story. Twenty lines is comfortably past the ten-row
   * cap, so a row that still tracked its content would be about twice as tall.
   */
  const field = console_(page);
  await field.click();

  const oneLine = await heightOf(field);

  await field.fill(
    Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n'),
  );

  const capped = await heightOf(field);

  expect(capped).toBeLessThan(oneLine * 14);
  // …and it did grow: a row stuck at one line would be a different bug.
  expect(capped).toBeGreaterThan(oneLine * 5);
});
