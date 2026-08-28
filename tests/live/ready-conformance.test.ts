// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createReceiver } from '../../electron/main/hooks/receiver';
import { hookSettings } from '../../electron/main/hooks/settings';

/** Not exercised by this suite — the ready signal, not the ledger. */
const noLedger = {
  onLedgerRead: () => ({ entries: [], openAsks: [], claims: {} }),
  onLedgerPost: () => ({ ok: false as const, status: 503, reason: 'not exercised by this test' }),
};

/**
 * The ready signal, against a real `claude` (HIVE-101).
 *
 * ## Why this suite has to exist
 *
 * Because this app has already been wrong about exactly this. `SessionStart`
 * was subscribed over http for months and **never arrived** — a fact recorded
 * in `hook-contract.ts` only after someone measured it, and one that no unit
 * test could have found: the settings file was correct, the receiver was
 * correct, the route was correct, and the event simply did not come.
 *
 * The boot cover is built on the `command` handler for that same event. Taking
 * on faith that a *different handler type* on a known-unreliable event fires
 * would be repeating the original mistake with more confidence.
 *
 * ## What it proves that nothing else can
 *
 * That Claude Code runs the command, with the environment interpolated, early
 * enough to matter. `settings.test.ts` proves the file says the right thing;
 * `receiver.test.ts` proves the route answers correctly. Only the real binary
 * can say whether the two ever meet.
 *
 * A real pty, because the TUI behaves differently without one — the same reason
 * `hook-conformance.test.ts` drives its `claude` through `pty.fork`.
 *
 * ## Why it is opt-in
 *
 * It spawns a real `claude`, which costs real tokens and takes tens of seconds.
 *
 * ```
 * pnpm test:ready
 * ```
 */
const enabled = process.env.HIVE_LIVE_READY_PROOF === '1';

/** The Hive id this run's session answers to, echoed back in the POST header. */
const ENTITY = 'sess-live-ready';

describe.skipIf(!enabled)('ready-signal conformance', () => {
  it('reports itself up, over the command hook, within seconds', async () => {
    const readies: string[] = [];
    let firstAt: number | null = null;
    const started = Date.now();

    const receiver = createReceiver({
      onEvent: () => {},
      onCleared: () => {},
      onTicketIntent: () => {},
      onMetrics: () => {},
      onDone: () => {},
      onReady: (entityId) => {
        firstAt ??= Date.now() - started;
        readies.push(entityId);
      },
      knowsSession: (entityId) => entityId === ENTITY,
      ...noLedger,
    });

    const url = await receiver.start();
    expect(url).not.toBeNull();

    try {
      const dir = mkdtempSync(join(tmpdir(), 'hive-ready-'));
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify(
          hookSettings(url as string, receiver.readyUrl as string),
        ),
        'utf8',
      );

      /*
        The environment carries the two variables the hook interpolates. Getting
        this wrong is the failure mode the receiver answers 403 to, which looks
        exactly like a wrong token — so it is worth naming that both are set
        here the way `sessions/index.ts` sets them on a real pty.
      */
      const driver = [
        'import os, pty, time, select',
        `env = dict(os.environ, HIVE_SESSION_ID=${JSON.stringify(ENTITY)}, HIVE_HOOK_TOKEN=${JSON.stringify(receiver.token)}, TERM='xterm-256color')`,
        "env.pop('CLAUDE_CODE_CHILD_SESSION', None)",
        `argv = ['claude', '--settings', ${JSON.stringify(settingsPath)}, '--model', 'haiku']`,
        'pid, fd = pty.fork()',
        "if pid == 0: os.execvpe('claude', argv, env)",
        'start = time.time()',
        // Long enough for a cold start, short enough not to hang the suite.
        'while time.time() - start < 25:',
        '    r, _, _ = select.select([fd], [], [], 0.3)',
        '    if r:',
        '        try: d = os.read(fd, 65536)',
        '        except OSError: break',
        '        if not d: break',
        'try: os.kill(pid, 9)',
        'except Exception: pass',
      ].join('\n');

      await new Promise<void>((resolve) => {
        const child = spawn('python3', ['-c', driver], { stdio: 'ignore' });
        child.on('exit', () => resolve());
      });
    } finally {
      await receiver.stop();
    }

    console.info('READY AT', firstAt, 'ms · arrivals', readies.length);

    expect(readies).toContain(ENTITY);
    /*
      Not merely "eventually". The whole value of this signal over the status
      line is that it lands as soon as the UI does — measured at ~2s — and a
      regression to something that arrives after the first turn would leave the
      cover up through the entire boot *and* the user's first question.
    */
    expect(firstAt).not.toBeNull();
    /*
      `?? Infinity` rather than a cast: `firstAt` is only ever assigned inside a
      callback, so TypeScript still believes it is `null` here and a `as number`
      is a lie the compiler happens to accept. This fails on a null instead.
    */
    expect(firstAt ?? Number.POSITIVE_INFINITY).toBeLessThan(20_000);
  }, 60_000);
});
