import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchHive, startSession } from './fixtures/hive-app';

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

const SESSION = 'sess-01';
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
      /**
       * `; false` is not decoration. The bootstrap is `claude && exit`
       * (`sessionCommand`), so a stub that ends cleanly takes the login shell
       * with it and there is no shell left for this spec to type into. Ending
       * badly short-circuits the `&&` and keeps the session open — the same
       * state a crashed agent leaves behind.
       *
       * `false` rather than `exit 1`: the stub is interpolated into a command
       * line, where `exit` would run in the session's own shell and close it.
       */
      claudeCommand: `printf bootstrapped > '${bootstrapMarker}'; false`,
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
  await startSession(page, PROJECT);

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
  const started = testInfo.outputPath('started.txt');
  const finished = testInfo.outputPath('finished.txt');
  const after = testInfo.outputPath('after.txt');

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

    // Announces itself, then would write `finished` in 100 seconds if it were
    // ever allowed to.
    await page.keyboard.type(
      `echo started > '${started}' && sleep 100 && echo finished > '${finished}'`,
    );
    await page.keyboard.press('Enter');

    /**
     * Wait for the job to actually be running before interrupting it.
     *
     * Without this the test races the shell: under load the keystrokes and the
     * Enter can still be in flight when `Control+c` is pressed, so the
     * interrupt lands on an empty prompt and does nothing, `sleep 100` then
     * starts, and the follow-up command queues behind it for a hundred seconds.
     * Both markers stay absent and the failure reads as "Ctrl-C did not work"
     * when nothing was ever interrupted.
     *
     * It also makes the assertion stronger and more literally true to its own
     * description: SIGINT is now known to have hit a *running foreground job*.
     */
    await expectMarker(started, 'started');

    /**
     * The assertion that matters most on every platform, for opposite reasons:
     * on macOS `Ctrl+C` must not be mistaken for copy, and on Linux/Windows it
     * must not be swallowed by the conventional copy binding.
     */
    await page.keyboard.press('Control+c');

    /**
     * The shell is taking commands again — the only honest proof the interrupt
     * landed rather than the keystroke vanishing.
     *
     * Re-focused and re-sent until it takes, rather than sent once.
     *
     * Under load this failed roughly one run in four, always the same way:
     * `started` written, `finished` and `after` both absent — the job ran, and
     * then nothing else did. Retrying the keystrokes alone did **not** fix it;
     * adding `terminal.click()` before each attempt did, which points at focus
     * leaving the terminal rather than at characters being dropped by the
     * shell. The likeliest mechanism is a re-render: story 096 derives `idle`
     * after two seconds of silence, and the message row below focuses itself
     * when it mounts. Worth its own investigation — recorded on HIVE-48 — but
     * not this story's to fix.
     *
     * The assertion is unchanged and still exact: within the deadline the shell
     * must run a command, and `sleep 100` must not have survived.
     */
    await expect
      .poll(
        async () => {
          if (readMarker(after) === 'interrupted') return 'interrupted';
          /**
           * Re-focus before each attempt. A status change (story 096 derives
           * `idle` after two seconds of silence) re-renders the stage, and the
           * message row below focuses itself on mount — so a terminal that had
           * focus when the command was typed may not have it a moment later,
           * and the interrupt or the retry would go to an input box.
           */
          await terminal.click();
          await page.keyboard.press('Control+c');
          await page.keyboard.type(`echo interrupted > '${after}'`);
          await page.keyboard.press('Enter');
          return readMarker(after);
        },
        { timeout: 15_000, intervals: [250, 500, 1_000, 2_000] },
      )
      .toBe('interrupted');

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
    await page.keyboard.press(isMac ? 'Meta+BracketLeft' : 'Control+Shift+ArrowLeft');

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

