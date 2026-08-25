import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { launchHive, startSession } from './fixtures/hive-app';

/**
 * A bare `←` at a real Claude prompt reaches the app, not Claude (HIVE-79).
 *
 * ## Why this suite has to exist
 *
 * Because every other layer can be green while the product is broken, and that
 * is not hypothetical here — it is the ticket. The keyboard matrix is a pure
 * function with 77 assertions on it; the surface's plumbing is asserted against
 * a recording fake; the frames are captured recordings in
 * `tests/support/claude-frames.ts`. All three passed while a bare `←` in a real
 * session opened **Claude Code's own agent list** — a second, competing fleet
 * view inside an app whose entire purpose is being the fleet view.
 *
 * Nothing short of a real `claude` behind a real pty inside the real app can
 * close that gap. The recordings prove the rule matches the frames Claude drew
 * *on the day they were taken*; only the binary can say whether it still draws
 * them, and whether the decision survives the trip through xterm's key handler,
 * the custom-key hook, the chord event, and the stage's listener.
 *
 * ## What it asserts, and why that is the discriminator
 *
 * That the app navigated to the overmind. If the claim is lost the key goes to
 * the pty, Claude opens its agent list *inside the session*, and the app stays
 * exactly where it was — so "did the tab change?" separates the two outcomes
 * cleanly, without scraping a canvas the WebGL renderer owns (see
 * `pty-transport.spec.ts` for why the transcript is not in the DOM).
 *
 * ## Why it is opt-in
 *
 * It spawns a real `claude`, which costs real tokens and takes tens of seconds
 * — the same trade `tests/live/` makes for the hook suites.
 *
 * ```
 * pnpm test:back
 * ```
 */
const enabled = process.env.HIVE_LIVE_BACK_PROOF === '1';

const SESSION = 'sess-01';
const PROJECT = 'back-proof';

/**
 * A scratch repo, not this one.
 *
 * `claude` is about to be pointed at it with a live model behind it. Every
 * other spec in this directory takes the same precaution for the same reason:
 * a suite that can spawn an agent in a real working tree is a suite that can
 * commit to it.
 */
function scratchProject(root: string): string {
  const dir = join(root, 'back-proof-repo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  return dir;
}

function writeConfig(path: string, projectPath: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      shell: '/bin/sh',
      /**
       * The real binary, and the flags are load-bearing.
       *
       * `--permission-mode plan` keeps an agent that is handed a live model
       * from touching anything; there is no prompt in this spec, but a session
       * that boots into a mode where it *could* act is not one to leave running
       * in a test. `; false` short-circuits the `&& exit` the bootstrap wraps
       * the command in, so quitting Claude leaves the login shell rather than
       * closing the session out from under the assertions.
       */
      claudeCommand: 'claude --permission-mode plan ; false',
      projects: [{ id: PROJECT, path: projectPath }],
    }),
  );
}

/** Where the collector below accumulates this session's pty output. */
const SINK = '__hiveBackProofOutput';

/**
 * Start recording the session's stdout, before anything is typed.
 *
 * Read from the pty rather than from the screen because the WebGL renderer
 * paints the transcript into a canvas — there is nothing in the DOM to query
 * (`pty-transport.spec.ts` records the same constraint). Installed before the
 * session starts so the boot output cannot be missed in the gap.
 */
async function collectOutput(page: Page): Promise<void> {
  await page.evaluate(
    ([sink, sessionId]) => {
      const store = window as unknown as Record<string, string>;
      store[sink!] = '';
      window.hive!.pty.onData((event) => {
        if (event.sessionId !== sessionId) return;
        store[sink!] += event.chunk;
      });
    },
    [SINK, SESSION],
  );

  /**
   * Record the terminal's own chord events.
   *
   * The decision under test is announced on `window` before anything on screen
   * moves, so this says which of the three answers the keymap reached — and
   * says it even when the failure is downstream, in the stage's listener. A
   * spec that could only see the tab change could not tell "the key was never
   * claimed" from "the key was claimed and the navigation broke".
   */
  await page.evaluate((event) => {
    const store = window as unknown as Record<string, string[]>;
    store.__hiveChords = [];
    window.addEventListener(event, (raw) => {
      store.__hiveChords!.push((raw as CustomEvent<{ chord: string }>).detail.chord);
    });
  }, 'hive:terminal-chord');
}

/** Which chords the terminal has announced so far. */
const chords = (page: Page): Promise<string[]> =>
  page.evaluate(
    () => (window as unknown as Record<string, string[]>).__hiveChords ?? [],
  );

/**
 * Wait until Claude has drawn its input frame, and the cover is off it.
 *
 * The footer is the readiness signal because it is the last thing Claude draws:
 * by the time any of these strings appears, the frame above it is complete.
 * Generous timeout — this is a cold `claude` start against a live model.
 */
