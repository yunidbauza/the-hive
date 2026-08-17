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
