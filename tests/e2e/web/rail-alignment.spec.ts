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

/**
 * Resizable rails (HIVE-105).
 *
 * The clamp is proved arithmetically in `tests/lib/rail-width.test.ts`. What
 * only a browser can show is that the arithmetic actually reaches the screen:
 * happy-dom performs no layout, so a unit test can assert what
 * `--cc-rail-w-left` was set to but never what the rail *measures*, and the
 * stage's real share of the window is the one thing this feature promises.
 */
test.describe('resizing a rail', () => {
  /** Drag a slider with the keyboard — no pointer geometry to get wrong. */
  const widen = async (
    page: import('@playwright/test').Page,
    name: string,
    key: string,
    presses: number,
  ) => {
    const handle = page.getByRole('slider', { name });
    await handle.focus();
    for (let i = 0; i < presses; i += 1) await handle.press(key);
  };

  const stageShare = async (page: import('@playwright/test').Page) => {
    const stage = await page.getByRole('main').boundingBox();
    const width = page.viewportSize()!.width;
    return stage!.width / width;
  };

  test('a rail actually grows when its handle is dragged', async ({ page }) => {
    await page.goto('/?sim=0');

    const rail = page.getByRole('navigation', { name: 'Projects, work, and agents' });
    const before = (await rail.boundingBox())!.width;

    await widen(page, 'Resize the navigation rail', 'ArrowRight', 5);

    const after = (await rail.boundingBox())!.width;
    expect(after).toBeGreaterThan(before);
    // Five 8px steps.
    expect(after - before).toBeCloseTo(40, 0);
  });

  /**
   * **The invariant, measured.** Both rails dragged as far as they will go, and
   * the terminal still holds a fifth of the window.
   */
  test('the stage keeps its fifth with both rails dragged to the stop', async ({
    page,
  }) => {
    await page.goto('/?sim=0');

    await widen(page, 'Resize the navigation rail', 'ArrowRight', 60);
    await widen(page, 'Resize the activity rail', 'ArrowLeft', 60);

    expect(await stageShare(page)).toBeGreaterThanOrEqual(0.2);
  });

  /**
   * The header's cluster is sized from `--cc-rail-w-right`, so a rail that
   * moves without it is a visible misalignment. The two specs at the top of
   * this file assert that relationship at the default width; this asserts it
   * survives a resize, which is the case HIVE-105 could newly break.
   */
  test('the header stays aligned to a resized activity rail', async ({ page }) => {
    await page.goto('/?sim=0');

    await widen(page, 'Resize the activity rail', 'ArrowLeft', 10);

    const countsBox = await page.getByTestId('status-counts').boundingBox();
    const railBox = await page
      .getByRole('complementary', { name: 'Activity' })
      .boundingBox();

    expect(
      Math.abs(countsBox!.x + countsBox!.width - railBox!.x),
    ).toBeLessThanOrEqual(1);
  });

  test('a double-click returns the rail to its default width', async ({ page }) => {
    await page.goto('/?sim=0');

    const rail = page.getByRole('navigation', { name: 'Projects, work, and agents' });
    const before = (await rail.boundingBox())!.width;

    await widen(page, 'Resize the navigation rail', 'ArrowRight', 5);
    expect((await rail.boundingBox())!.width).toBeGreaterThan(before);

    await page.getByRole('slider', { name: 'Resize the navigation rail' }).dblclick();

    expect((await rail.boundingBox())!.width).toBeCloseTo(before, 0);
  });

  /** The width is in `localStorage`, so it has to come back with the page. */
  test('a resized rail survives a reload', async ({ page }) => {
    await page.goto('/?sim=0');

    const rail = page.getByRole('navigation', { name: 'Projects, work, and agents' });
    await widen(page, 'Resize the navigation rail', 'ArrowRight', 5);
    const resized = (await rail.boundingBox())!.width;

    await page.reload();

    expect((await rail.boundingBox())!.width).toBeCloseTo(resized, 0);
  });

  /**
   * The terminal refits *during* the gesture, not on release. The stage owns
   * `min-w-0` and xterm's fit addon reacts to the resize that follows, so this
   * is really asserting that chain is unbroken — a fit that only settled on
   * pointer-up would be a visibly different feature.
   */
  test('the terminal follows the rail mid-drag', async ({ page }) => {
    await page.goto('/?sim=0');

    const screenEl = page.locator('.xterm-screen').first();
    await expect(screenEl).toBeVisible();
    const before = (await screenEl.boundingBox())!.width;

    const handle = page.getByRole('slider', { name: 'Resize the navigation rail' });
    const box = (await handle.boundingBox())!;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 10 });

    // Measured before the button is released — that is the whole point.
    await expect
      .poll(async () => (await screenEl.boundingBox())!.width)
      .toBeLessThan(before);

    await page.mouse.up();
  });
});

