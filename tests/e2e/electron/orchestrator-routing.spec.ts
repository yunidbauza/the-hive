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
const SESSION = 'sess-01';
const UNOPENED = 'sess-02';
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
function writeConfig(
  path: string,
  bootstrapMarker: string,
  argvMarker: string,
): void {
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
       *
       * ## Why the stub now records its arguments (HIVE-91)
       *
       * The session's task is a **positional argument** to `claude` rather than a
       * line typed into the shell afterwards, so the only way to observe it is to
       * be the process that receives it. `capture` writes one line per argument,
       * which makes both halves of the property checkable from a file: that the
       * task arrived at all, and that it arrived as *one* argument rather than
       * word-split into several.
       *
       * A shell function because the flags and the task are appended *after*
       * `claudeCommand` by `sessionCommand` — so whatever this string ends with is
       * what receives them.
       */
      claudeCommand:
        `printf bootstrapped > '${bootstrapMarker}'; ` +
        `capture() { printf '%s\\n' "$@" > '${argvMarker}'; false; }; capture`,
      projects: [
        { id: PROJECT, path: REAL_DIRECTORY },
        /**
         * Declared, but pointed at nothing — which is now the only way to reach
         * main's `unmapped` refusal from the console.
         *
         * `referral-api` used to be absent from this file entirely: it was one
         * of five projects seeded into the store, so the renderer thought it
         * existed, let the spawn through, and main refused it. Both sides read
         * the config now, so a project the config never mentions is refused by
         * the renderer before main is asked — and the gap that made main's
         * refusal reachable has to be opened deliberately.
         */
        { id: UNMAPPED, path: '/nowhere/that/exists' },
      ],
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
  writeConfig(configPath, out('bootstrapped.txt'), out('argv.txt'));

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
  page.getByRole('textbox', { name: 'Overmind command' });

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
  const back = page.getByRole('button', { name: 'Back to overmind' });
  if (await back.isVisible()) await back.click();
  await expect(terminalRows('orch')).toBeVisible();
}

/**
 * Start a session and wait until its shell is genuinely ready for input.
 *
 * This used to *click* one: `hero-refresh` was seeded into the store at boot,
 * so a rail row for it already existed. Nothing is seeded now, so the session
 * has to be created — through the console's own `spawn` verb, which is the
 * surface this file is about anyway, and which opens the tab as part of
 * spawning.
 */
async function openSession(id: string): Promise<void> {
  // A task, because the grammar is `spawn <repo> <task>` — a bare repo is a
  // usage error, not a spawn.
  await run(`spawn ${PROJECT} true`);
  await expect(page.locator(`[data-terminal-id="${id}"]`)).toBeVisible();
  await expectMarker(out('bootstrapped.txt'), 'bootstrapped');
}

/**
 * Sending to a session that is not there refuses, rather than reporting success.
 *
 * ## Why the refusal being asserted changed
 *
 * This used to send to `lead-form` — a seeded entity that existed in the store
 * but had never been opened, and therefore had no pty. It asserted
 * `has no live session`, the refusal `session-input.ts` gives for an entity with
 * no channel.
 *
 * That state is no longer reachable from the UI. Every session is created by
 * spawning one, and spawning requests a process and opens the tab, so a session
 * that exists but has no channel cannot be produced by driving the app. The
 * branch itself is unchanged and still covered, at
 * `tests/lib/terminal/session-input.test.ts` — which is the right level for it,
 * since what is being tested is a pure function of the channel state.
 *
 * What the console can still be driven into, and what this now pins, is the
 * refusal one layer earlier: an id the store has never heard of. The failure
 * guarded is the same and it is the important one — **silence**. Main's `write`
 * returns early for an unknown entity, so without a refusal the console would
 * print `routed →` and nothing at all would happen.
 */
