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
    await openLiveSession(page, {
      ready: testInfo.outputPath('ready.txt'),
      bootstrap: bootstrapped,
    });

    /**
     * Announces itself from *inside* the long-running child, then would write
     * `finished` in 100 seconds if it were ever allowed to.
     *
     * The subshell is the whole point, and it is what HIVE-53 turned out to be
     * about. Written as `echo started > … && sleep 100 && …`, the marker comes
     * from a shell **builtin** — it appears before `sleep` exists, so it proves
     * the command line ran and not that a foreground job is running. Under
     * parallel load the interrupt lands in that window, at a process group that
     * is not yet the job: `sleep 100` then starts and the follow-up command
     * queues behind it for a hundred seconds. That is the intermittent failure
     * recorded on HIVE-48, measured at 14 runs in 48.
     *
     * Writing the marker inside `sh -c` makes its existence prove that the
     * child process group exists, so SIGINT reaches a real job whether it
     * arrives during the `echo` or during the `sleep`. Either way the `&&`
     * short-circuits and `finished` stays absent.
     *
     * The path travels as `sh -c '…' '<path>'` and is read back as `"$0"`,
     * rather than being interpolated into the command string. Every level that
     * sees it has it in single quotes, so the outer interactive shell never
     * expands it — a `$`, a backtick or a backslash in the Playwright output
     * path would otherwise redirect the marker to a different file, and the
     * timeout would read as "the shell never ran the command".
     */
    await page.keyboard.type(
      `sh -c 'echo started > "$0"; sleep 100' '${started}' && echo finished > '${finished}'`,
    );
    await page.keyboard.press('Enter');

    /**
     * Wait for the job to actually be running before interrupting it.
     *
     * With the marker written from inside the child, this is now the assertion
     * it always claimed to be: SIGINT is known to hit a *running foreground
     * job*, because the process group that wrote the marker is the one the
     * interrupt goes to.
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
     * Sent **once**, and that is a deliberate strengthening (HIVE-53).
     *
     * This was a re-focus-and-retry loop, on the theory that a status-driven
     * re-render was moving focus off the terminal. Instrumenting the failure
     * refuted it: across 14 reproductions, `document.activeElement` was the
     * xterm helper textarea every single time, `document.hasFocus()` was true,
     * no `webglcontextlost` fired, nothing blurred, and every keystroke —
     * `Control+c` included — was delivered to that textarea. Focus was never
     * lost, so `terminal.click()` was never restoring it. The race was the
     * readiness marker above, and fixing it took the failure rate from 14/48
     * to 0/24 under the same parallel load.
     *
     * A single attempt is therefore the stronger claim: one interrupt, one
     * follow-up command, and the shell must run it.
     */
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

