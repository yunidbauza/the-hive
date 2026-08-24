import { join } from 'node:path';

import { test as base, expect } from '@playwright/test';

import {
  launchHive,
  startSession,
  writeProjectConfig,
} from './fixtures/hive-app';

/**
 * The fleet survives a quit (HIVE-87).
 *
 * This spec deliberately does **not** use the `hive` fixture, for the reason
 * `window-state.spec.ts` gives about geometry: the fixture gives one app per
 * test, and the only honest proof here is two launches against the same profile
 * with a genuine `close()` in between. Asserting that `sessions.json` was
 * written would prove the ledger writes; it would not prove the fleet comes
 * back, which is the whole feature.
 *
 * It is also the only place anything checks the *inference* end to end — that a
 * session which was running at the quit returns as `closed` rather than as the
 * `working` the file still says it was.
 */
const test = base;

const PROJECT = 'apfm-web';
const REAL_DIRECTORY = join(import.meta.dirname, '../../..');

test('start a session, quit, relaunch — it is still listed, under PREVIOUS RUN', async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath('user-data');
  const configPath = testInfo.outputPath('hive-config.json');
  writeProjectConfig(configPath, { id: PROJECT, path: REAL_DIRECTORY });

  const first = await launchHive({ userDataDir, configPath });
  const firstWindow = await first.firstWindow();
  await firstWindow.waitForLoadState('domcontentloaded');
  await firstWindow.waitForSelector('header');

  const id = await startSession(firstWindow, PROJECT);

  /*
    The ledger write is debounced at 400ms like the window state's, and the
    shutdown flush races the pty teardown by design — so this waits rather than
    relying on the flush, which is exactly the guarantee the module refuses to
    make.
  */
  await firstWindow.waitForTimeout(700);
  await first.close();

  const second = await launchHive({ userDataDir, configPath });
  const secondWindow = await second.firstWindow();
  await secondWindow.waitForLoadState('domcontentloaded');
  await secondWindow.waitForSelector('header');

  try {
    // The app boots into the orchestrator, so the table is already on screen.
    await expect(secondWindow.getByText('PREVIOUS RUN')).toBeVisible();

    const row = secondWindow.getByRole('button', { name: new RegExp(id) });
    await expect(row).toBeVisible();

    /*
      An ending, whichever one the quit produced.

      Deliberately not pinned to `closed`. Which ending this row carries depends
      on the race the ledger documents and refuses to arbitrate: if the pty exit
      is forwarded before the app finishes tearing down, `settleExit` records
      `terminated`; if the app dies first, the record still says `working` and
      the renderer infers `closed`. Both are correct outcomes of the same quit,
      and asserting one of them here would be asserting the race.

      What is invariant — and what this spec exists for — is that the row comes
      back and is grouped as a previous run. The `closed` inference itself is
      pinned deterministically in `tests/stores/hive-store.test.ts`, where there
      is no race to lose.
    */
    const ending = await row.textContent();
    expect(ending).toMatch(/closed|terminated/);

    /*
      Openability follows the ending, so it is *read* from the row rather than
      assumed — and that is the whole repair (HIVE-92 found it; HIVE-88 caused
      it).

      The branch that used to be here is gone with the rule it pinned. HIVE-88
      made a restored row the one ending that *opened*, because clicking it was
      how the conversation resumed; HIVE-93 gave resume its own control, so the
      row is inert again like every other ending and this can go back to being
      unconditional.

      Which also restores the property the branch was working around: the
      assertion above deliberately refuses to arbitrate the quit race, and this
      one now holds for either outcome rather than only for `terminated`.
    */
    await expect(row).toBeDisabled();
  } finally {
    await second.close();
  }
});

test('a fresh profile still boots with an empty fleet', async ({}, testInfo) => {
  /*
    The other half of the claim: history is additive. A machine that has never
    run The Hive must open exactly as it did before this feature existed, and a
    deleted `sessions.json` must return it to that state rather than erroring.
  */
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath: testInfo.outputPath('hive-config.json'),
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForSelector('header');

  try {
    await expect(window.getByTestId('session-table-empty')).toBeVisible();
    await expect(window.getByText('PREVIOUS RUN')).toBeHidden();
  } finally {
    await app.close();
  }
});
