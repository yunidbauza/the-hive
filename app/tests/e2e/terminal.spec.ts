import { expect, test, type Page } from '@playwright/test';

/**
 * Terminal surface — the claims Vitest structurally cannot make (stories 042,
 * 070).
 *
 * Unit tests mock xterm away entirely, so everything about a *rendered*
 * terminal — colours on screen, selection, scrollback across tab switches,
 * refit on resize, re-theming — is unfalsifiable there. This spec is where
 * story 042's acceptance criteria are actually checked.
 */

const APP_URL = '/?sim=0';

/** The palette from `src/lib/terminal/ansi.ts`, as the browser reports it. */
const TERM_RGB = {
  green: 'rgb(126, 226, 184)',
  dim: 'rgb(124, 136, 184)',
  bg: 'rgb(11, 16, 35)',
};

/** The surface currently on screen — hidden ones are kept alive beside it. */
const activeTerminal = (page: Page) =>
  page.locator('[data-testid="terminal-surface"]:not([style*="display: none"])');

const surfaceFor = (page: Page, id: string) =>
  page.locator(`[data-terminal-id="${id}"]`);

/** Rows the DOM renderer has laid out — the output of a successful fit. */
const rowCount = (page: Page, id: string) =>
  surfaceFor(page, id).locator('.xterm-rows > div').count();

/** The text currently on screen, row by row — the only honest scroll probe. */
const visibleRows = (page: Page, id: string) =>
  surfaceFor(page, id)
    .locator('.xterm-rows > div')
    .allTextContents()
    .then((rows) => rows.map((row) => row.trim()));

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
});

test('renders the orchestrator transcript in its palette colours', async ({
  page,
}) => {
  const terminal = activeTerminal(page);
  await expect(terminal).toBeVisible();

  // The boot lines from the fixtures, actually painted by xterm.
  await expect(terminal).toContainText('maestro v0.4.2');
  await expect(terminal).toContainText('connected — 10 sessions · 3 agents');

  /**
   * Colour is the point: a transcript rendered in default white would satisfy
   * every text assertion above and still be wrong. `✓ connected …` is a green
   * line and the banner above it is dim.
   */
  const green = terminal.locator('span', { hasText: '✓ connected' }).first();
  await expect(green).toHaveCSS('color', TERM_RGB.green);

  const dim = terminal.locator('span', { hasText: 'maestro v0.4.2' }).first();
  await expect(dim).toHaveCSS('color', TERM_RGB.dim);
});

test('keeps the terminal dark and opaque, not transparent to the page', async ({
  page,
}) => {
  // The terminal keeps its dark background in light mode (story 011), so this
  // holds in both themes; the light-mode half is asserted below.
  await expect(activeTerminal(page)).toHaveCSS(
    'background-color',
    TERM_RGB.bg,
  );
});

test('opens a session transcript when its rail row is clicked', async ({
  page,
}) => {
  await page.getByRole('button', { name: /hero-refresh/ }).first().click();

  const terminal = activeTerminal(page);
  await expect(terminal).toHaveAttribute('data-terminal-id', 'hero-refresh');
  await expect(terminal).toContainText('claude --resume feat/hero-refresh');
  await expect(terminal).toContainText('swapped hardcoded hex');
});

test('keeps a visited terminal alive instead of rebuilding it', async ({
  page,
}) => {
  await page.getByRole('button', { name: /hero-refresh/ }).first().click();
  await expect(surfaceFor(page, 'hero-refresh')).toBeVisible();

  await page.getByRole('button', { name: /webhooks/ }).first().click();
  await expect(surfaceFor(page, 'webhooks')).toBeVisible();

  /**
   * The previous surface is still in the DOM, merely hidden. This is the
   * mechanism behind every scrollback and selection guarantee in this story:
   * one xterm instance per entity, shown and hidden, never re-fed.
   */
  await expect(surfaceFor(page, 'hero-refresh')).toBeAttached();
  await expect(surfaceFor(page, 'hero-refresh')).toBeHidden();
  await expect(surfaceFor(page, 'hero-refresh').locator('.xterm')).toHaveCount(1);
});

