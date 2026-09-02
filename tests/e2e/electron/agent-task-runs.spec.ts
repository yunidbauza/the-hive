import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, test } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * Two task runs, live at once, in the built app (HIVE-128).
 *
 * `agents.spec.ts` states plainly that it starts **no** run, because a wake
 * spawns a real `claude`: that costs money and its timing is nobody's to
 * promise. So every claim this story makes about a *running* agent — the run
 * log's live rows, and the `·N` the rail and the fleet count — has so far been
 * proved against a store seeded by hand, or headless against a real binary in
 * `pnpm test:agent`. Neither of those is a browser, and the two claims are
 * about what a browser draws.
 *
 * This spec closes that gap the only way it can be closed cheaply: it points
 * `claudeCommand` at a **stub** — an executable that writes three `stream-json`
 * lines, sleeps, and exits. Everything between the console and that process is
 * the real thing: `parse-command`, `agents:run`, the scheduler's `manualWake`,
 * the tracker's cap, `spawn`, the stdout fold, the `agents:status` push and the
 * renderer that redraws from it. Only the model at the far end is fake.
 *
 * What it deliberately does **not** prove: anything about the agent's turn —
 * the preamble, the ledger tools, the permission fence, the receipt a real run
 * lands. The stub never starts an MCP host and never calls a tool. That half is
 * `tests/live/agent-conformance.test.ts`'s, against a real `claude`.
 */

/**
 * The stub, in the three lines the fold actually reads.
 *
 * `system`/`init` because `foldRunLog` records `mcp_servers` from it and the
 * scheduler's Slack check reads that; one `assistant` text block so the output
 * half has something in it; then a sleep long enough for both runs to overlap
 * on screen, and a `result` so the close records `done` rather than `failed`.
 *
 * Forty-five seconds, not the handful the assertions actually need: the spec
 * only ever waits for the *rows*, and the sleep is what keeps them there while
 * it looks. A slow CI box that spent twenty seconds getting from the first
 * `run` to the row-count assertion would otherwise watch run one end underneath
 * it and fail on a count of one. Nothing waits for the sleep to finish — the
 * app tears the runs down at quit.
 *
 * `#!/bin/sh` and no arguments read: `resolveClaude` accepts an **absolute path
 * to an executable file**, which is exactly what this is, and refuses anything
 * carrying arguments — an agent is spawned without a shell, so the fixture's
 * `'true; false'` session stub could never stand in here.
 */
const STUB = `#!/bin/sh
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"stub","mcp_servers":[]}'
printf '%s\\n' '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"working on it"}]}}'
sleep 45
printf '%s\\n' '{"type":"result","subtype":"success","num_turns":1,"total_cost_usd":0.001,"session_id":"stub"}'
`;

/**
 * An agent that may hold two runs at once, and wakes on nothing.
 *
 * No `wake:` block on purpose. A schedule would let the sweeper start a
 * standing run of its own while the spec is counting, and the count is the
 * assertion — the only two runs in flight here are the two this test typed.
 */
const DEFINITION = `---
name: fanout
description: Runs two jobs at once
icon: Ghost
limits:
  parallel: 2
---
Do the job you were given.
`;

/*
  Launching the app takes several seconds before a single character is typed,
  and the two runs then have to reach the renderer. The 30s default leaves no
  room for either, and a timeout here would read as a product failure.
*/
test.setTimeout(90_000);

test('draws two live task runs and counts them in the rail and the fleet', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  const stub = testInfo.outputPath('stub-claude');

  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);

  /*
    The definition goes straight to disk rather than through Settings › Agents.
    The pane's own round-trip is `agents-settings.spec.ts`'s subject; here it
    would be four clicks between the launch and the thing under test.

    `agentsRoot()` is `dirname(configPath())/agents`, so this lands in the
    test's output directory and never in the developer's real `~/.hive`.
  */
  const folder = join(dirname(configPath), 'agents', 'fanout');

  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'AGENT.md'), DEFINITION);

  writeFileSync(
    configPath,
    JSON.stringify({
      version: 2,
      projects: [],
      // The one setting this spec exists to change.
      claudeCommand: stub,
    }),
  );

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
    // Scratch skill roots, for `agents-settings.spec.ts`'s reason: a name
    // installed on the developer's machine must not decide the result.
    env: { CLAUDE_CONFIG_DIR: testInfo.outputPath('claude-config') },
  });
  const page = await app.firstWindow();

  try {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    const input = page.getByRole('textbox', { name: 'Overmind command' });
    const transcript = page.getByRole('main').locator('.xterm');

    // The agent has to have reached the store before the console can resolve
    // the name — `run` matches against `entities`, not against main's registry.
    await page.getByRole('tab', { name: /Agents/ }).click();

    const panel = page.locator('[data-panel="agents"]');

    await expect(panel.getByRole('button', { name: /fanout/ })).toBeVisible();

    /*
      Two jobs. A `run` **with a prompt** is what makes a wake a job, and a job
      fans out only where `limits.parallel` allows it — so the wording of these
      two lines is the whole precondition for everything below.
    */
    await input.click();
    await input.fill('run fanout say alpha');
    await input.press('Enter');

    // The console names it a task run, not a wake: the sentence is the first
    // proof main chose `kind: 'task'` rather than the standing conversation.
    await expect(transcript).toContainText('started a task run for fanout');

    await input.fill('run fanout say beta');
    await input.press('Enter');

    /*
      The rail counts them. `·2` appears only above one run, so this line is
      also the assertion that the second `run` was not refused `working` — the
      refusal a `parallel: 1` agent would have given it.
    */
    await expect(panel.getByRole('button', { name: /fanout/ })).toContainText(
      'working ·2',
    );

    // And the fleet table, which draws the same count from the same push.
    await expect(
      page.getByTestId('agent-row').locator('[data-col="status"]'),
    ).toHaveText('working ·2');

    // …and the run log draws each of them as its own row, in the receipts'
    // columns, marked as tasks rather than as the standing conversation.
    await panel.getByRole('button', { name: /fanout/ }).click();

    const receipts = page.getByTestId('run-receipts');

    await expect(receipts.locator('[data-live-run="task"]')).toHaveCount(2);
    await expect(receipts.locator('[data-live-run="standing"]')).toHaveCount(0);
    await expect(receipts.getByText('running')).toHaveCount(2);

    // The prompt each job was given rides on its row — which is what tells the
    // two apart, since neither has a receipt yet.
    await expect(receipts.getByTitle('say alpha')).toBeVisible();
    await expect(receipts.getByTitle('say beta')).toBeVisible();

    // Both processes really ran: the output half holds each run's own line,
    // grouped by the run that wrote it.
    await expect(page.getByTestId('run-output')).toContainText('working on it');
  } finally {
    /*
      `close()` reaches `runShutdown`, which signals both children and finalizes
      them — the stub is still sleeping, and a spec that left two of those
      behind on every run would be a leak the suite pays for elsewhere.
    */
    await app.close();
  }
});
