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
