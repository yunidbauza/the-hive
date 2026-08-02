import { expect, test } from '@playwright/test';

/**
 * Smoke — the shell renders in a real browser (story 070).
 *
 * The narrowest useful claim: a production build boots, React mounts, and the
 * three-column chrome is present and laid out. Everything else in the E2E suite
 * assumes this, so when the app is broken outright this is the spec that should
 * say so first.
 *
 * Locators are role- and text-based per story 070's selector policy. The shell
 * is built from real landmarks — `header`, `nav[aria-label]`, `main`,
 * `aside[aria-label]` — so no `data-testid` is needed here, and coupling to
 * Tailwind classes is banned.
 */

/**
 * `?sim=0` on every navigation. Simulation replays a scripted event stream on
 * timers (story 061); with it on, counts and statuses change underneath the
 * assertions. It defaults to off today — `SIMULATION_ENABLED` is `sim === '1'`
 * — but pinning it explicitly means this spec keeps its determinism when 061
 * flips a default or adds a persisted preference.
 */
const APP_URL = '/?sim=0';

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
});

test('renders the three-column shell', async ({ page }) => {
  await expect(page).toHaveTitle('The Hive');

  // Header, both rails, center stage — the four regions of story 020.
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Projects, work, and agents' }),
  ).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Activity' })).toBeVisible();
});

