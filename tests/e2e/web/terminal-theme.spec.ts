import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The terminal follows the app theme, proved in a real browser.
 *
 * **This claim cannot be made anywhere else.** Vitest never instantiates xterm
 * — happy-dom performs no layout, so a terminal can never measure a cell, and
 * `__mocks__/@xterm/` records the theme object rather than painting it. A unit
 * test can therefore prove that `xtermThemeFor(TERM_LIGHT)` *returns* a light
 * background and that the surface *assigns* it; only a browser can prove xterm
 * then painted it, and that the DOM padding around the canvas agrees.
 *
 * That last part is the one worth a spec of its own. xterm paints its own
 * background while the surrounding `bg-term-bg` element paints the padding, so
 * the two colours come from different systems — JS in `ansi.ts` and CSS in
 * `tokens.css`. Any drift between them shows up as a rectangle at the
 * terminal's edge, and it is invisible to every unit test in the suite.
 *
 * The theme is driven from the **header toggle**, not the settings pane: the
 * settings pane occupies the centre stage, which is where the terminal is.
 */

const APP_URL = '/?sim=0';

/** `#f7fafb` and `#0b1023`, as the browser reports them. */
const LIGHT_GROUND = 'rgb(247, 250, 251)';
const DARK_GROUND = 'rgb(11, 16, 35)';

/**
 * Dark carries *no* `data-theme` attribute — `:root` is the dark theme and
 * `body[data-theme='light']` is the only override — so the two themes are
 * asserted differently on purpose.
 */
const expectTheme = async (page: Page, want: 'light' | 'dark') => {
  const body = page.locator('body');
  if (want === 'light') {
    await expect(body).toHaveAttribute('data-theme', 'light');
  } else {
    await expect(body).not.toHaveAttribute('data-theme', /.*/);
  }
};

/** Toggle until the wanted theme is showing, whatever the machine defaulted to. */
const setTheme = async (page: Page, want: 'light' | 'dark') => {
  const showing = await page.locator('body').getAttribute('data-theme');
  if ((showing === 'light') !== (want === 'light')) {
    await page
      .getByRole('button', {
        name: want === 'light' ? 'Switch to light theme' : 'Switch to dark theme',
      })
      .click();
  }
  await expectTheme(page, want);
};

const backgroundOf = (target: Locator) =>
  target.evaluate((el) => getComputedStyle(el).backgroundColor);

/**
 * Polled, not sampled once.
 *
 * `setTheme` only waits on `body[data-theme]`, which the store writes
 * *synchronously* before the state update. xterm repaints later — via a React
 * passive effect and then xterm's own `onChangeColors` — so a single
 * `expect(await backgroundOf(…))` can read the previous theme's colour a frame
 * before the repaint lands. With `retries: 0` that is a flake, not a failure.
 */
const expectGround = async (target: Locator, colour: string) => {
  await expect.poll(() => backgroundOf(target)).toBe(colour);
};

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('the terminal repaints with the app theme, and its padding agrees', async ({
  page,
}, testInfo) => {
  const surface = page.locator('[data-testid="terminal-surface"]').first();
  await expect(surface).toBeVisible();

  /**
   * xterm paints `theme.background` onto its **scrollable element**, not onto
   * `.xterm-viewport` — the viewport keeps xterm's own stylesheet default
   * (black), so asserting there would compare against a colour this app never
   * chose and would pass in dark mode by coincidence.
   */
  const viewport = surface.locator('.xterm-scrollable-element');
  await expect(viewport).toBeVisible();

  /**
   * Dark is set explicitly rather than assumed. The store does boot to dark
   * (`appearance-store.ts` ships `theme: 'dark'`), but a spec that leans on the
   * boot default asserts nothing on its first leg — it would pass identically
   * if the toggle did nothing at all.
   */
  await setTheme(page, 'dark');
  await expectGround(viewport, DARK_GROUND);
  await expectGround(surface, DARK_GROUND);
  await surface.screenshot({ path: testInfo.outputPath('terminal-dark.png') });

  await setTheme(page, 'light');

  // The claim this whole change exists to make.
  await expectGround(viewport, LIGHT_GROUND);

  // And the claim no unit test can make: xterm's ground and the DOM's padding
  // are the same colour, so there is no rectangle at the terminal's edge.
  await expectGround(surface, LIGHT_GROUND);
  await surface.screenshot({ path: testInfo.outputPath('terminal-light.png') });

  // Back again — a one-way theme switch would be a bug that only shows up here.
  await setTheme(page, 'dark');
  await expectGround(viewport, DARK_GROUND);
});

test('the terminal survives the theme switch it just repainted through', async ({
  page,
}) => {
  const surface = page.locator('[data-testid="terminal-surface"]').first();
  await expect(surface).toBeVisible();

  await setTheme(page, 'dark');

  /**
   * Re-theming assigns `terminal.options.theme` on the live instance instead of
   * rebuilding it. A rebuild would drop every line of scrollback on a theme
   * toggle — so the terminal must still be the same one, still measuring cells.
   */
  const before = await surface.locator('.xterm-rows').boundingBox();
  expect(before?.height ?? 0).toBeGreaterThan(0);

  await setTheme(page, 'light');

  await expect(page.locator('[data-testid="terminal-surface"]')).toHaveCount(1);
  const after = await surface.locator('.xterm-rows').boundingBox();
  expect(after?.height).toBe(before?.height);
});
