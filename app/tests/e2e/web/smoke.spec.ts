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
 * The three model-chip alignment tests that used to live here are gone.
 *
 * Each opened a seeded session first — `getByRole('button', {name: /hero-refresh/})`
 * — because the chip renders only for an active session, and the orchestrator
 * the app boots into has no model of its own. The browser target has no seeded
 * fleet any more and no way to start a real one, so their precondition is
 * unreachable rather than merely unmet.
 *
 * What they measured is still measured. `chip-alignment.spec.ts` pins the
 * chip cluster to the left rail's trailing edge in this same browser, and the
 * electron suite covers the model chip on the target that can actually open a
 * session. Nothing was traded away to make this file pass; the coverage moved
 * to where the subject exists.
 */

/**
 * The shell with nothing in it — the state a fresh launch is actually in.
 *
 * Every panel here used to open pre-populated from a seeded dataset, so this
 * was a state no browser test had ever seen. It is the default now, and an
 * empty column with no explanation is indistinguishable from a failed render.
 */
test('opens every panel on an empty state, not on sample data', async ({ page }) => {
  const rail = page.getByRole('navigation', { name: 'Projects, work, and agents' });

  await expect(page.getByText(/No projects mapped/i)).toBeVisible();
  await expect(page.getByText('Settings → Projects')).toBeVisible();

  await rail.getByRole('tab', { name: /^Agents/ }).click();
  await expect(page.getByText(/No agents running/i)).toBeVisible();
});

/** The orchestrator, on a machine where nothing is running. */
test('the orchestrator says its fleet is empty', async ({ page }) => {
  await expect(page.getByTestId('session-table-empty')).toHaveText(
    'No sessions running — start one with New session.',
  );
});

/**
 * The header counts, which is where the user first sees the app claim a fleet.
 * All four read zero because all four now count something real.
 */
test('the header counts nothing on a fresh launch', async ({ page }) => {
  const header = page.getByRole('banner');

  await expect(header.getByText('0 working')).toBeVisible();
  await expect(header.getByText('0 waiting')).toBeVisible();
  await expect(header.getByText(/0 idle · 0 ended/)).toBeVisible();
});

/**
 * The whole change, stated once as a negative: no seeded session, project or
 * ticket reaches the surfaces that describe the fleet. A unit test can prove
 * the store is empty; only a browser can prove nothing paints it.
 *
 * ## Why this is scoped to three panels rather than the whole page
 *
 * The PRs and inbox panels still carry seeded rows, deliberately — nothing
 * produces a PR or a notification yet, so emptying them would leave two panels
 * permanently blank with no path to filling them. Those rows name sessions
 * (`hero-refresh`, `lead-form`) that no longer exist, which is the accepted
 * cost of keeping them.
 *
 * So a page-wide "this string appears nowhere" would fail on data that is
 * supposed to be there, and would have to be weakened until it proved nothing.
 * The surfaces below are the ones the user reads as *the fleet* — the projects
 * tree, the orchestrator's table, and the work list — and those must be empty.
 */
test('paints no seeded session, project or ticket in the fleet surfaces', async ({
  page,
}) => {
  const rail = page.getByRole('navigation', { name: 'Projects, work, and agents' });
  const seeded = ['hero-refresh', 'lead-form', 'apfm-web', 'referral-api'];

  // The projects tree: no seeded repository, and no session under one.
  const projects = page.locator('[data-panel="projects"]');
  for (const name of seeded) {
    await expect(projects.getByText(name, { exact: false })).toHaveCount(0);
  }

  // The orchestrator table: the fleet stated as a list, and it has no rows.
  await expect(page.getByTestId('session-table-empty')).toBeVisible();

  // The work list: no ticket key, in any state, at any moment.
  await rail.getByRole('tab', { name: /^Work/ }).click();
  await expect(page.getByText(/GRAC-\d+/)).toHaveCount(0);
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
 * On the renderer: xterm 6 core ships the **DOM** renderer by default, and in
 * *this* target that is still what runs. Story 095 installed
 * `@xterm/addon-webgl`, but attaches it only to a visible **interactive**
 * terminal — and every surface in the browser build is a recording, so none of
 * them qualifies. The live instance therefore still renders as
 * `.xterm-dom-renderer-owner-*` with zero canvas elements.
 *
 * The assertion was written to fail deliberately if a renderer addon ever
 * arrived, and it did exactly that. Rescoped rather than deleted: "the demo
 * surface does not take a GPU context" is a stronger and more useful claim than
 * "nobody installed the package", and it is the one that keeps the browser
 * target honest now that the desktop build renders differently. The desktop
 * side is asserted in `tests/e2e/electron/interactive-terminal.spec.ts`.
 *
 * Depth beyond "it booted" — colours, selection, scrollback, refit, re-theming
 * — lives in the electron suite, against real PTYs. It used to live in this
 * project's `terminal.spec.ts`, which drove seeded sessions and went with the
 * seed; a browser has no way to open a session to render.
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

  /**
   * The demo surface takes **no GPU context** (story 095).
   *
   * Now asserted rather than merely described. `@xterm/addon-webgl` is
   * installed, so "nobody added the package" has stopped being a guarantee —
   * what keeps this target on the DOM renderer is that the addon attaches only
   * to an interactive terminal, and every surface here is a recording. A canvas
   * appearing means that rule broke and the browser build started spending
   * contexts it has no use for.
   */
  await expect(terminal.locator('canvas')).toHaveCount(0);
});