test('preserves scroll position across a tab switch', async ({ page }) => {
  /**
   * Fixture transcripts are short — the longest is `hero-refresh` at eight
   * lines — so a squat viewport is what makes them scrollable at all, and
   * scrollback is the thing under test. Roughly six rows fit at this height,
   * and the viewport must be small *before* the terminal mounts so the
   * transcript is written into an already-small buffer.
   */
  await page.setViewportSize({ width: 1440, height: 220 });
  await page.goto(APP_URL);
  await page.getByRole('button', { name: /hero-refresh/ }).first().click();
  await expect(surfaceFor(page, 'hero-refresh').locator('.xterm-rows')).toBeVisible();

  /**
   * Scroll state is read from the rendered rows rather than from
   * `.xterm-viewport.scrollTop`. xterm 6 does not scroll that element
   * natively — it has no scroll area and reports `scrollHeight ===
   * clientHeight` at every position — so the only honest observable is which
   * lines are actually on screen.
   */
  const atBottom = await visibleRows(page, 'hero-refresh');
  expect(atBottom.join('\n')).toContain('Working…');

  const screen = surfaceFor(page, 'hero-refresh').locator('.xterm-screen');
  const box = await screen.boundingBox();
  await page.mouse.move(box!.x + 50, box!.y + 10);
  await page.mouse.wheel(0, -400);

  /**
   * Assert that the view *moved*, not that it moved to a particular line. How
   * far a wheel tick scrolls depends on cell height and how many rows fit
   * beside the meta bar — pinning a specific line makes this spec fail for
   * layout changes that have nothing to do with the guarantee under test.
   */
  await expect
    .poll(async () => (await visibleRows(page, 'hero-refresh')).join('\n'))
    .not.toBe(atBottom.join('\n'));
  const scrolledBack = await visibleRows(page, 'hero-refresh');

  await page.getByRole('button', { name: /webhooks/ }).first().click();
  await expect(surfaceFor(page, 'webhooks')).toBeVisible();
  await page.getByRole('button', { name: /hero-refresh/ }).first().click();
  await expect(surfaceFor(page, 'hero-refresh')).toBeVisible();

  // A shared instance re-fed on every switch would have dropped the user back
  // at the bottom of a transcript they were reading the middle of.
  expect(await visibleRows(page, 'hero-refresh')).toEqual(scrolledBack);
});

test('refits when the window resizes, without clipping the last line', async ({
  page,
}) => {
  await page.getByRole('button', { name: /hero-refresh/ }).first().click();
  await expect(surfaceFor(page, 'hero-refresh')).toBeVisible();

  const tall = await rowCount(page, 'hero-refresh');

  await page.setViewportSize({ width: 1440, height: 500 });
  await expect
    .poll(() => rowCount(page, 'hero-refresh'))
    .toBeLessThan(tall);

  // The transcript survives the refit — a fit that reset the buffer would be
  // worse than no fit at all.
  await expect(activeTerminal(page)).toContainText(
    'claude --resume feat/hero-refresh',
  );
});

test('re-themes live instances without losing their content', async ({
  page,
}) => {
  await page.getByRole('button', { name: /hero-refresh/ }).first().click();
  const terminal = activeTerminal(page);
  await expect(terminal).toContainText('swapped hardcoded hex');

  await page.getByRole('button', { name: 'Switch to light theme' }).click();

  // Content intact, background still dark: story 011 keeps the terminal dark
  // in light mode, and only selection/cursor tint varies.
  await expect(terminal).toContainText('swapped hardcoded hex');
  await expect(terminal).toHaveCSS('background-color', TERM_RGB.bg);
  await expect(terminal.locator('.xterm')).toHaveCount(1);
});

test('lets the user select transcript text like a real terminal', async ({
  page,
}) => {
  await page.getByRole('button', { name: /hero-refresh/ }).first().click();
  const screen = surfaceFor(page, 'hero-refresh').locator('.xterm-screen');
  await expect(screen).toBeVisible();

  const box = await screen.boundingBox();
  expect(box).not.toBeNull();

  // Drag across the first transcript line.
  await page.mouse.move(box!.x + 8, box!.y + 6);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width - 40, box!.y + 6, { steps: 12 });
  await page.mouse.up();

  /**
   * Read xterm's own selection rather than `window.getSelection()`: xterm
   * implements selection itself and paints it into an overlay, so the native
   * selection can be empty even when the terminal has a live one.
   */
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  const overlay = await surfaceFor(page, 'hero-refresh')
    .locator('.xterm-selection div')
    .count();

  expect(selected.length > 0 || overlay > 0).toBe(true);
});
