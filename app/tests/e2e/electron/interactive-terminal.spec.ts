import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * Typing into a real terminal (story 095).
 *
 * Everything here needs a rendered xterm and a live pty, which is precisely
 * what the unit suite cannot have: `__mocks__/@xterm/` replaces the library
 * wholesale because happy-dom performs no layout, so no unit test in this repo
 * can prove a keystroke reached a shell. The keyboard *matrix* is asserted as a
 * pure function in `tests/lib/terminal/keymap.test.ts`; this file asserts that
 * the decisions it makes actually land.
 *
 * Assertions go through the file system rather than the screen, because this
 * story's own WebGL renderer paints into canvases and takes the transcript out
 * of the DOM (see `pty-transport.spec.ts`). It is the better assertion in any
 * case: a marker file proves the keystrokes reached a *process*, which is the
 * claim, rather than proving something was echoed.
 */

/** A directory that certainly exists on any machine running this. */
const REAL_DIRECTORY = join(import.meta.dirname, '../../..');

const SESSION = 'hero-refresh';
const PROJECT = 'apfm-web';

/**
 * The bootstrap has to be *finished* before a spec types, not merely started.
 *
 * Story 096 writes `claudeCommand` into every new session shortly after its
 * first output. A spec that starts typing in that window has its keystrokes
 * interleaved with an injected command line, and the shell runs neither — which
 * looks exactly like a broken keyboard handler and is nothing of the sort.
 *
 * So the bootstrap is pointed at a stub that announces itself, and
 * `openLiveSession` waits for that announcement before returning. This also
 * keeps the real `claude` out of a Playwright run, where it would consume
 * tokens and touch the working tree.
 */
function writeConfig(path: string, bootstrapMarker: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      // `sh`, so this holds wherever CI runs it.
      shell: '/bin/sh',
      claudeCommand: `printf bootstrapped > '${bootstrapMarker}'`,
      projects: [{ id: PROJECT, path: REAL_DIRECTORY }],
    }),
  );
}

const readMarker = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, 'utf8').trim() : null;

async function expectMarker(path: string, contents: string): Promise<void> {
  await expect.poll(() => readMarker(path), { timeout: 15_000 }).toBe(contents);
}

/**
 * Open the session, wait for its shell to be genuinely up, and focus it.
 *
 * The readiness wait is not padding. A shell that has not finished starting
 * discards input, and a spec that types too early fails intermittently in a way
 * that looks exactly like a keyboard bug.
 */
async function openLiveSession(
  page: Page,
  markers: { ready: string; bootstrap: string },
): Promise<Locator> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');
  await page.getByRole('button', { name: new RegExp(SESSION) }).first().click();

  const terminal = page.locator(`[data-terminal-id="${SESSION}"]`);
  await expect(terminal).toBeVisible();

  /**
   * Wait for the bootstrap to have run before touching the keyboard. Typing
   * into the window where story 096 is still injecting `claudeCommand` would
   * interleave two command lines and run neither.
   */
  await expectMarker(markers.bootstrap, 'bootstrapped');

  await page.evaluate(
    ([sessionId, marker]) => {
      window.hive!.pty.write({
        sessionId: sessionId!,
        data: `echo ready > '${marker}'\n`,
      });
    },
    [SESSION, markers.ready],
  );
  await expectMarker(markers.ready, 'ready');

  await terminal.click();
  return terminal;
}

test('keystrokes typed into the terminal reach the shell', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  const bootstrapped = testInfo.outputPath('bootstrapped.txt');
  writeConfig(configPath, bootstrapped);
  const marker = testInfo.outputPath('typed.txt');

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await openLiveSession(page, {
      ready: testInfo.outputPath('ready.txt'),
      bootstrap: bootstrapped,
    });

    // Typed, not injected — the whole point of the story, driven the way a user
    // would drive it. Clicking to focus is part of the claim.
    await page.keyboard.type(`echo hive-ok > '${marker}'`);
    await page.keyboard.press('Enter');

    await expectMarker(marker, 'hive-ok');
  } finally {
    await app.close();
  }
});

test('Ctrl+C interrupts a running command and leaves a usable prompt', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  const bootstrapped = testInfo.outputPath('bootstrapped.txt');
  writeConfig(configPath, bootstrapped);
  const finished = testInfo.outputPath('finished.txt');
  const after = testInfo.outputPath('after.txt');

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await openLiveSession(page, {
      ready: testInfo.outputPath('ready.txt'),
      bootstrap: bootstrapped,
    });

    // Would write `finished` in 100 seconds if it were ever allowed to.
    await page.keyboard.type(`sleep 100 && echo finished > '${finished}'`);
    await page.keyboard.press('Enter');

    /**
     * The assertion that matters most on every platform, for opposite reasons:
     * on macOS `Ctrl+C` must not be mistaken for copy, and on Linux/Windows it
     * must not be swallowed by the conventional copy binding.
     */
    await page.keyboard.press('Control+c');

    // The shell is taking commands again — the only honest proof the interrupt
    // landed rather than the keystroke vanishing.
    await page.keyboard.type(`echo interrupted > '${after}'`);
    await page.keyboard.press('Enter');
    await expectMarker(after, 'interrupted');

    // And the sleep really died rather than still running behind us.
    expect(readMarker(finished)).toBeNull();
  } finally {
    await app.close();
  }
});

