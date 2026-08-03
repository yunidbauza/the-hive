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

/**
 * A **real** pseudo-terminal, under Electron's ABI (story 092).
 *
 * This is the one assertion the unit suite structurally cannot make. `node-pty`
 * is mocked there — a unit test that spawns real processes is a unit test that
 * leaks them — so everything it proves is plumbing. Whether a kernel pty pair
 * actually exists behind the session, whether `TERM` reached the child, and
 * whether `isatty()` returns true is only answerable by running one.
 *
 * Story 098 owns the full conformance suite. These are the headline claims,
 * asserted now rather than deferred, because "the terminal is real" is the
 * entire point of the epic.
 */
test('spawns a real pty: a real shell, a real TERM, and a real tty', async ({
  hive,
}) => {
  const transcript = await hive.evaluate(async ({ utilityProcess }, entry) => {
    const child = utilityProcess.fork(entry, [], {
      serviceName: 'hive-pty-host-probe',
    });

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('the shell never exited'));
      }, 20_000);

      let output = '';

      child.on('spawn', () => {
        child.postMessage({
          type: 'spawn',
          sessionId: 'probe',
          // `sh`, not `zsh`: this has to hold on any machine CI runs on.
          shell: '/bin/sh',
          args: [],
          cwd: '/',
          env: {},
          // Wide enough that the echoed command cannot wrap into the middle of
          // an assertion. A wrapped line inserts a CR and splits the token.
          cols: 400,
          rows: 24,
        });
      });

      child.on('message', (message: { type: string; chunk?: string }) => {
        if (message.type === 'data') output += message.chunk ?? '';

        if (message.type === 'spawned') {
          // `test -t 0` is the assertion that matters most: it is `isatty()`,
          // which is why interactive tools enable their interactive paths at
          // all — and why Claude Code's TUI renders.
          //
          // The leak check matches variable **names against the deny-list**,
          // anchored. A loose `grep ELECTRON` over whole `env` lines also
          // matches this suite's own `PW_ELECTRON_ONLY` flag and any variable
          // whose *value* happens to contain the word — which is how the
          // first version of this test managed to fail against a correctly
          // sanitised environment.
          //
          // Leaked names are listed rather than counted, so a failure names
          // the offender instead of just saying "not zero".
          child.postMessage({
            type: 'write',
            sessionId: 'probe',
            data: 'echo "T=$TERM C=$COLORTERM TTY=$(test -t 0 && echo yes || echo no) LEAK=[$(env | cut -d= -f1 | grep -E \'^(ELECTRON_|GDK_PIXBUF_|CHROME_|NODE_OPTIONS$|NODE_PATH$)\' | tr \'\\n\' \' \')]"; exit\n',
          });
        }

        if (message.type === 'exit') {
          clearTimeout(timer);
          const captured = output;
          child.postMessage({ type: 'shutdown' });
          resolve(captured);
        }
      });
    });
  }, HOST_ENTRY);

  // The single most consequential option: it is how every program in the
  // terminal decides what it may emit.
  expect(transcript).toContain('T=xterm-256color');
  // Without this, some tools quantise the truecolor palette to 256.
  expect(transcript).toContain('C=truecolor');
  // A kernel pty pair really is behind this, not a pipe. This is `isatty()`,
  // and it is why Claude Code's TUI renders at all.
  expect(transcript).toContain('TTY=yes');
  // The bug class that produces "it works in my terminal but not in the app".
  // The empty brackets are the assertion; a failure prints the leaked names.
  expect(transcript).toContain('LEAK=[]');
});
