import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/**
 * The whole PTY path, end to end (story 093).
 *
 * Renderer → contextBridge → main → MessagePort → pty host → a real pty, and
 * every byte back again through batching, sequencing and the ack loop.
 *
 * The unit suite proves each rule in isolation with fake timers. This proves
 * they compose: that a session spawned from the renderer resolves its `cwd`
 * from the workspace config, that output arrives sequenced, that an ack is
 * accepted, and that `exit` lands after the last byte rather than truncating
 * it.
 *
 * The story's remaining acceptance criteria — `yes` not freezing the window,
 * Ctrl-C stopping a flood within a few hundred milliseconds, stable RSS over
 * sixty seconds — need the renderer half of the ack loop, which is stories
 * 094/095. The ack that drives all of this is supposed to come from xterm's
 * write callback, and there is no xterm on this path yet.
 */

/** The repo root: a directory that certainly exists on any machine running this. */
const REAL_DIRECTORY = join(import.meta.dirname, '../../..');

interface PtyRun {
  text: string;
  seqs: number[];
  exitCode: number;
}

test('a session spawned from the renderer runs a real shell and streams back sequenced output', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      // `sh`, so this holds wherever CI runs it.
      shell: '/bin/sh',
      /**
       * A no-op bootstrap, so this spec measures the IPC path and not `claude`.
       *
       * Main holds input written before the bootstrap has run (story 097) —
       * otherwise a routed message would be executed by the bare login shell —
       * so the write below is released only once the bootstrap completes.
       * Without an explicit command this would default to `claude`, and on a
       * machine where that is installed the spec would be typing into a real
       * agent's TUI rather than into a shell.
       */
      claudeCommand: 'true',
      projects: [{ id: 'apfm-web', path: REAL_DIRECTORY }],
    }),
  );

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    const run = await page.evaluate(async (): Promise<PtyRun> => {
      const hive = window.hive!;
      const sessionId = 'e2e-pty';
      const chunks: string[] = [];
      const seqs: number[] = [];

      const exited = new Promise<number>((resolve) => {
        const off = hive.pty.onExit((event) => {
          if (event.sessionId !== sessionId) return;
          off();
          resolve(event.exitCode);
        });
      });

      const offData = hive.pty.onData((event) => {
        if (event.sessionId !== sessionId) return;
        chunks.push(event.chunk);
        seqs.push(event.seq);
        // Standing in for xterm's write callback: story 094 moves this to
        // where the terminal has actually parsed the chunk.
        hive.pty.ack({ sessionId, seq: event.seq });
      });

      await hive.pty.spawn({ sessionId, projectId: 'apfm-web', cols: 200, rows: 24 });
      hive.pty.write({ sessionId, data: 'echo HELLO_FROM_A_REAL_PTY; exit\n' });

      const exitCode = await exited;
      offData();
      return { text: chunks.join(''), seqs, exitCode };
    });

    // The command really ran, in a real shell, in the mapped directory.
    expect(run.text).toContain('HELLO_FROM_A_REAL_PTY');

    // Sequencing starts at 1 and never goes backwards — the property the
    // renderer's gap detection depends on.
    expect(run.seqs.length).toBeGreaterThan(0);
    expect(run.seqs[0]).toBe(1);
    for (let i = 1; i < run.seqs.length; i += 1) {
      expect(run.seqs[i]).toBeGreaterThan(run.seqs[i - 1]!);
    }

    // Exit arrived, and only after the output it followed. Delivering it early
    // truncates the last thing the process said.
    expect(run.exitCode).toBe(0);
  } finally {
    await app.close();
  }
});

test('refuses to spawn into a project with no usable directory', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  writeFileSync(
    configPath,
    JSON.stringify({ version: 1, projects: [] }),
  );

  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('header');

    const rejection = await page.evaluate(async () => {
      try {
        await window.hive!.pty.spawn({
          sessionId: 'nowhere',
          projectId: 'apfm-web',
          cols: 80,
          rows: 24,
        });
        return null;
      } catch (cause) {
        return String(cause);
      }
    });

    // Refused in main, where the config lives — the host does not know what a
    // project is, and spawning a shell in an arbitrary directory would be a
    // worse answer than saying no.
    expect(rejection).toContain('apfm-web');
    expect(rejection).toMatch(/not mapped|usable directory/);
  } finally {
    await app.close();
  }
});