/**
 * A resize seam offers a resize cursor.
 *
 * Asserted in a real browser because this is a *cascade* fact, not a markup
 * one: `split-handle.tsx` has always written `cursor-col-resize`, and happy-dom
 * loads no stylesheet, so a unit test could only re-read the class name it was
 * given. What actually decided the cursor was layering — the pointer-cursor
 * default in `global.css` was unlayered, and unlayered CSS outranks every
 * `@layer`, so Tailwind's utility lost and both rails offered a pointing hand.
 * Only a computed style catches that, and only in a browser.
 */
test.describe('the resize handles', () => {
  const cursorOf = (page: import('@playwright/test').Page, name: string) =>
    page
      .getByRole('slider', { name })
      .evaluate((el) => getComputedStyle(el).cursor);

  test('offer a horizontal resize cursor, not a pointer', async ({ page }) => {
    await page.goto('/?sim=0');

    expect(await cursorOf(page, 'Resize the navigation rail')).toBe('col-resize');
    expect(await cursorOf(page, 'Resize the activity rail')).toBe('col-resize');
  });

  /**
   * The hit area is a child `<span>` five times wider than the hairline, and it
   * is what the pointer is actually over for four of those five pixels. `cursor`
   * inherits, so it needs no rule of its own — but a future `cursor-*` on the
   * span, or a reset that stops the inheritance, would leave the visible target
   * and the cursor disagreeing.
   */
  test('carry the cursor across the whole hit area', async ({ page }) => {
    await page.goto('/?sim=0');

    const hitArea = page
      .getByRole('slider', { name: 'Resize the navigation rail' })
      .locator('span');

    expect(await hitArea.evaluate((el) => getComputedStyle(el).cursor)).toBe(
      'col-resize',
    );
  });
});

/**
 * Collapsing a rail must not reflow the header (HIVE rail-collapse follow-up).
 *
 * The header sizes two zones from the rails' width tokens so its content lines
 * up with the rails' edges. Collapse paints those tokens at 44px, and both
 * obvious responses to that are wrong: claim the 44px column and a `shrink-0`
 * cluster overflows it onto its neighbour; drop the column and the zone
 * shrinks to its content, letting the neighbour slide over. The app shipped
 * each of those bugs in turn — the chips ended flush against the wordmark, and
 * the counts flush against the theme button.
 *
 * `--cc-rail-w-*-open` is the fix: the same width with collapse ignored. What
 * that buys is a *relationship* — the gaps either side of the header's content
 * are the same whether a rail is open or shut — and a relationship between
 * rendered boxes is only measurable here. `happy-dom` performs no layout, so
 * the unit tests can assert which class is applied and never that two elements
 * stopped touching.
 */
test.describe('the header holds still when a rail collapses', () => {
  /** Distance from the wordmark to the first chip, and counts to theme button. */
  const gaps = (page: import('@playwright/test').Page) =>
    page.evaluate(() => {
      const header = document.querySelector('header')!;
      const brandZone = header.querySelector('div')?.firstElementChild;
      const wordmark = brandZone?.firstElementChild ?? brandZone;
      const chips = header.querySelector('[data-testid="header-chips"]');
      const counts = header.querySelector('[data-testid="status-counts"]');
      const theme = header.querySelector('button[aria-label*="theme" i]');

      const w = wordmark?.getBoundingClientRect();
      const ch = chips?.getBoundingClientRect();
      const c = counts?.getBoundingClientRect();
      const t = theme?.getBoundingClientRect();

      return {
        wordmarkToChips: w && ch ? Math.round(ch.left - w.right) : null,
        countsToTheme: c && t ? Math.round(t.left - c.right) : null,
      };
    });

  test('the gap either side of the header survives a collapse', async ({ page }) => {
    await page.goto('/?sim=0');

    const leftRail = page.getByRole('navigation', { name: 'Projects, work, and agents' });
    const rightRail = page.getByRole('complementary', { name: 'Activity' });
    await expect(leftRail).toBeVisible();
    await expect(rightRail).toBeVisible();

    const open = await gaps(page);

    /*
      Both gaps must be real before the comparison means anything. Zero on
      either side would make "unchanged" trivially true — and zero is precisely
      what the bug produced, so an unguarded equality check would have passed
      against the broken build.
    */
    expect(open.wordmarkToChips).toBeGreaterThan(0);
    expect(open.countsToTheme).toBeGreaterThan(0);

    // Clicking an already-active tab collapses its rail: Projects on the left,
    // Inbox on the right, are the two defaults.
    await page.getByRole('tab', { name: /Projects/ }).click();
    await expect(leftRail).toHaveCSS('width', '44px');
    await page.getByRole('tab', { name: /^Inbox/ }).click();
    await expect(rightRail).toHaveCSS('width', '44px');

    expect(await gaps(page)).toEqual(open);
  });
});
