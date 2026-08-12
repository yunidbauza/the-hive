import { expect, test } from '@playwright/test';

/**
 * The header's counts end where the activity rail begins (HIVE-79).
 *
 * The mirror image of `chip-alignment.spec.ts`, and measured for the same
 * reason: the alignment is a *relationship* between two components that do not
 * import each other. `header.tsx` sizes its control cluster from
 * `--cc-rail-w-right`, and that is only correct while `activity-rail.tsx` reads
 * the same token. Comparing rendered geometry is the only check that survives
 * either one being restyled — or the density changing, which moves the token
 * from 316px to 276px and would silently break a hardcoded assertion.
 */
test('the fleet counts end where the activity rail starts', async ({ page }) => {
  await page.goto('/?sim=0');

  const counts = page.getByTestId('status-counts');
  await expect(counts).toBeVisible();

  const rail = page.getByRole('complementary', { name: 'Activity' });
  await expect(rail).toBeVisible();

  const countsBox = await counts.boundingBox();
  const railBox = await rail.boundingBox();

  expect(countsBox).not.toBeNull();
  expect(railBox).not.toBeNull();

  /*
    Within a pixel, not exactly: the counts are text with a fractional advance
    width, and demanding an integer match would make this fail on a font
    fallback rather than on a layout regression.
  */
  expect(Math.abs(countsBox!.x + countsBox!.width - railBox!.x)).toBeLessThanOrEqual(1);
});

test('the controls sit over the rail rather than straddling its border', async ({
  page,
}) => {
  await page.goto('/?sim=0');

  const rail = page.getByRole('complementary', { name: 'Activity' });
  const railBox = await rail.boundingBox();
  const newSession = page.getByRole('button', { name: 'New session' });
  const buttonBox = await newSession.boundingBox();

  // Every control is inside the rail's column, which is what leaves the counts
  // a clean edge to end on.
  expect(buttonBox!.x).toBeGreaterThanOrEqual(railBox!.x - 1);
});

test('the counts stay on the header row', async ({ page }) => {
  await page.goto('/?sim=0');

  const header = page.locator('header');
  await expect(header).toHaveCSS('height', '56px');

  const headerBox = await header.boundingBox();
  const countsBox = await page.getByTestId('status-counts').boundingBox();

  // One line, inside the bar — the property `truncate` exists to guarantee.
  expect(countsBox!.y).toBeGreaterThanOrEqual(headerBox!.y);
  expect(countsBox!.y + countsBox!.height).toBeLessThanOrEqual(
    headerBox!.y + headerBox!.height,
  );
});

/**
 * Which zone gives when the header runs out of room.
 *
 * `model-chip.tsx` and `status-counts.tsx` both claim the chip is the thing
 * that shrinks; nothing measured it, and at one point the flex sizing did the
 * opposite. The counts carry no tooltip, so losing characters there loses
 * information outright — where the chip keeps its whole string in a `title`.
 */
test('the counts survive a narrow window intact', async ({ page }) => {
  await page.setViewportSize({ width: 1040, height: 800 });
  await page.goto('/?sim=0');

  const counts = page.getByTestId('status-counts');
  await expect(counts).toBeVisible();

  // Nothing ellipsised: the rendered text still carries every one of the four
  // numbers, and the element is not narrower than the text it holds.
  const text = (await counts.textContent()) ?? '';
  expect(text).toContain('working');
  expect(text).toContain('waiting');
  expect(text).toContain('idle');
  expect(text).toContain('ended');

  const clipped = await counts.evaluate(
    (el) => el.scrollWidth > el.clientWidth + 1,
  );
  expect(clipped).toBe(false);
});

test('the counts still end on the rail line when narrow', async ({ page }) => {
  await page.setViewportSize({ width: 1040, height: 800 });
  await page.goto('/?sim=0');

  const countsBox = await page.getByTestId('status-counts').boundingBox();
  const railBox = await page
    .getByRole('complementary', { name: 'Activity' })
    .boundingBox();

  expect(
    Math.abs(countsBox!.x + countsBox!.width - railBox!.x),
  ).toBeLessThanOrEqual(1);
});
