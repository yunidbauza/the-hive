import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { launchHive, startSession } from './fixtures/hive-app';

/**
 * `Cmd+Delete` at a real Claude prompt kills the line, not a character.
 *
 * ## Why this suite has to exist
 *
 * The same reason `bare-back-claim.spec.ts` does, and the same failure mode:
 * every layer below this can be green while the product is broken. The keymap
 * is a pure function with unit tests either side of it, and the surface's
 * plumbing is asserted against a recording fake — but the fake will happily
 * accept a byte the real child ignores, and neither layer can see the trip
 * through xterm's key handler, where the defect lived.
 *
 * The defect: xterm's `case 8` reads `ctrlKey` and `altKey` and never
 * `metaKey`, so `Cmd+Delete` reached the pty as a bare `DEL` and rubbed out one
 * character where the user had asked for the line. That is worse than a
 * swallowed key — a swallowed key is visibly nothing, this one quietly did
 * something else — and it is invisible to a test that only asks "was a byte
 * written?", because a byte always was.
 *
 * ## What it asserts, and why that is the discriminator
 *
 * That Claude answered the chord with *"Ctrl+Y to paste deleted text"* — its
 * own offer to undo a kill. It draws that for a killed line and never for a
 * rubbed-out character, so it separates precisely the two outcomes this ticket
 * is about, and it is a claim about the child process rather than about a
 * decision some pure function reached.
 *
 * Read from the pty's output rather than from the screen because the transcript
 * lives in a WebGL canvas — there is nothing in the DOM to query
 * (`pty-transport.spec.ts` records the same constraint).
 *
 * **The bare `Delete` pressed first is the control, and it carries half the
 * proof.** It is the same key without the modifier, so it establishes that the
 * hint is absent for an ordinary character delete on this very frame, seconds
 * earlier. Without it the spec could not tell "the chord killed the line" from
 * "Claude prints that hint for any backspace", and a fix that killed the line
 * for *every* backspace — a worse bug than the one being fixed — would pass.
 *
 * ## What it deliberately does not assert
 *
 * The exact byte on stdin. `contextBridge` exposes `window.hive.pty` frozen
 * (`writable: false, configurable: false`), so a spec cannot wrap `write` — an
 * earlier revision tried, and the assignment silently no-opped, which reads as
 * "no writes happened" rather than as "the spy failed". The byte is pinned one
 * layer down, in `tests/components/terminal/terminal-surface.test.tsx`, where
 * the transport is a fake that can be interrogated honestly.
 *
 * ## Why it is opt-in
 *
 * It spawns a real `claude`, which costs real tokens and takes tens of seconds
 * — the trade every suite in `tests/live/` and the back-claim spec makes.
 *
 * ```
 * pnpm test:kill
 * ```
 */
const enabled = process.env.HIVE_LIVE_KILL_PROOF === '1';

const SESSION = 'sess-01';
const PROJECT = 'kill-proof';

/** The line typed at the prompt. Distinctive so a repaint can be recognised. */
const TYPED = 'hive kill line proof';

/** Where the collector accumulates this session's pty output. */
const SINK = '__hiveKillProofOutput';

/**
 * A scratch repo, not this one.
 *
 * `claude` is about to be pointed at it with a live model behind it. The other
 * specs in this directory take the same precaution for the same reason: a suite
 * that can spawn an agent in a real working tree is one that can commit to it.
 */
function scratchProject(root: string): string {
  const dir = join(root, 'kill-proof-repo');
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
       * The real binary, and the flags are load-bearing — the same pair
       * `bare-back-claim.spec.ts` explains. `--permission-mode plan` keeps an
       * agent holding a live model from touching anything, and `; false`
       * short-circuits the `&& exit` the bootstrap wraps the command in, so
       * quitting Claude leaves the login shell rather than closing the session
       * out from under the assertions.
       */
      claudeCommand: 'claude --permission-mode plan ; false',
      projects: [{ id: PROJECT, path: projectPath }],
    }),
  );
}

/**
 * Start recording the session's stdout, before anything is typed.
 *
 * Installed before the session starts so the boot output cannot be missed in
 * the gap.
 */
async function collect(page: Page): Promise<void> {
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
}

/** `ESC`, and the `BEL` that can terminate a string sequence. */
const ESC = 0x1b;
const BEL = 0x07;