test('a focused terminal keeps the keyboard across a lost GPU context', async ({}, testInfo) => {
  /**
   * A renderer swap must not cost the user their caret (HIVE-53).
   *
   * This passes before the fix as well as after, and that is reported honestly
   * rather than dressed up: disposing the WebGL addon touches the canvases and
   * not xterm's helper textarea, so focus survives a context loss by accident.
   * `onContextLoss` now re-asserts focus deliberately, and this spec is the
   * guard that keeps the property true — a regression here would mean a live
   * session going silently untypable mid-command, which is exactly the failure
   * HIVE-53 was opened to chase.
   *
   * The loss is forced through `WEBGL_lose_context` rather than waited for.
   * Real losses come from GPU pressure and driver resets, neither of which a
   * spec can schedule.
   */
  const configPath = testInfo.outputPath('hive-config.json');
  const bootstrapped = testInfo.outputPath('bootstrapped.txt');
  writeConfig(configPath, bootstrapped);
  const marker = testInfo.outputPath('after-context-loss.txt');

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
     * Give the addon time to attach before looking for its canvases.
     *
     * Without this a machine that *does* have WebGL can be caught mid-attach,
     * find nothing to lose, and take the skip below — reporting "no context"
     * for what was only an early look. Absence after the wait is the real
     * answer, so the wait is tolerant rather than asserted.
     */
    await terminal
      .locator('canvas')
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 })
      .catch(() => {});

    /**
     * Count the loss as *delivered*, not merely requested.
     *
     * `loseContext()` dispatches `webglcontextlost` asynchronously, so typing
     * straight after it races the very handler this spec exists to guard: the
     * keystrokes could land, the marker could appear, and the assertion could
     * pass without `onContextLoss` having run at all. A spec that passes
     * without exercising its subject is worse than no spec.
     *
     * The listener is installed before the loss is forced and resolves when the
     * event actually arrives, which is the same event xterm wires
     * `onContextLoss` to — so waiting on it waits for the app's handler to have
     * been reachable. Deliberately not a canvas-count assertion: disposing this
     * addon leaves its canvas elements in the DOM (unlike the hide path, where
     * the whole effect tears down), so counting them proves nothing here.
     */
    const lost = await page.evaluate((sessionId) => {
      const canvases = Array.from(
        document.querySelectorAll<HTMLCanvasElement>(
          `[data-terminal-id="${sessionId}"] canvas`,
        ),
      );
      let forced = 0;
      const delivered: Promise<void>[] = [];
      for (const canvas of canvases) {
        const gl =
          canvas.getContext('webgl2') ??
          (canvas.getContext('webgl') as WebGLRenderingContext | null);
        const extension = gl?.getExtension('WEBGL_lose_context');
        if (extension) {
          delivered.push(
            new Promise<void>((resolve) => {
              canvas.addEventListener('webglcontextlost', () => resolve(), {
                once: true,
              });
            }),
          );
          extension.loseContext();
          forced += 1;
        }
      }
      if (forced === 0) return 0;
      return Promise.all(delivered).then(() => forced);
    }, SESSION);

    /**
     * No context, nothing to lose — and that is a legitimate state, not a
     * failure.
     *
     * Contexts are a capped, process-wide resource: `loadAddon` throws on a
     * software-rendering VM or a blocklisted driver, and a machine already
     * holding the browser's limit gives this terminal the DOM renderer instead
     * (`terminal-surface.tsx`). Several Electron apps running in parallel is
     * exactly that machine. Asserting a context exists would make this spec
     * fail for the one condition the addon logic is designed to survive, so the
     * premise is skipped rather than asserted — and never quietly passed.
     */
    test.skip(lost === 0, 'no WebGL context on this run — nothing to lose');

    /**
     * No click, deliberately. Re-focusing here would test the click rather than
     * the invariant — the claim is that the keyboard never left.
     */
    await page.keyboard.type(`echo survived > '${marker}'`);
    await page.keyboard.press('Enter');
    await expectMarker(marker, 'survived');
  } finally {
    await app.close();
  }
});

test('Shift+Enter is a line break, not a submit', async ({}, testInfo) => {
  /**
   * The defect, driven the way it was reported.
   *
   * xterm's keyboard table reads `case 13: ev.altKey ? ESC + CR : CR` and never
   * consults `shiftKey`, so before this fix `Shift+Enter` and a bare `Enter`
   * reached the child process as the *same single byte*. Nothing downstream can
   * distinguish what it cannot see, so the message went early.
   *
   * The assertion is built so the *old* behaviour fails it loudly rather than
   * subtly. One command line is typed with a `Shift+Enter` in the middle of a
   * word:
   *
   * - **Fixed**: the shell never sees a submit there, the halves join, and it
   *   runs `echo hive-ok > marker` as one command when the real `Enter` lands.
   * - **Broken**: `Shift+Enter` submits `echo hive-` on the spot and the
   *   remainder runs as a second, different command — the marker is then either
   *   absent or does not say `hive-ok`.
   *
   * Split mid-token on purpose: a break at a space would leave the first half a
   * runnable command, which is a weaker trap.
   *
   * What this cannot show is the *rendered* second line, because the fixture
   * shell is `/bin/sh` rather than a real `claude` — keeping an agent, its
   * tokens and its working-tree writes out of a Playwright run. That is the
   * right trade: the byte that submits is the entire defect, and this proves it
   * no longer arrives.
   */
  const configPath = testInfo.outputPath('hive-config.json');
  const bootstrapped = testInfo.outputPath('bootstrapped.txt');
  writeConfig(configPath, bootstrapped);
  const marker = testInfo.outputPath('shift-enter.txt');

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

    await page.keyboard.type('echo hive-');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type(`ok > '${marker}'`);
    await page.keyboard.press('Enter');

    await expectMarker(marker, 'hive-ok');
  } finally {
    await app.close();
  }
});
