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
 * The model chip starts on the left rail's trailing edge.
 *
 * It used to be centred on the header's true midpoint (story 021). That was
 * deliberate and correct at the time; the design has since moved both header
 * chips to the left, onto the vertical line the center stage begins on, so the
 * midpoint assertion this replaces would now be asserting the opposite of the
 * intent.
 *
 * Still a measurement rather than a markup check: happy-dom performs no layout,
 * so `header.test.tsx` can only prove the structure exists. Whether the chip
 * actually lands on the rail's edge needs a browser.
 */
test('starts the model chip on the left rail edge, not the header midpoint', async ({
  page,
}) => {
  // The chip is conditional on a *session* being active; the orchestrator the
  // app boots into deliberately has no model of its own.
  await page.getByRole('button', { name: /hero-refresh/ }).first().click();

  const header = page.getByRole('banner');

  /**
   * By title, not by text: the title is on the pill, while the text lives in an
   * inner truncating span inset by the pill's padding and its brain icon.
   * Measuring the span would measure the wrong box.
   */
  const chip = header.getByTitle(/Opus 4\.5 \(1M\)/);
  await expect(chip).toBeVisible();

  const railWidth = await page
    .locator('nav')
    .first()
    .evaluate((element) => element.getBoundingClientRect().width);
  const chipBox = await chip.boundingBox();
  expect(chipBox).not.toBeNull();

  /**
   * The **cluster** starts on the rail's edge, and whichever chip comes first
   * starts there. This is the browser build, so that is the `demo` chip and the
   * model chip follows it; on desktop there is no `demo` chip and the model
   * chip lands on the line itself (asserted in the electron suite).
   */
  const clusterX = await page
    .getByTestId('header-chips')
    .evaluate((element) => element.getBoundingClientRect().x);
  expect(Math.round(clusterX)).toBe(Math.round(railWidth));

  // The model chip sits just right of the demo chip, still far left of centre.
  expect(chipBox!.x).toBeGreaterThanOrEqual(railWidth);

  // And explicitly NOT centred, so this test cannot quietly pass if the old
  // grid came back.
  const headerBox = await header.boundingBox();
  const headerMid = headerBox!.x + headerBox!.width / 2;
  const chipMid = chipBox!.x + chipBox!.width / 2;
  expect(Math.abs(chipMid - headerMid)).toBeGreaterThan(2);
});

/**
 * Moving the chip left is only correct if it does not cost anything invisible —
 * it must clear the wordmark rather than sit on top of it, must not collide
 * with the controls, and must not push the header off one line. A chip that
 * overlapped the brand, or reflowed the fleet counts onto a second row inside a
 * 56px bar, would pass the alignment assertion above and still be plainly
 * broken. That second failure is not hypothetical: the counts wrap by default.
 */
test('places the chip without overlapping or reflowing the side zones', async ({
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

  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
});

/**
 * When the header runs out of width, the **model chip** is what gives.
 *
 * This inverted when the chips moved left. Under the old centred grid the
 * fleet counts absorbed the deficit, because the chip was the thing being
 * centred and could not be allowed to move. Now the left cluster is `min-w-0`
 * and the controls do not shrink, which is the right way round: the chip
 * already truncates by design and carries its full text in a `title`, while
 * the counts have no tooltip and would simply lose information.
 *
 * Both halves are asserted rather than only the happy one — a regression that
 * started truncating the counts again would mean the priority flipped back.
 */
test('spends the header deficit on the model chip, never on the counts', async ({
  page,
}) => {
  await page.getByRole('button', { name: /hero-refresh/ }).first().click();

  const header = page.getByRole('banner');
  const counts = header.getByTitle(/working · .* waiting/);
  const chipText = header.getByTitle(/Opus 4\.5 \(1M\)/).locator('span');

  const clipped = (locator: ReturnType<typeof header.getByTitle>) =>
    locator.evaluate((el) => el.scrollWidth > el.clientWidth);

  // Narrow enough that something has to give.
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await clipped(counts)).toBe(false);

  // Wide enough that nothing does.
  await page.setViewportSize({ width: 1750, height: 900 });
  expect(await clipped(counts)).toBe(false);
  expect(await clipped(chipText)).toBe(false);

  // The cluster keeps its rail alignment at the wider width too, not merely at
  // 1440 — the alignment must not be an accident of one viewport.
  const railWidth = await page
    .locator('nav')
    .first()
    .evaluate((element) => element.getBoundingClientRect().width);
  const clusterX = await page
    .getByTestId('header-chips')
    .evaluate((element) => element.getBoundingClientRect().x);
  expect(Math.round(clusterX)).toBe(Math.round(railWidth));
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