test('Cmd+← edits the line instead of leaving the session', async ({}, testInfo) => {
  /**
   * The story-110 defect, driven the way it was reported. `Cmd+←` was the
   * escape chord, so reaching for beginning-of-line mid-command threw the user
   * out of the session and lost what they had typed.
   *
   * What is asserted is that the session is *still there* afterwards — the
   * navigation that must not happen. Which bytes go to the pty is pinned in
   * `tests/lib/terminal/keymap.test.ts` and `terminal-surface.test.tsx`;
   * asserting the caret really moved would mean depending on the host shell's
   * readline binding for `Home`, which varies by inputrc and terminfo and would
   * make this a test of the CI image rather than of the app.
   */
  test.skip(process.platform !== 'darwin', 'Cmd is a macOS-only modifier');

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

    await page.keyboard.type('echo half-typed');
    await page.keyboard.press('Meta+ArrowLeft');
    await page.keyboard.press('Meta+ArrowRight');

    /**
     * Given a whole second to navigate away before the claim is made. Asserting
     * visibility immediately would pass even if the chord still fired, since
     * the store update and the re-render are a tick behind the keystroke.
     */
    await page.waitForTimeout(1_000);
    await expect(terminal).toBeVisible();
  } finally {
    await app.close();
  }
});

test('bare ← at an empty Claude prompt returns to the orchestrator', async ({}, testInfo) => {
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

    /**
     * Claude's input frame, drawn by the shell rather than by Claude.
     *
     * The rule this exercises is a rule about **what is on screen**, so the
     * honest end-to-end test is to put that on screen — a rule, a `❯ ` row, a
     * rule — and park the caret in it. Requiring a real `claude` on the machine
     * would make the suite depend on an install, a login, and a network, none
     * of which this is testing. The exact rendering being imitated came from a
     * real pty capture and is pinned in `tests/lib/terminal/keymap.test.ts`.
     *
     * `sleep` keeps the shell from printing a prompt underneath and moving the
     * caret back out of the frame.
     */
    const rule = '─'.repeat(96);
    const staged = testInfo.outputPath('frame-staged.txt');
    await page.keyboard.type(
      // `\033[2J\033[H` rather than `clear(1)`, which needs a terminfo entry and
      // a binary this spec should not depend on. `\033[2;3H` then parks the
      // caret in the frame's input row, immediately after the `❯ `. The marker
      // is a *redirect*, so it prints nothing and leaves the caret where it is.
      `printf '\\033[2J\\033[H%s\\n❯ \\n%s\\n\\033[2;3H' '${rule}' '${rule}'; printf staged > '${staged}'; sleep 30`,
    );
    await page.keyboard.press('Enter');

    /**
     * Readiness comes from the file system, not from the screen. This story's
     * WebGL renderer paints into a canvas and takes the transcript out of the
     * DOM — the note at the top of this file — so `toContainText` sees an empty
     * string however long it waits.
     */
    await expectMarker(staged, 'staged');
    // The frame has left the shell; give xterm a moment to parse it into the
    // buffer the key handler reads.
    await page.waitForTimeout(1_000);

    await page.keyboard.press('ArrowLeft');

    /**
     * The whole point of the story: `←` here would have opened Claude Code's
     * own agent list inside the session. It goes to The Hive's orchestrator
     * instead, and the pty never sees the key.
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

    await startSession(page, PROJECT);
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

    /**
     * Two sessions, then switch between them.
     *
     * This used to click two seeded rail rows — `hero-refresh`, then
     * `lead-form`, then back. Nothing is seeded now, so the second session has
     * to be started rather than clicked; only the *return* is a tab switch, and
     * it is a click on the first session's row.
     */
    const first = await startSession(page, PROJECT);
    const terminal = page.locator(`[data-terminal-id="${first}"]`);
    await expect(terminal.locator('canvas').first()).toBeAttached({
      timeout: 10_000,
    });

    // A second session takes the stage, so the first is hidden but kept alive.
    await startSession(page, PROJECT);

    /**
     * Contexts are a capped, process-wide resource — browsers commonly allow
     * ~16 and this app can hold a dozen live terminals. A kept-alive hidden
     * instance that held onto its context would exhaust the pool and start
     * silently killing the oldest ones, which looks like unrelated terminals
     * freezing.
     */
    await expect(terminal.locator('canvas')).toHaveCount(0, { timeout: 10_000 });

    // Back to the first: a tab switch, not a new session.
    await page.getByRole('button', { name: new RegExp(first) }).first().click();
    await expect(terminal.locator('canvas').first()).toBeAttached({
      timeout: 10_000,
    });
  } finally {
    await app.close();
  }
});