test('arrow keys edit the shell line rather than navigating the app', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  const bootstrapped = testInfo.outputPath('bootstrapped.txt');
  writeConfig(configPath, bootstrapped);
  const marker = testInfo.outputPath('edited.txt');

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    const terminal = await openLiveSession(page, {
      ready: testInfo.outputPath('ready.txt'),
      bootstrap: bootstrapped,
    });

    /**
     * A bare `←` inside a live terminal is a cursor key belonging to the child
     * process. Before this story the same key returned to the orchestrator from
     * the message row; if that binding leaked into a focused terminal, the view
     * would change here instead of the cursor moving.
     */
    await page.keyboard.type(`echo XY > '${marker}'`);
    for (let i = 0; i < `XY > '${marker}'`.length; i += 1) {
      await page.keyboard.press('ArrowLeft');
    }
    await page.keyboard.type('AB');
    await page.keyboard.press('Enter');

    await expectMarker(marker, 'ABXY');
    // Still looking at the session, not back at the orchestrator.
    await expect(terminal).toBeVisible();
  } finally {
    await app.close();
  }
});

test('the escape chord leaves a focused terminal for the orchestrator', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  const bootstrapped = testInfo.outputPath('bootstrapped.txt');
  writeConfig(configPath, bootstrapped);

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    const terminal = await openLiveSession(page, {
      ready: testInfo.outputPath('ready.txt'),
      bootstrap: bootstrapped,
    });

    const isMac = process.platform === 'darwin';
    await page.keyboard.press(isMac ? 'Meta+ArrowLeft' : 'Control+Shift+ArrowLeft');

    /**
     * An escape hatch that only works when focus is *outside* the terminal is
     * not an escape hatch. The terminal's key handler declines this chord so it
     * keeps bubbling and reaches the stage — the mechanism under test.
     */
    await expect(terminal).toBeHidden({ timeout: 5_000 });
  } finally {
    await app.close();
  }
});

test('the interactive terminal takes a GPU context; the console does not', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  const bootstrapped = testInfo.outputPath('bootstrapped.txt');
  writeConfig(configPath, bootstrapped);

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    // The console is a command surface, never a shell (story 041) — so it stays
    // on the DOM renderer even in the desktop build.
    const orchestrator = page.locator('[data-terminal-id="orch"]');
    await expect(orchestrator).toBeVisible();
    await expect(orchestrator.locator('canvas')).toHaveCount(0);

    await page.getByRole('button', { name: new RegExp(SESSION) }).first().click();
    const terminal = page.locator(`[data-terminal-id="${SESSION}"]`);

    /**
     * Canvases are the only observable proof the renderer actually swapped.
     * `loadAddon` returning without throwing proves nothing — a refused WebGL2
     * context fails later and silently, which is the failure mode the
     * context-loss guard exists for.
     */
    await expect(terminal.locator('canvas').first()).toBeAttached({
      timeout: 10_000,
    });
  } finally {
    await app.close();
  }
});

test('a hidden terminal gives its GPU context back and takes one again on return', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  const bootstrapped = testInfo.outputPath('bootstrapped.txt');
  writeConfig(configPath, bootstrapped);

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    await page.getByRole('button', { name: new RegExp(SESSION) }).first().click();
    const terminal = page.locator(`[data-terminal-id="${SESSION}"]`);
    await expect(terminal.locator('canvas').first()).toBeAttached({
      timeout: 10_000,
    });

    await page.getByRole('button', { name: /lead-form/ }).first().click();

    /**
     * Contexts are a capped, process-wide resource — browsers commonly allow
     * ~16 and this app can hold a dozen live terminals. A kept-alive hidden
     * instance that held onto its context would exhaust the pool and start
     * silently killing the oldest ones, which looks like unrelated terminals
     * freezing.
     */
    await expect(terminal.locator('canvas')).toHaveCount(0, { timeout: 10_000 });

    await page.getByRole('button', { name: new RegExp(SESSION) }).first().click();
    await expect(terminal.locator('canvas').first()).toBeAttached({
      timeout: 10_000,
    });
  } finally {
    await app.close();
  }
});