test('sending to a session that does not exist refuses, and says why', async () => {
  await run(`send ${UNOPENED} y`);

  await expect
    .poll(consoleText, { timeout: 15_000 })
    .toContain(`no such session: ${UNOPENED}`);
  expect(await consoleText()).not.toContain(`routed → ${UNOPENED}`);
});

test('a live session has no message row — the terminal is the input', async () => {
  /**
   * Story 108 removed the row from live sessions, and this is where that is
   * worth asserting rather than in a unit test: on desktop the surface above it
   * is a real pty running Claude Code, which has a prompt of its own. Two text
   * boxes for one session means two sets of keybindings and no way to tell from
   * the caret which will receive the next character — and the row's autofocus
   * was actively competing with the terminal's, which is how a freshly opened
   * session came to ignore what was typed into it.
   *
   * The row is *not* gone from the app: agent tabs are recordings with no
   * prompt to speak into, and they keep it. That side used to be covered by
   * `picker.spec.ts` and `waiting-session.spec.ts` in the web suite; both drove
   * seeded sessions and went with the seed. `message-input.test.tsx` covers the
   * row's own behaviour, and no browser-level replacement exists — an agent tab
   * needs an agent, and nothing creates one yet.
   *
   * What the row used to prove here — that a message reaches the prompt and is
   * submitted with `\r` rather than `\n` — is proved by the console send below,
   * which goes through the same `sendToSession`. Multi-line normalisation is no
   * longer reachable from any surface (a single-line `<input>` cannot hold a
   * newline) and is covered by `tests/lib/terminal/session-input.test.ts`.
   */
  await openSession(SESSION);

  await expect(messageInput(SESSION)).toHaveCount(0);
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

test('spawn delivers its task to the agent, as one argument', async () => {
  await backToOrchestrator();

  /**
   * A task that is *also* a valid shell command, which is the whole point.
   *
   * If it reaches the agent as an argument — what HIVE-91 made it — the marker
   * is never written and the task appears verbatim in the argv record. If it is
   * ever typed into the pty again, the shell runs it and the marker appears.
   * One task, two mutually exclusive outcomes, and the file system says which.
   */
  const pwned = out('pwned.txt');
  const task = `echo pwned > '${pwned}'`;

  await run(`spawn ${PROJECT} ${task}`);

  // Arrived, and as a single argument: the argv record has it on one line.
  await expect
    .poll(() => readMarker(out('argv.txt'))?.split('\n'), { timeout: 20_000 })
    .toContain(task);

  /**
   * And the shell never ran it. This is the reported defect, at the only layer
   * that can see it: a real pty, a real login shell, and a `claude` that
   * exits non-zero — the exact state a missing or broken binary leaves behind.
   */
  expect(existsSync(pwned)).toBe(false);
});

test('send resolves a target that is not a key in the entities map', async () => {
  /**
   * HIVE-92 through the UI, and the case-insensitive form is what makes it a
   * *behavioural* assertion rather than a tautological one.
   *
   * The console used to do `entities[target]`, so only an exact key resolved.
   * `SESS-01` is not a key — it would have answered `no such session: SESS-01`
   * and routed nothing. That it now reaches the same pty is proof the lookup is
   * a resolver rather than an index, which is the whole of the fix; the
   * name-carrying cases a ticket spawn produces are pinned in
   * `tests/stores/hive-store.test.ts`, where a ticket can be spawned without a
   * Jira fixture.
   *
   * The confirmation is asserted too: it must name the row (`sess-01`) rather
   * than echo the typing, or a user cannot tell a match from a miss.
   */
  await backToOrchestrator();
  const marker = out('by-case.txt');

  await run(`send ${SESSION.toUpperCase()} echo case-ok > '${marker}'`);

  await expect
    .poll(consoleText, { timeout: 15_000 })
    .toContain(`routed → ${SESSION}`);
  expect(await consoleText()).not.toContain(
    `no such session: ${SESSION.toUpperCase()}`,
  );
  await expectMarker(marker, 'case-ok');
});
