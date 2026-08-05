import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * The coordination layer, against a real pty (story 097).
 *
 * The unit suites prove the *routing* — which path a message took and what the
 * store did about it — against a stubbed bridge. What they structurally cannot
 * prove is that the text arrives: that `\r` submits at a real prompt, and that
 * main's refusal reaches the console.
 *
 * **Assertions go through the file system, not the screen.** A live terminal
 * uses the WebGL renderer (story 095), which paints into a canvas and takes the
 * transcript out of the DOM — `.xterm-rows` is empty there, and a spec that
 * polled it would hang for reasons that have nothing to do with routing. It is
 * the better assertion regardless: a marker file proves the text reached a
 * *process*, which is the claim. The orchestrator console is the exception —
 * it is a static surface on the DOM renderer, so its transcript is readable,
 * and the console lines are exactly what this story added to it.
 *
 * `claudeCommand` is a **stub**, for the reasons story 096's spec gives: a spec
 * that started a real agent in a real repository would consume tokens, could
 * write to the working tree, and would depend on a binary CI does not have.
 *
 * **One app, serial tests.** Every other spec here launches per test, and six
 * more parallel Electron launches measurably slowed the project — enough to
 * destabilise `interactive-terminal.spec.ts`'s Ctrl-C timing, which is a real
 * signal about machine load rather than a flake to retry away. Sharing the app
 * also makes the ordering deliberate: the "no live session" case has to run
 * before anything opens that session.
 */

test.describe.configure({ mode: 'serial' });

const REAL_DIRECTORY = join(import.meta.dirname, '../../..');
const SESSION = 'hero-refresh';
const UNOPENED = 'lead-form';
const PROJECT = 'apfm-web';
/** A fixture project the scratch config deliberately does not map. */
const UNMAPPED = 'referral-api';

let app: ElectronApplication;
let page: Page;
let out: (name: string) => string;

/**
 * The bootstrap has to be *finished* before a spec sends anything.
 *
 * Story 096 writes `claudeCommand` into every new session shortly after its
 * first output. A message sent inside that window interleaves with the injected
 * command line and the shell runs neither — which looks exactly like broken
 * routing and is nothing of the sort. So the bootstrap announces itself into a
 * marker, and `openSession` waits for it.
 */
function writeConfig(path: string, bootstrapMarker: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      /**
       * `sh`, not the user's `$SHELL`. zsh and bash differ in prompt behaviour
       * and startup output, and a suite that passes only on the author's
       * machine is worthless.
       */
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
  await expect.poll(() => readMarker(path), { timeout: 20_000 }).toBe(contents);
}

test.beforeAll(async ({}, testInfo) => {
  out = (name) => testInfo.outputPath(name);
  const configPath = out('hive-config.json');
  writeConfig(configPath, out('bootstrapped.txt'));

  app = await launchHive({
    userDataDir: out('user-data'),
    configPath,
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');
});

test.afterAll(async () => {
  await app.close();
});

const consoleCommand = () =>
  page.getByRole('textbox', { name: 'Orchestrator command' });

const messageInput = (id: string) =>
  page.getByRole('textbox', { name: `Message ${id}` });

const terminalRows = (id: string) =>
  page.locator(`[data-terminal-id="${id}"] .xterm-rows`);

/** The orchestrator console is a static surface, so its text is in the DOM. */
const consoleText = async (): Promise<string> =>
  (await terminalRows('orch').innerText()).replace(/ /g, ' ');

async function run(command: string): Promise<void> {
  await consoleCommand().fill(command);
  await consoleCommand().press('Enter');
}

/**
 * Ensure the console is on screen.
 *
 * Idempotent, because these tests share one app and the previous one may have
 * left the console up already — the back button only exists on a session's meta
 * bar, so clicking unconditionally would hang waiting for a control that is
 * correctly absent.
 */
async function backToOrchestrator(): Promise<void> {
  const back = page.getByRole('button', { name: 'Back to orchestrator' });
  if (await back.isVisible()) await back.click();
  await expect(terminalRows('orch')).toBeVisible();
}

/** Open a session and wait until its shell is genuinely ready for input. */
async function openSession(id: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(id) }).first().click();
  await expect(page.locator(`[data-terminal-id="${id}"]`)).toBeVisible();
  await expectMarker(out('bootstrapped.txt'), 'bootstrapped');
}

test('sending to a session with no process refuses, and says why', async () => {
  /**
   * First, deliberately: nothing has asked for a process for this entity yet,
   * and opening its terminal anywhere above would spawn one.
   *
   * The failure this guards is silence. Main's `write` returns early for an
   * entity with no live session, so without the refusal the console would
   * cheerfully print `routed →` and nothing at all would happen.
   */
  await run(`send ${UNOPENED} y`);

  await expect
    .poll(consoleText, { timeout: 15_000 })
    .toContain('has no live session');
  expect(await consoleText()).not.toContain(`routed → ${UNOPENED}`);
});

test('a message typed into the row reaches the prompt and submits', async () => {
  await openSession(SESSION);
  const marker = out('row.txt');

  await messageInput(SESSION).fill(`echo row-ok > '${marker}'`);
  await messageInput(SESSION).press('Enter');

  /**
   * `\r` is what submits. With `\n` the text would land at the prompt and
   * never run, so asserting that the command *executed* — rather than that it
   * appeared — is the whole point of this test.
   */
  await expectMarker(marker, 'row-ok');
  await expect(messageInput(SESSION)).toHaveValue('');
});

test('a multi-line message submits once, as a single line', async () => {
  const marker = out('multiline.txt');

  /**
   * `fill` puts a real newline in the input. Unnormalised, the shell would run
   * the first line and leave the rest half-typed at the prompt; normalised, it
   * is one command whose argument happens to contain a space.
   */
  await messageInput(SESSION).fill(`echo one\ntwo > '${marker}'`);
  await messageInput(SESSION).press('Enter');

  await expectMarker(marker, 'one two');
});

test('a console send reaches that session’s terminal', async () => {
  await backToOrchestrator();
  const marker = out('console.txt');

  await run(`send ${SESSION} echo routed-ok > '${marker}'`);

  await expect
    .poll(consoleText, { timeout: 15_000 })
    .toContain(`routed → ${SESSION}`);
  await expectMarker(marker, 'routed-ok');
});

test('an unmapped spawn prints main’s refusal in the console, verbatim', async () => {
  await backToOrchestrator();

  await run(`spawn ${UNMAPPED} do things`);

  /**
   * Verbatim, and it names the file to edit — the entire actionable part.
   * Before this story the refusal reached only the terminal, asynchronously,
   * and only if a surface happened to mount.
   *
   * `spawn` opens the new session's tab, so the console has to be revisited to
   * read the line — which is itself the assertion that it went to the console
   * rather than only into that terminal.
   */
  await backToOrchestrator();
  await expect
    .poll(consoleText, { timeout: 15_000 })
    .toContain(`${UNMAPPED} is not mapped`);
  expect(await consoleText()).toContain('hive-config.json');
});

test('spawn delivers its task as the session’s first message', async () => {
  await backToOrchestrator();
  const marker = out('task.txt');

  await run(`spawn ${PROJECT} echo task-delivered > '${marker}'`);

  /**
   * The task rides the `SpawnRequest` and is written by main's bootstrap after
   * the stub's own output settles — the second stage. The renderer never sends
   * it, because the renderer cannot know when the TUI is ready.
   */
  await expectMarker(marker, 'task-delivered');
});
