import { join } from 'node:path';

import { expect, test } from './fixtures/hive-app';

/**
 * The pty host as a real process (story 091).
 *
 * The supervisor's unit tests drive a fake child, which proves the supervision
 * logic and nothing about Electron. This file proves the parts only a real app
 * can: that no host exists until one is asked for, and that the **bundled**
 * host actually forks under Electron and speaks the protocol.
 *
 * That second claim is not a formality. `out/main/` is ESM, so the host is an
 * ESM entry forked through `utilityProcess` — a combination that either works
 * or fails at load with an error naming neither. Asserting it here means a
 * regression shows up as a red spec rather than as a terminal that never opens.
 */

/** The built host, beside `out/main/index.js` exactly as the supervisor expects. */
const HOST_ENTRY = join(import.meta.dirname, '../../../out/main/pty-host.js');

test('no pty host exists at launch — it starts lazily, on the first session', async ({
  hive,
  page,
}) => {
  await page.waitForSelector('header');

  const utilities = await hive.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .filter((metric) => metric.type === 'Utility')
      .map((metric) => metric.serviceName ?? metric.name ?? 'unnamed'),
  );

  // Most launches land on the orchestrator console, which owns no PTY.
  // Starting a process for it is waste, and this is what proves we do not.
  expect(utilities).not.toContain('hive-pty-host');
});

test('the bundled host forks under Electron and answers the heartbeat', async ({
  hive,
}) => {
  const result = await hive.evaluate(async ({ utilityProcess }, entry) => {
    const child = utilityProcess.fork(entry, [], {
      serviceName: 'hive-pty-host-probe',
    });

    return new Promise<{ pong: unknown; exitCode: number }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('the host never answered')),
          10_000,
        );

        let pong: unknown = null;

        child.on('spawn', () => {
          child.postMessage({ type: 'ping', seq: 99 });
        });

        child.on('message', (message: unknown) => {
          pong = message;
          // Graceful teardown is the other half of the protocol: the host
          // kills everything it owns, then exits on its own.
          child.postMessage({ type: 'shutdown' });
        });

        child.on('exit', (exitCode: number) => {
          clearTimeout(timer);
          resolve({ pong, exitCode });
        });
      },
    );
  }, HOST_ENTRY);

  // Same sequence number back: the loop is alive and the protocol matches.
  expect(result.pong).toEqual({ type: 'pong', seq: 99 });
  // It left on request rather than being killed.
  expect(result.exitCode).toBe(0);
});

test('a spawn request reaches the real host and is answered, not swallowed', async ({
  hive,
}) => {
  const reply = await hive.evaluate(async ({ utilityProcess }, entry) => {
    const child = utilityProcess.fork(entry, [], {
      serviceName: 'hive-pty-host-probe',
    });

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the host never answered the spawn')),
        10_000,
      );

      child.on('spawn', () => {
        child.postMessage({
          type: 'spawn',
          sessionId: 'hero-refresh',
          shell: '/bin/zsh',
          args: [],
          cwd: '/',
          env: {},
          cols: 80,
          rows: 24,
        });
      });

      child.on('message', (message: unknown) => {
        clearTimeout(timer);
        child.kill();
        resolve(message);
      });
    });
  }, HOST_ENTRY);

  // Story 091 ships the host, not the PTYs. What matters is that the request
  // is *answered* — a session that never opens and never says why is the
  // failure mode the placeholder exists to prevent until story 092 lands.
  expect(reply).toEqual({
    type: 'error',
    sessionId: 'hero-refresh',
    message: expect.stringContaining('092'),
  });
});
