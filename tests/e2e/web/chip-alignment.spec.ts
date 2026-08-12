import { expect, test } from '@playwright/test';

/**
 * The `demo` chip starts on the left rail's trailing edge.
 *
 * Measured rather than asserted against a class name: the alignment is a
 * *relationship* between two components that do not import each other, and the
 * header's `w-[252px]` is only correct while `left-rail.tsx` is `w-[268px]`.
 * Comparing the rendered geometry is the only check that survives either one
 * being restyled.
 */
test('the demo chip begins where the left rail ends', async ({ page }) => {
  await page.goto('/?sim=0');

  const chip = page.getByText('demo', { exact: true });
  await expect(chip).toBeVisible();

  const railWidth = await page
    .locator('aside, nav')
    .first()
    .evaluate((element) => element.getBoundingClientRect().width);
  const chipBox = await chip.boundingBox();

  expect(chipBox).not.toBeNull();
  // The chip's left edge sits on the rail's right edge — the same vertical
  // line the center stage starts on.
  expect(Math.round(chipBox!.x)).toBe(Math.round(railWidth));
});

test('the chip stays on the header row and does not disturb the model chip', async ({
  page,
}) => {
  await page.goto('/?sim=0');

  const header = page.locator('header');
  await expect(header).toHaveCSS('height', '56px');

  // The centre track is what the header's grid exists to centre; widening the
  // left zone must not move it (story 083 — both side tracks size to the
  // wider side, and the right cluster is still the wider one).
  const headerBox = await header.boundingBox();
  const chip = page.getByText('demo', { exact: true });
  const chipBox = await chip.boundingBox();

  expect(chipBox!.y).toBeGreaterThanOrEqual(headerBox!.y);
  expect(chipBox!.y + chipBox!.height).toBeLessThanOrEqual(
    headerBox!.y + headerBox!.height,
  );
});
