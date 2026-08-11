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
