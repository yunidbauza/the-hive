import type { ElectronApplication } from '@playwright/test';

import { expect, test } from './fixtures/hive-app';

/**
 * The application menu (story 085).
 *
 * On macOS `Cmd+C`, `Cmd+V`, `Cmd+A` and `Cmd+Q` are **menu accelerators**, not
 * browser behaviour. Without a `Menu` they silently do nothing — in an app
 * whose entire point is a terminal you copy text out of. Nothing errors when
 * they are missing, which is exactly why this needs asserting.
 */

/**
 * Every `role` in the live application menu, at any depth, lowercased.
 *
 * Electron normalises role names when it builds the menu — `selectAll` comes
 * back as `selectall`, `toggleDevTools` as `toggledevtools`. Comparing against
 * the camelCase spelling used in the template silently never matches, so the
 * casing is flattened here once rather than in every assertion.
 */
async function menuRoles(hive: ElectronApplication): Promise<string[]> {
  const roles = await hive.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    if (!menu) return [];
    const walk = (items: Electron.MenuItem[]): string[] =>
      items.flatMap((item) => [
        ...(item.role ? [String(item.role)] : []),
        ...(item.submenu ? walk(item.submenu.items) : []),
      ]);
    return walk(menu.items);
  });
  return roles.map((role) => role.toLowerCase());
}

test('an application menu exists at all', async ({ hive, page }) => {
  await page.waitForSelector('header');

  // The failure mode is total: no menu means no clipboard shortcuts anywhere.
  expect(await menuRoles(hive)).not.toHaveLength(0);
});

test('the clipboard roles are present, which is what binds Cmd+C and Cmd+V', async ({
  hive,
  page,
}) => {
  await page.waitForSelector('header');

  expect(await menuRoles(hive)).toEqual(
    expect.arrayContaining(['cut', 'copy', 'paste', 'selectall']),
  );
});

test('quit is bound', async ({ hive, page }) => {
  await page.waitForSelector('header');

  expect(await menuRoles(hive)).toContain('quit');
});

test('a production build offers no DevTools', async ({ hive, page }) => {
  await page.waitForSelector('header');

  // The spec runs the BUILT app, with no ELECTRON_RENDERER_URL — so this is
  // the shipped menu, and a shipped DevTools item is a shipped bug.
  expect(await menuRoles(hive)).not.toContain('toggledevtools');
});

test('terminal text can be selected, which is what Cmd+C then acts on', async ({
  page,
}) => {
  const screen = page.locator('.xterm-screen').first();
  await expect(screen).toBeVisible();

  // A real drag, not a programmatic Range. xterm implements selection itself
  // and paints it into an overlay, so `document.createRange()` over the rows
  // produces a native selection the terminal knows nothing about.
  const box = await screen.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box!.x + 8, box!.y + 6);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width - 40, box!.y + 6, { steps: 12 });
  await page.mouse.up();

  /**
   * Accept either signal, exactly as the web suite does
   * (`tests/e2e/web/terminal.spec.ts`): xterm's own selection lives in an
   * overlay, and `window.getSelection()` can be empty even when the terminal
   * has a live one.
   */
  const selected = await page.evaluate(
    () => window.getSelection()?.toString() ?? '',
  );
  const overlay = await page.locator('.xterm-selection div').count();

  expect(selected.length > 0 || overlay > 0).toBe(true);
});

/**
 * Not asserted here: that `Cmd+C` puts that selection on the system clipboard.
 *
 * The accelerator is dispatched by the OS to the native menu, so driving it
 * from Playwright tests AppKit rather than this app, and reading the real
 * clipboard makes the suite stateful against whatever else the machine is
 * doing. What this app controls is that the menu exists with the right roles —
 * asserted above — and that there is a selection for it to copy.
 *
 * Copy-on-selection and Ctrl-C-as-SIGINT have to coexist inside a focused
 * terminal, and that is story 095's problem, with its own tests.
 */
