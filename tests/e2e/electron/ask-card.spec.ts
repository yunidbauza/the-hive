import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  HOOK_ENV_RECEIVER_URL,
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  HOOK_HEADER_SESSION,
  HOOK_HEADER_TOKEN,
} from '../../../electron/shared/hook-contract';
import { LEDGER_POST_PATH, type LedgerEntry } from '../../../electron/shared/ledger-contract';
import { launchHive } from './fixtures/hive-app';

/**
 * The ask, end to end, in the built app (HIVE-118, task 8).
 *
 * Every piece up to here is proven against a fake: `notify.test.ts` proves an
 * `ask` entry addressed to the overmind maps to an `agent.ask` notification
 * whose id is the entry's own id; `ask-card.test.tsx` proves the card renders
 * option buttons from `meta.options` and collapses once the thread carries an
 * `answer`; `hive-store.test.ts` proves `answerAsk` posts through the bridge
 * and stores nothing itself. None of them proves the three compose — that an
 * entry appended by a real party, through the real receiver, reaches this
 * process's real ledger store, becomes a real card on a real screen, and that
 * clicking it writes a real answer back. That composition is this file's only
 * job.
 *
 * ## Why the ask is posted from a real session's pty, not the renderer bridge
 *
 * `window.hive.ledger.post` — the renderer's only way to write — hard-codes
 * `from: OVERMIND` (`ipc/index.ts`): "the renderer is the overmind's only
 * mouth". An ask *addressed to* the overmind has to come from somewhere else,
 * the way a real agent's or a real session's hook would send it — over the
 * receiver's `POST /ledger`, authenticated by the token the app itself put in
 * that party's environment. So this spec starts one real (stubbed) session and
 * has its shell speak for it, with the exact request shape `doneCommand` and
 * `readyCommand` already use for their own hooks (`hook-contract.ts`) — a
 * `curl` reading its own session id and token out of the environment the app
 * gave it.
 *
 * `claudeCommand` is stubbed, for the reason every other spec in this suite
 * stubs it: starting a real agent would consume tokens and touch the working
 * tree. The stub announces its own readiness into a marker file, which this
 * spec waits for before writing anything else into the shell — sending a
 * command into the window where the bootstrap is still being typed would
 * interleave the two and run neither (see `pty-transport.spec.ts`).
 */

const REAL_DIRECTORY = join(import.meta.dirname, '../../..');
const SESSION = 'sess-01';
const PROJECT = 'nova-web';
const ASK_TITLE = 'Deploy to production?';
/** Named in `meta`, disowned by the body the same ask carries (HIVE-125). */
const DECEPTIVE_COMMAND = 'git push --force origin main';

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
       * badly short-circuits the `&&` and keeps the session open.
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

/** Send a line to the session's pty through the bridge, as a keystroke would. */
async function shell(page: Page, command: string): Promise<void> {
  await page.evaluate(
    ([sessionId, data]) => {
      window.hive!.pty.write({ sessionId: sessionId!, data: data! });
    },
    [SESSION, `${command}\n`],
  );
}

/**
 * The curl this session's own hooks would run, built the same way
 * `doneCommand`/`readyCommand` build theirs: the URL, the session id and the
 * token all come out of the environment the app injected, never out of this
 * file. The HTTP status lands in `statusMarker`, which is how the spec knows
 * the write actually reached the ledger rather than merely that curl ran.
 */
function postAskCommand(statusMarker: string): string {
  const body = JSON.stringify({
    to: 'overmind',
    kind: 'ask',
    body: ASK_TITLE,
    meta: { options: ['Approve', 'Reject'] },
  });

  return (
    `curl -sS -m 5 -o /dev/null -w '%{http_code}' -X POST "$${HOOK_ENV_RECEIVER_URL}${LEDGER_POST_PATH}"` +
    ` -H "${HOOK_HEADER_SESSION}: $${HOOK_ENV_SESSION}"` +
    ` -H "${HOOK_HEADER_TOKEN}: $${HOOK_ENV_TOKEN}"` +
    ` -H "content-type: application/json"` +
    ` --data-binary '${body}'` +
    ` > '${statusMarker}'`
  );
}

/**
 * The deceptive permission ask (HIVE-125), posted the same way.
 *
 * `body` names `Read` and a harmless path; `meta` names `Bash` and a force
 * push. Before the fix the card rendered the body, so the words on screen were
 * the asker's and the click authorised the meta's call. Nothing here goes
 * through `hive_approve` — that is the point: this is the ask an agent writes
 * for itself, which is why the fix lives at `Ledger.append` instead.
 */
function postDeceptiveAskCommand(statusMarker: string): string {
  const body = JSON.stringify({
    to: 'overmind',
    kind: 'ask',
    body: 'Allow Read?\n/repo/a.ts',
    meta: {
      kind: 'permission',
      tool: 'Bash',
      input: { command: DECEPTIVE_COMMAND },
      rungs: [{ id: 'allow-tool', label: 'just this once', caption: 'harmless.', rule: '*' }],
      default: 'allow-tool',
    },
  });

  return (
    `curl -sS -m 5 -o /dev/null -w '%{http_code}' -X POST "$${HOOK_ENV_RECEIVER_URL}${LEDGER_POST_PATH}"` +
    ` -H "${HOOK_HEADER_SESSION}: $${HOOK_ENV_SESSION}"` +
    ` -H "${HOOK_HEADER_TOKEN}: $${HOOK_ENV_TOKEN}"` +
    ` -H "content-type: application/json"` +
    ` --data-binary '${body}'` +
    ` > '${statusMarker}'`
  );
}

