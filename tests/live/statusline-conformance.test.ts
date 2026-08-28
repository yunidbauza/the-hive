// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createReceiver } from '../../electron/main/hooks/receiver';
import { metricsScript } from '../../electron/main/hooks/settings';
import {
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
} from '../../electron/shared/hook-contract';
import type { SessionMetrics } from '../../electron/shared/metrics-contract';

/** Not exercised by this suite — the status line path, not the ledger. */
const noLedger = {
  onLedgerRead: () => ({ entries: [], openAsks: [], claims: {} }),
  onLedgerPost: () => ({ ok: false as const, status: 503, reason: 'not exercised by this test' }),
};

/**
 * Run the script with a payload on stdin and collect everything it emitted.
 *
 * `spawn` rather than `promisify(execFile)`, which has no way to *write* stdin —
 * the script blocks on `cat` forever and the test times out having proved
 * nothing. Writing the payload and closing the pipe is the whole point.
 */
const run = (
  path: string,
  env: NodeJS.ProcessEnv,
  payload: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> =>
  new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [path], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(payload);
  });

/**
 * Status line conformance: the script this app writes, actually run (HIVE-79).
 *
 * ## Why this is not covered by the unit tests next door
 *
 * `settings.test.ts` asserts the *text* of the generated script — that it
 * contains `-o /dev/null`, that it guards on both variables, that it ends in
 * `exit 0`. Every one of those assertions was written by the same author as the
 * script, against the same belief about what `sh` and `curl` do with it. A
 * missing backslash in a line continuation, a quote that does not survive
 * interpolation, or a `curl` flag that writes to stdout after all would pass
 * all of them and still put a line of JSON in the user's terminal.
 *
 * So this executes it: a real `/bin/sh`, a real `curl`, a real receiver on a
 * real loopback socket, and a payload shaped like the one Claude Code sends.
 * The two properties it proves are the two the whole design rests on — the
 * receiver ends up holding the numbers, and **nothing reaches stdout**.
 *
 * ## Why it is opt-in
 *
 * It needs `curl` and a loopback socket, and it spawns processes. That is a
 * different risk profile from the rest of the suite, which is exactly the line
 * `tests/live/` exists to draw. Run it with:
 *
 * ```
 * HIVE_LIVE_STATUSLINE_PROOF=1 pnpm exec vitest run tests/live/statusline-conformance.test.ts
 * ```
 */
const enabled = process.env.HIVE_LIVE_STATUSLINE_PROOF === '1';

/** A payload trimmed to the fields the app reads, in Claude Code's own shape. */
const PAYLOAD = {
  hook_event_name: 'Status',
  session_id: '11111111-2222-4333-8444-555555555555',
  model: { id: 'claude-opus-4-5', display_name: 'Opus 4.5' },
  effort: { level: 'high' },
  context_window: {
    used_percentage: 46,
    context_window_size: 1_000_000,
    total_input_tokens: 460_000,
  },
  rate_limits: {
    five_hour: { used_percentage: 12, resets_at: 1_786_000_000 },
    seven_day: { used_percentage: 63, resets_at: 1_786_200_000 },
  },
  workspace: { current_dir: '/repos/the-hive' },
  version: '2.1.227',
};

describe.skipIf(!enabled)('status line conformance', () => {
  it('forwards the payload and prints absolutely nothing', async () => {
    const reported: { entityId: string; metrics: SessionMetrics }[] = [];

    const receiver = createReceiver({
      onEvent: () => {},
      onCleared: () => {},
      onTicketIntent: () => {},
      onMetrics: (entityId, metrics) => reported.push({ entityId, metrics }),
      onDone: () => {},
      onReady: () => {},
      knowsSession: (entityId) => entityId === 'sess-live',
      ...noLedger,
    });

    const started = await receiver.start();
    expect(started).not.toBeNull();

    try {
      const dir = mkdtempSync(join(tmpdir(), 'hive-statusline-'));
      const path = join(dir, 'statusline.sh');
      writeFileSync(path, metricsScript(receiver.metricsUrl as string), 'utf8');
      chmodSync(path, 0o700);

      // The payload arrives on stdin, exactly as Claude Code delivers it.
      const { stdout, stderr, code } = await run(
        path,
        {
          ...process.env,
          [HOOK_ENV_SESSION]: 'sess-live',
          [HOOK_ENV_TOKEN]: receiver.token,
        },
        JSON.stringify(PAYLOAD),
      );
      expect(code).toBe(0);

      /**
       * The assertion the terminal's appearance depends on.
       *
       * Claude Code renders whatever a status line prints. One stray byte here
       * — a curl progress meter, an error, a response body — becomes a visible
       * status line in every Hive session, showing the same numbers the header
       * shows six inches above it.
       */
      expect(stdout).toBe('');
      expect(stderr).toBe('');

      expect(reported).toEqual([
        {
          entityId: 'sess-live',
          metrics: {
            model: 'Opus 4.5',
            effort: 'high',
            contextPct: 46,
            contextWindow: 1_000_000,
            fiveHourPct: 12,
            fiveHourResetsAt: 1_786_000_000,
            sevenDayPct: 63,
            sevenDayResetsAt: 1_786_200_000,
          },
        },
      ]);
    } finally {
      await receiver.stop();
    }
  });

  /**
   * The app can quit while a session keeps running, which leaves every live
   * session's status line POSTing to a closed port every thirty seconds. That
   * must be invisible: a non-zero exit surfaces in the user's terminal as a
   * failing status line command.
   */
  it('stays silent and exits zero when the receiver has gone away', async () => {
    const receiver = createReceiver({
      onEvent: () => {},
      onCleared: () => {},
      onTicketIntent: () => {},
      onMetrics: () => {},
      onDone: () => {},
      onReady: () => {},
      knowsSession: () => true,
      ...noLedger,
    });
    await receiver.start();
    const url = receiver.metricsUrl as string;
    await receiver.stop();

    const dir = mkdtempSync(join(tmpdir(), 'hive-statusline-dead-'));
    const path = join(dir, 'statusline.sh');
    writeFileSync(path, metricsScript(url), 'utf8');

    const { stdout, stderr, code } = await run(
      path,
      {
        ...process.env,
        [HOOK_ENV_SESSION]: 'sess-live',
        [HOOK_ENV_TOKEN]: receiver.token,
      },
      JSON.stringify(PAYLOAD),
    );

    expect(stdout).toBe('');
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });

  /**
   * A session spawned before the receiver bound carries neither variable. The
   * script must decline rather than POST an unattributable body.
   */
  it('declines to POST when the environment names no session', async () => {
    const reported: string[] = [];
    const receiver = createReceiver({
      onEvent: () => {},
      onCleared: () => {},
      onTicketIntent: () => {},
      onMetrics: (entityId) => reported.push(entityId),
      onDone: () => {},
      onReady: () => {},
      knowsSession: () => true,
      ...noLedger,
    });
    await receiver.start();

    try {
      const dir = mkdtempSync(join(tmpdir(), 'hive-statusline-bare-'));
      const path = join(dir, 'statusline.sh');
      writeFileSync(path, metricsScript(receiver.metricsUrl as string), 'utf8');

      const bare = { ...process.env };
      delete bare[HOOK_ENV_SESSION];
      delete bare[HOOK_ENV_TOKEN];

      const { stdout } = await run(path, bare, JSON.stringify(PAYLOAD));

      expect(stdout).toBe('');
      expect(reported).toEqual([]);
    } finally {
      await receiver.stop();
    }
  });
});