/**
 * The index just past the escape sequence beginning at `start`.
 *
 * A scanner rather than a regex, and deliberately so: expressing these patterns
 * as regexes means literal control characters in them, which trips
 * `no-control-regex`, and the house rule is that no lint rule may be disabled
 * inline to make code pass. `electron/main/clone/parse-url.ts` reaches for the
 * code points for the same reason. Reading them directly says the same thing
 * and needs no exemption.
 *
 * Three shapes, because a TUI emits all three: `CSI` (`ESC [` … final byte in
 * `@`–`~`), the string sequences (`OSC`/`DCS`/`APC`/`PM`/`SOS`, run until `BEL`
 * or the `ESC \` string terminator), and the plain two-byte escapes, which may
 * carry one intermediate byte — `ESC ( B` is the one Claude actually sends.
 */
function skipEscape(raw: string, start: number): number {
  let i = start + 1;
  const introducer = raw.codePointAt(i);
  if (introducer === undefined) return i;

  const OPEN_BRACKET = 0x5b;
  const STRING_INTRODUCERS = new Set([0x5d, 0x50, 0x5f, 0x5e, 0x58]);
  const BACKSLASH = 0x5c;

  if (introducer === OPEN_BRACKET) {
    i += 1;
    while (i < raw.length) {
      const code = raw.codePointAt(i) ?? 0;
      i += 1;
      if (code >= 0x40 && code <= 0x7e) break;
    }
    return i;
  }

  if (STRING_INTRODUCERS.has(introducer)) {
    i += 1;
    while (i < raw.length) {
      const code = raw.codePointAt(i) ?? 0;
      if (code === BEL) return i + 1;
      if (code === ESC && (raw.codePointAt(i + 1) ?? 0) === BACKSLASH) return i + 2;
      i += 1;
    }
    return i;
  }

  i += 1;
  const isIntermediate = introducer >= 0x20 && introducer <= 0x2f;
  return isIntermediate && i < raw.length ? i + 1 : i;
}

/**
 * Escapes stripped and whitespace squashed out, for matching.
 *
 * Both halves are load-bearing, and both were learned from runs that timed out
 * against a prompt which had been ready for a minute. Claude paints the gaps
 * between words with cursor-forward escapes as readily as with literal spaces,
 * so `shift+tab to cycle` arrives in this stream with a `CUF` sequence where
 * the pattern expected a space — and no amount of `\s*` can match an escape.
 *
 * So the escapes go, and the remaining control bytes with them, and then the
 * whitespace goes too, because which of the two a given gap was drawn as is not
 * stable between repaints. What is left is the letters in order, which is the
 * only part of a TUI frame worth asserting on.
 */
function squashed(raw: string): string {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const code = raw.codePointAt(i) ?? 0;
    if (code === ESC) {
      i = skipEscape(raw, i);
      continue;
    }
    // C0 and DEL carry no letters — `BEL`, `BS` and the rest are noise here.
    if (code >= 0x20 && code !== 0x7f) out += raw[i];
    i += 1;
  }
  // A plain pattern, so no exemption: `\s` names no control character itself.
  return out.replace(/\s+/gu, '');
}

const output = (page: Page): Promise<string> =>
  page.evaluate(
    (sink) => (window as unknown as Record<string, string>)[sink] ?? '',
    SINK,
  );

/** Everything the session has said since `from`, ready to match against. */
async function since(page: Page, from: number): Promise<string> {
  return squashed((await output(page)).slice(from));
}


/**
 * Wait until Claude has drawn its input frame, and the cover is off it.
 *
 * The footer is the readiness signal because it is the last thing Claude draws.
 * The cover has to go before the key under test is pressed: `useSessionBoot`
 * lifts it on **any** keystroke (HIVE-101), so the first press would lift it
 * and never reach xterm. A key the terminal ignores lifts it deliberately.
 */
async function waitForClaudePrompt(page: Page): Promise<void> {
  await expect
    .poll(async () => squashed(await output(page)), {
      timeout: 120_000,
      intervals: [1_000],
    })
    // Against {@link squashed} output, so the gaps in the footer are gone
    // rather than guessed at.
    .toMatch(/shift\+tabtocycle|forshellmode|\?forshortcuts|←foragents/u);

  const cover = page.getByTestId('session-boot-cover');
  if (await cover.isVisible()) {
    await page.keyboard.press('Shift');
    await expect(cover).toHaveCount(0, { timeout: 15_000 });
  }
}