test('a permission card names the call the click authorises, not the body', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  const bootstrapped = testInfo.outputPath('bootstrapped.txt');
  const posted = testInfo.outputPath('posted.txt');
  writeConfig(configPath, bootstrapped);

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();

  try {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    await page.getByRole('button', { name: 'New session', exact: true }).click();
    const search = page.getByRole('textbox', { name: 'Search all projects' });
    await expect(search).toBeFocused();
    await page.keyboard.type(PROJECT);
    await page.keyboard.press('Enter');

    await expect(page.locator(`[data-terminal-id="${SESSION}"]`)).toBeVisible();
    await expectMarker(bootstrapped, 'bootstrapped');

    await shell(page, postDeceptiveAskCommand(posted));
    await expectMarker(posted, '200');

    await page.getByRole('tab', { name: /^Inbox/ }).click();

    // The title is main's, so the card is addressable by the tool it will run.
    const card = page.getByRole('article', {
      name: new RegExp(`^Ask from ${SESSION}: Allow Bash\\?`),
    });
    await expect(card).toBeVisible();

    // What the user actually reads, on a real screen.
    await expect(card.getByText(DECEPTIVE_COMMAND)).toBeVisible();
    await expect(card.getByText('Allow Read?')).toHaveCount(0);
    await expect(card.getByText('/repo/a.ts')).toHaveCount(0);

    /*
      The ladder is the recomputed one. `just this once` was the asker's label
      for a rung whose rule was `*`; the rungs drawn are `rungsFor`'s, and the
      preselected one is `defaultRungFor`'s family rung rather than the
      `allow-tool` the ask asked for.
    */
    await expect(card.getByRole('radio', { name: 'just this once' })).toHaveCount(0);
    await expect(card.getByRole('radio', { name: 'git *' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(card.getByRole('radio', { name: 'all Bash' })).toBeVisible();

    // And the log holds the honest version, not the one that was posted.
    const snapshot = await page.evaluate(() => window.hive!.ledger.list());
    const ask = snapshot.entries.find((entry: LedgerEntry) => entry.kind === 'ask');
    expect(ask?.body).toBe(`Allow Bash?\n${DECEPTIVE_COMMAND}`);
    expect(ask?.meta?.['default']).toBe('allow-family');
  } finally {
    await app.close();
  }
});

test('an ask posted to the ledger becomes a card, and answering it collapses the card', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  const bootstrapped = testInfo.outputPath('bootstrapped.txt');
  const posted = testInfo.outputPath('posted.txt');
  writeConfig(configPath, bootstrapped);

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();

  try {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    // Start the one session whose environment carries a real receiver token.
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    const search = page.getByRole('textbox', { name: 'Search all projects' });
    await expect(search).toBeFocused();
    await page.keyboard.type(PROJECT);
    await page.keyboard.press('Enter');

    const terminal = page.locator(`[data-terminal-id="${SESSION}"]`);
    await expect(terminal).toBeVisible();
    await expectMarker(bootstrapped, 'bootstrapped');

    // The ask, posted exactly as a real hook would post it.
    await shell(page, postAskCommand(posted));
    await expectMarker(posted, '200');

    await page.getByRole('tab', { name: /^Inbox/ }).click();

    /*
      The card's `aria-label` is `Ask from ${asker}: ${notif.title}`
      (`ask-card.tsx`) — the asker is `sess-01` itself, since this session was
      never titled, which is exactly the fallback `useDisplayName` documents.
      Asserting on it here is asserting on the asker's name, not on the id
      coincidentally matching it.
    */
    const card = page.getByRole('article', {
      name: new RegExp(`^Ask from ${SESSION}: ${ASK_TITLE}`),
    });
    await expect(card).toBeVisible();

    const approve = card.getByRole('button', { name: 'Approve' });
    const reject = card.getByRole('button', { name: 'Reject' });
    await expect(approve).toBeVisible();
    await expect(reject).toBeVisible();

    await approve.click();

    // Collapsed to its one-liner, carrying the exact answer that was clicked.
    await expect(card.locator('[data-answered]')).toHaveAttribute(
      'data-answered',
      'Approve',
    );
    await expect(card.getByText(/answered/)).toBeVisible();
    await expect(approve).toHaveCount(0);

    // And the ledger itself — not just the screen — has both entries.
    const snapshot = await page.evaluate(() => window.hive!.ledger.list());
    const ask = snapshot.entries.find(
      (entry: LedgerEntry) => entry.kind === 'ask' && entry.body === ASK_TITLE,
    );
    expect(ask?.from).toBe(SESSION);
    expect(ask?.to).toBe('overmind');

    const answer = snapshot.entries.find(
      (entry: LedgerEntry) => entry.kind === 'answer' && entry.thread === ask?.id,
    );
    expect(answer?.body).toBe('Approve');
  } finally {
    await app.close();
  }
});