test('renders the header chrome', async ({ page }) => {
  const header = page.getByRole('banner');

  await expect(header.getByText('The Hive')).toBeVisible();
  await expect(header.getByText('APFM Engineering')).toBeVisible();
  await expect(header.getByRole('button', { name: 'New session' })).toBeVisible();

  /**
   * The theme toggle names the theme it switches *to*, so its accessible name
   * is the one observable proof of which theme booted. Dark is the default.
   */
  await expect(header.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
});

/**
 * The model chip sits at the header's true midpoint (story 021).
 *
 * This is the assertion the unit suite structurally cannot make: happy-dom
 * performs no layout, so `header.test.tsx` can only prove the grid *markup*
 * exists. Whether the chip actually lands in the middle is a measurement, and
 * measurement needs a browser.
 *
 * The failure it exists to catch is the plausible-looking one — centring the
 * chip with flex spacers instead of equal `1fr` tracks. That centres the gap
 * between two unequal clusters (brand ~180px, controls ~350px) and leaves the
 * chip roughly 85px right of centre, which looks almost right and is wrong.
 */
test('centres the model chip on the header itself', async ({ page }) => {
  // The chip is conditional on a *session* being active; the orchestrator the
  // app boots into deliberately has no model of its own.
  await page.getByRole('button', { name: /hero-refresh/ }).first().click();

  const header = page.getByRole('banner');

  /**
   * By title, not by text: the title is on the pill, while the text lives in an
   * inner truncating span that is inset by the pill's padding and its brain
   * icon. Measuring the span would measure the wrong box — off-centre by design
   * — so the pill is what has to be asserted on.
   */
  const chip = header.getByTitle(/Opus 4\.5 \(1M\)/);
  await expect(chip).toBeVisible();

  const headerBox = await header.boundingBox();
  const chipBox = await chip.boundingBox();
  expect(headerBox).not.toBeNull();
  expect(chipBox).not.toBeNull();

  const headerMid = headerBox!.x + headerBox!.width / 2;
  const chipMid = chipBox!.x + chipBox!.width / 2;

  // 2px, not 0: sub-pixel track sizing rounds, and an exact equality here would
  // be flaky for a reason that has nothing to do with the layout being right.
  expect(Math.abs(chipMid - headerMid)).toBeLessThanOrEqual(2);
});

/**
 * Centring is only correct if it does not cost anything invisible — the chip
 * must clear both side zones rather than sit on top of them, must show its full
 * string, and must not push the header off one line. A chip that centred by
 * overlapping the wordmark, or by reflowing the fleet counts onto a second row
 * inside a 56px bar, would pass the midpoint assertion above and still be
 * plainly broken. That second failure is not hypothetical: the counts wrap by
 * default, and letting them was how the layout first paid for its own centring.
 */
test('centres the chip without overlapping or reflowing the side zones', async ({
  page,
}) => {
  await page.getByRole('button', { name: /hero-refresh/ }).first().click();

  const header = page.getByRole('banner');
  const chip = header.getByTitle(/Opus 4\.5 \(1M\)/);
  const brand = header.getByText('The Hive');
  const newSession = header.getByRole('button', { name: 'New session' });
  const counts = header.getByTitle(/working · .* waiting/);

  const [chipBox, brandBox, buttonBox, countsBox] = await Promise.all([
    chip.boundingBox(),
    brand.boundingBox(),
    newSession.boundingBox(),
    counts.boundingBox(),
  ]);

  expect(chipBox!.x).toBeGreaterThan(brandBox!.x + brandBox!.width);
  expect(chipBox!.x + chipBox!.width).toBeLessThan(buttonBox!.x);

  /**
   * One line of 12px mono is 16px tall; two are 32. Asserting under 20 catches
   * the wrap without pinning the exact line-height.
   */
  expect(countsBox!.height).toBeLessThan(20);

  /**
   * The chip is the zone centring exists to serve, so it keeps its full string
   * even at the width where the header is over budget. Equal scrollWidth and
   * clientWidth is the observable proof nothing is clipped.
   */
  const chipClipped = await chip.evaluate((el) => {
    const span = el.querySelector('span')!;
    return span.scrollWidth > span.clientWidth;
  });
  expect(chipClipped).toBe(false);

  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
});

/**
 * The trade-off, pinned so it cannot drift silently.
 *
 * At 1440 a truly centred chip costs 113px the bar does not have — equal side
 * tracks both size to the wider side, so the layout needs `2 × controls + chip`
 * (2×517 + 459 = 1493) against 1380px of track. The counts pay it, ellipsising
 * from the tail. Give the header ~1553px and the deficit is gone entirely.
 *
 * Both halves are asserted here rather than only the happy one: a regression
 * that stopped truncating at 1440 would mean the chip started paying instead,
 * and a regression that kept truncating at 1600 would mean the counts never
 * recover on the monitors this app is actually run on.
 */
test('spends the header deficit on the counts, and stops once it is gone', async ({
  page,
}) => {
  await page.getByRole('button', { name: /hero-refresh/ }).first().click();

  const counts = page.getByRole('banner').getByTitle(/working · .* waiting/);
  const truncated = () =>
    counts.evaluate((el) => el.scrollWidth > el.clientWidth);

  expect(await truncated()).toBe(true);

  await page.setViewportSize({ width: 1600, height: 900 });
  expect(await truncated()).toBe(false);

  // …and the chip is still centred at the wider width, not merely at 1440.
  const header = page.getByRole('banner');
  const chip = header.getByTitle(/Opus 4\.5 \(1M\)/);
  const [headerBox, chipBox] = await Promise.all([
    header.boundingBox(),
    chip.boundingBox(),
  ]);
  const offset = Math.abs(
    chipBox!.x + chipBox!.width / 2 - (headerBox!.x + headerBox!.width / 2),
  );
  expect(offset).toBeLessThanOrEqual(2);
});

/**
 * The rails are fixed-width and the center column absorbs every resize (story
 * 020), which is what keeps the terminal the only thing that changes size. A
 * document-level horizontal scrollbar means that contract broke — usually a
 * missing `min-w-0` letting a long line widen the center column.
 */
test('lays out at desktop width without overflowing horizontally', async ({ page }) => {
  /**
   * Named, not bare `getByRole('navigation')`. Stories 030 and 050 build tab
   * bars and panels *inside* these rails; a nested `nav` or `aside` would make
   * a bare role locator match two elements and fail strict mode — breaking this
   * spec for a reason that has nothing to do with what it asserts.
   */
  await expect(
    page.getByRole('navigation', { name: 'Projects, work, and agents' }),
  ).toHaveCSS('width', '268px');
  await expect(page.getByRole('complementary', { name: 'Activity' })).toHaveCSS(
    'width',
    '316px',
  );

  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
});

/**
 * The one assertion no unit test in this repo can make. `__mocks__/@xterm/`
 * replaces the library wholesale — happy-dom cannot run it — so every unit test
 * asserts plumbing against a recording fake. Whether a real xterm boots,
 * measures its container and lays out is unfalsifiable outside a browser.
 *
 * On the renderer: xterm 6 core ships the **DOM** renderer by default and
 * neither `@xterm/addon-canvas` nor `@xterm/addon-webgl` is installed, so the
 * live instance renders as `.xterm-dom-renderer-owner-*` with zero canvas
 * elements. Story 042 has since landed and deliberately kept it that way — a
 * WebGL renderer is listed out of scope there — and corrected the docs that
 * called the terminal a canvas. If a renderer addon ever arrives, this is the
 * spec that should fail and be updated deliberately.
 *
 * Depth beyond "it booted" — colours, selection, scrollback, refit, re-theming
 * — lives in `terminal.spec.ts`.
 */
test('mounts a live xterm instance that has measured its container', async ({ page }) => {
  const terminal = page.getByRole('main').locator('.xterm');

  await expect(terminal).toBeVisible();

  /**
   * Non-zero dimensions prove the fit addon measured a real box. This is the
   * assertion happy-dom can never make: it performs no layout, so every element
   * there reports 0×0 regardless of whether the code is correct.
   */
  const box = await terminal.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);

  /**
   * Rows are the output of that measurement — xterm derives the row count from
   * the fitted container height. A terminal that mounted but never fit renders
   * a viewport with no rows in it.
   */
  await expect(terminal.locator('.xterm-rows > div').first()).toBeAttached();

  /** xterm's input target, and the surface keyboard specs (story 060) drive. */
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeAttached();
});
