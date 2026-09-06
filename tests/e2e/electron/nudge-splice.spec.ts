import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { launchHive, startSession } from './fixtures/hive-app';

/**
 * A nudge never lands in a half-typed message (HIVE-135).
 *
 * ## What this proves
 *
 * `deliver.ts` writes an `ask` addressed to a session into that session's pty
 * as one line ending in `\r`, the moment `Sessions.isIdle` says the agent is
 * not busy. `isIdle` is about the agent, not the input box: a user who has
 * typed `let me check the` and stopped has an idle agent and a full box. The
 * `\r` then submits draft and nudge together as one prompt nobody wrote.
 *
 * Nothing short of a real `claude` behind a real pty in the real app can show
 * whether that merge actually happens — Claude's own input handling could in
 * principle absorb it — so this spec is both the reproduction and the
 * conformance criterion: with a draft in the box the nudge is held; once the
 * box is cleared the same nudge lands.
 *
 * ## Result of the first run, before the fix
 *
 * claude 2.1.263, 2026-09-06: the "held" assertion failed on the first run —
 * no warm-up turn was needed. The pty showed the draft and the nudge
 * submitted together as one line, the `\r` from `deliver.ts` firing before
 * the box was cleared:
 *
 * ```
 * ❯ let me check the📒 overmind asks (a1): NUDGE-HELD-1788677780559 — reply with ledger_answer a1
 * ```
 *
 * ## Why it is opt-in
 *
 * It spawns a real `claude`, which costs real tokens and takes tens of
 * seconds — the same trade `bare-back-claim.spec.ts` makes.
 *
 * ```
 * pnpm test:nudge
 * ```
 */
const enabled = process.env.HIVE_LIVE_NUDGE_PROOF === '1';

const SESSION = 'sess-01';
const PROJECT = 'nudge-proof';
const DRAFT = 'let me check the';

function scratchProject(root: string): string {
  const dir = join(root, 'nudge-proof-repo');
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
      // `--permission-mode plan` keeps a live model from touching the scratch
      // repo; `; false` keeps the login shell alive after Claude exits.
      claudeCommand: 'claude --permission-mode plan ; false',
      projects: [{ id: PROJECT, path: projectPath }],
    }),
  );
}

/** Where the collector accumulates this session's pty output. */
const SINK = '__hiveNudgeProofOutput';
/** Where the collector records the session's last derived status. */
const STATUS = '__hiveNudgeProofStatus';

/**
 * Record the session's pty output and its status stream, before anything is
 * typed. The transcript lives in a WebGL canvas, so the pty is the only
 * readable copy; the status is how the spec knows main considers the session
 * idle, which is the precondition delivery checks first.
 */
async function collect(page: Page): Promise<void> {
  await page.evaluate(
    ([sink, status, sessionId]) => {
      const store = window as unknown as Record<string, string>;
      store[sink!] = '';
      store[status!] = '';
      window.hive!.pty.onData((event) => {
        if (event.sessionId !== sessionId) return;
        store[sink!] += event.chunk;
      });
      window.hive!.session.onStatus((event) => {
        if (event.entityId !== sessionId) return;
        store[status!] = event.status;
      });
    },
    [SINK, STATUS, SESSION],
  );
}

const output = (page: Page): Promise<string> =>
  page.evaluate((sink) => (window as unknown as Record<string, string>)[sink] ?? '', SINK);

const status = (page: Page): Promise<string> =>
  page.evaluate(
    (key) => (window as unknown as Record<string, string>)[key] ?? '',
    STATUS,
  );

async function waitForClaudePrompt(page: Page): Promise<void> {
  await expect
    .poll(() => output(page), { timeout: 120_000, intervals: [1_000] })
    .toMatch(/shift\+tab to cycle|for shell mode|\? for shortcuts/u);

  const cover = page.getByTestId('session-boot-cover');
  if (await cover.isVisible()) {
    await page.keyboard.press('Shift');
    await expect(cover).toHaveCount(0, { timeout: 15_000 });
  }
}

/** Main's own view: the session derives `idle`. Delivery checks this first. */
async function waitForIdle(page: Page): Promise<void> {
  await expect.poll(() => status(page), { timeout: 60_000, intervals: [500] }).toBe('idle');
}

/** Wait until the session stops repainting. */
async function settle(page: Page, quietMs = 400): Promise<void> {
  let last = (await output(page)).length;
  let quietSince = Date.now();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const now = (await output(page)).length;
    if (now !== last) {
      last = now;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= quietMs) return;
  }
}

/** The last of the pty output, escapes stripped, for a failure worth reading. */
async function tail(page: Page, lines = 24): Promise<string> {
  const all = await output(page);
  // eslint-disable-next-line no-control-regex
  const plain = all.replace(/\[[0-9;?]*[A-Za-z]/gu, '');
  return plain.split('\n').slice(-lines).join('\n');
}

/** The overmind asks the session, exactly as the console's verbs do. */
async function ask(page: Page, body: string): Promise<void> {
  const result = await page.evaluate(
    ([to, text]) => window.hive!.ledger.post({ to: to!, kind: 'ask', body: text! }),
    [SESSION, body],
  );
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

test.skip(!enabled, 'set HIVE_LIVE_NUDGE_PROOF=1 — spawns a real claude');

test('a nudge is held while a draft is in the box, and lands once it is cleared', async ({}, testInfo) => {
  test.setTimeout(300_000);
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
    await collect(page);
    await startSession(page, PROJECT);

    const terminal = page.locator(`[data-terminal-id="${SESSION}"]`);
    await expect(terminal).toBeVisible();
    await waitForClaudePrompt(page);
    await waitForIdle(page);

    await terminal.click();
    await settle(page);
    await page.keyboard.type(DRAFT);
    // The draft has to be on the screen — the report is derived from it.
    await settle(page);

    const held = `NUDGE-HELD-${Date.now()}`;
    await ask(page, held);

    /**
     * The reproduction, and the first half of the fix. Before HIVE-135 the
     * line lands immediately: the pty echoes the marker right after the draft
     * and the `\r` submits both. After it, five quiet seconds show nothing.
     */
    await page.waitForTimeout(5_000);
    expect(await output(page), `last of the session:\n${await tail(page)}`).not.toContain(held);

    // Clear the draft the way a user does. Backspace, not Ctrl+U: `\x15`'s
    // scope in Claude's editor is unverified and the kill ring is the user's.
    for (let index = 0; index < DRAFT.length; index += 1) {
      await page.keyboard.press('Backspace');
    }
    await settle(page);

    /**
     * The box is empty, so the surface reports `empty`, main flushes, and the
     * nudge that was held is the one that lands — with no receipt written in
     * between, nothing was dropped.
     */
    await expect
      .poll(() => output(page), { timeout: 20_000, intervals: [500] })
      .toContain(held);
    // And it was submitted on its own line, not appended to the draft.
    expect(await output(page)).not.toContain(`${DRAFT}📒`);
  } finally {
    await app.close();
  }
});