async function waitForClaudePrompt(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (sink) => (window as unknown as Record<string, string>)[sink] ?? '',
          SINK,
        ),
      { timeout: 120_000, intervals: [1_000] },
    )
    .toMatch(/shift\+tab to cycle|for shell mode|\? for shortcuts/u);

  /**
   * The boot cover has to be gone before the key under test is pressed.
   *
   * `useSessionBoot` lifts the cover on **any** keystroke (HIVE-101), so a spec
   * that pressed `←` while it was up would be testing the cover rather than the
   * keymap: the first key would lift it and never reach xterm. A key the
   * terminal ignores lifts it deliberately.
   */
  const cover = page.getByTestId('session-boot-cover');
  if (await cover.isVisible()) {
    await page.keyboard.press('Shift');
    await expect(cover).toHaveCount(0, { timeout: 15_000 });
  }
}


/**
 * Wait until the session stops repainting.
 *
 * The decision under test reads the screen, so the screen has to be the one the
 * test means. Typing is asynchronous all the way down — keystroke to stdin, to
 * Claude, back as a repaint, through xterm's parser into the buffer — and a
 * `←` pressed before that round trip lands is answered against the *previous*
 * frame. Without this the half-written-message case races: sometimes `←` sees
 * the empty prompt that was there a moment ago, and the app correctly claims a
 * key the test expected it to decline.
 *
 * Quiet output is the signal, because there is nothing else to watch: the
 * transcript lives in a WebGL canvas and the buffer is xterm's private state.
 */
async function settle(page: Page, quietMs = 400): Promise<void> {
  const size = async () =>
    (
      await page.evaluate(
        (sink) => (window as unknown as Record<string, string>)[sink] ?? '',
        SINK,
      )
    ).length;

  let last = await size();
  let quietSince = Date.now();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const now = await size();
    if (now !== last) {
      last = now;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= quietMs) return;
  }
}

/** The last of the session's pty output, for a failure message worth reading. */
async function tail(page: Page, lines = 24): Promise<string> {
  const all = await page.evaluate(
    (sink) => (window as unknown as Record<string, string>)[sink] ?? '',
    SINK,
  );
  // eslint-disable-next-line no-control-regex
  const plain = all.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, '');
  return plain.split('\n').slice(-lines).join('\n');
}

test.skip(!enabled, 'set HIVE_LIVE_BACK_PROOF=1 — spawns a real claude');

test('bare ← at an empty Claude prompt returns to the overmind', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  writeConfig(configPath, scratchProject(testInfo.outputPath('.')));

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');
    await collectOutput(page);
    await startSession(page, PROJECT);

    const terminal = page.locator(`[data-terminal-id="${SESSION}"]`);
    await expect(terminal).toBeVisible();
    await waitForClaudePrompt(page);

    // Focus the surface the way a user does, then press the key they press.
    await terminal.click();
    await settle(page);
    await page.keyboard.press('ArrowLeft');

    /**
     * The fleet is back on the stage. If the key had leaked, Claude's agent
     * list would be open inside a session tab that never changed.
     */
    await expect(
      page.locator('[data-terminal-id="orch"]'),
      `chords: ${JSON.stringify(await chords(page))}\nlast of the session:\n${await tail(page)}`,
    ).toBeVisible({ timeout: 10_000 });
    await expect(terminal).toBeHidden();
  } finally {
    await app.close();
  }
});

test('bare ← with a half-written message stays in the session', async ({}, testInfo) => {
  /**
   * The other half of HIVE-79, and the one that cost a user their message: the
   * app used to claim this key too. `Shift+Enter` puts the caret on an empty
   * second input row with the frame's bottom edge right beneath it, which the
   * two-row rule read as an empty prompt.
   */
  const configPath = testInfo.outputPath('hive-config.json');
  writeConfig(configPath, scratchProject(testInfo.outputPath('.')));

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');
    await collectOutput(page);
    await startSession(page, PROJECT);

    const terminal = page.locator(`[data-terminal-id="${SESSION}"]`);
    await expect(terminal).toBeVisible();
    await waitForClaudePrompt(page);

    await terminal.click();
    await settle(page);
    await page.keyboard.type('a half-written message');
    await page.keyboard.press('Shift+Enter');

    /**
     * The message has to be *on the screen* before the key is pressed, not
     * merely sent. See {@link settle} — without this the arrow is answered
     * against the empty prompt that was there a moment earlier, and the app
     * claims it exactly as it should have.
     */
    await settle(page);
    await page.keyboard.press('ArrowLeft');

    // Still here. The message is still being written.
    await expect(terminal).toBeVisible();
    await expect(page.locator('[data-terminal-id="orch"]')).toBeHidden();

    /**
     * And the app said so rather than losing the key in silence — the
     * observability half of the ticket, end to end.
     */
    await expect(
      page.getByTestId('terminal-hint'),
      `chords: ${JSON.stringify(await chords(page))}\nlast of the session:\n${await tail(page)}`,
    ).toContainText('went to the session');
  } finally {
    await app.close();
  }
});