/**
 * Wait until the session stops repainting.
 *
 * Typing is asynchronous all the way down — keystroke to stdin, to Claude, back
 * as a repaint, through xterm's parser — and an assertion made before that
 * round trip lands reads the *previous* frame. Quiet output is the signal
 * because there is nothing else to watch: the transcript is a WebGL canvas and
 * the buffer is xterm's private state.
 */
async function settle(page: Page, quietMs = 600): Promise<void> {
  let last = (await output(page)).length;
  let quietSince = Date.now();
  const deadline = Date.now() + 20_000;
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

/** The last of the session's output, for a failure message worth reading. */
async function tail(page: Page, chars = 1_200): Promise<string> {
  return squashed(await output(page)).slice(-chars);
}

/**
 * Claude's own offer to undo a kill. Absent when a single character went.
 *
 * Written for {@link squashed} output — the gaps in this string are painted the
 * same unstable way as the footer's.
 *
 * **Deliberately short of the full sentence.** Claude draws this hint at the
 * right-hand end of the footer, where the terminal's own width clips it: a run
 * that had unmistakably killed the line still only received
 * `Ctrl+Ytopastedeletedtex`, one character shy of the obvious pattern. Matching
 * the whole sentence would make the spec a report on the window's width. What
 * is matched here is the part that survives any clipping, and nothing else in a
 * Claude frame says it.
 */
const KILL_HINT = /Ctrl\+Ytopaste/u;

test.skip(!enabled, 'set HIVE_LIVE_KILL_PROOF=1 — spawns a real claude');

/**
 * Playwright's 30-second default cannot hold a cold `claude` start, never mind
 * three round trips through a live model afterwards. The readiness poll alone
 * is allowed two minutes.
 */
test.setTimeout(300_000);

test('Cmd+Delete kills the whole line at a real Claude prompt', async ({}, testInfo) => {
  /**
   * The rule under test is macOS-only, so the spec is too.
   *
   * `isLineKillChord` returns `false` off macOS by design — `Ctrl+U` is already
   * on those keyboards and `Cmd` is not — so on Linux or Windows the chord
   * stays `to-pty`, xterm encodes its `DEL`, and the kill-hint assertion fails
   * for the correct behaviour. The same guard, for the same reason, as the
   * `Cmd`+arrow case in `interactive-terminal.spec.ts`.
   */
  test.skip(process.platform !== 'darwin', 'Cmd is a macOS-only modifier');

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

    // Focus the surface the way a user does, then type the line they type.
    await terminal.click();
    await settle(page);

    /**
     * Every step is measured against a mark taken immediately before it rather
     * than against the whole stream, because a launched Electron window takes
     * the desktop's keyboard focus: anything typed at another app during the
     * run lands in this session instead. Matching the whole stream made the
     * spec a report on what else was happening on the machine; a slice makes it
     * a report on the key it pressed.
     */
    let mark = (await output(page)).length;
    await page.keyboard.type(TYPED);
    await settle(page);

    /**
     * The keys reached the prompt at all.
     *
     * Not a formality: a launched Electron window takes the desktop's keyboard
     * focus, and an earlier run recorded *another application's* keystrokes in
     * this stream. If the typing did not land here, everything below is
     * measuring something else, and this says so with a legible failure rather
     * than a mystifying one further down.
     */
    expect(
      await since(page, mark),
      `last of the session:\n${await tail(page)}`,
    ).toContain(squashed(TYPED));

    /**
     * The control, pressed first: the same key without the modifier.
     *
     * It establishes on this very frame, seconds before the chord, that Claude
     * does not offer the undo for an ordinary character delete. That is what
     * makes the assertion below a statement about `Cmd` rather than about
     * backspace.
     */
    mark = (await output(page)).length;
    await page.keyboard.press('Backspace');
    await settle(page);

    expect(
      await since(page, mark),
      `last of the session:\n${await tail(page)}`,
    ).not.toMatch(KILL_HINT);

    // The chord under test.
    mark = (await output(page)).length;
    await page.keyboard.press('Meta+Backspace');
    await settle(page);

    /**
     * The assertion the ticket is about. Before the fix this pressed the same
     * `DEL` as the control one line up, and produced the same silence.
     */
    expect(
      await since(page, mark),
      `last of the session:\n${await tail(page)}`,
    ).toMatch(KILL_HINT);

  } finally {
    await app.close();
  }
});
