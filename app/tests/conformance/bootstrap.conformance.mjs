import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assert, describe, emitSentinel, it, waitFor } from './harness.mjs';

/**
 * The bootstrap sequence, against real processes (story 098).
 *
 * The integration row of the matrix, and a **deliberate deviation** from the
 * ticket, agreed before implementation.
 *
 * The ticket asks this group to spawn "the real bootstrap". It cannot: the
 * bootstrap lives in `electron/main/sessions/`, above the host, and driving it
 * needs the supervisor and `utilityProcess` — an Electron *main-process* API
 * that does not exist under `ELECTRON_RUN_AS_NODE`. What this layer can do, and
 * what actually matters, is prove the **sequence** against real processes:
 * a login shell starts, a command is written into it as input, it runs, and the
 * shell survives it.
 *
 * The ordering constants are `BOOTSTRAP_DEBOUNCE_MS` and
 * `BOOTSTRAP_FALLBACK_MS` in `electron/shared/session-contract.ts`; the *policy*
 * of when to write is unit-tested there with fake timers. This asserts the part
 * fake timers cannot: that writing it that way works on a real pty.
 *
 * `claude` is a **stub** on `PATH`, named per config. Claude Code is not this
 * repository's software to test, may not be installed, and is certainly not
 * authenticated in CI. The real binary is exercised manually and in story 085's
 * desktop spec.
 */

/** Everything main resolves before the host ever sees it (story 096). */
const LOGIN_SHELL_ARGS = ['-l'];

function writeStub(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { encoding: 'utf8' });
  chmodSync(path, 0o755);
  return path;
}

/**
 * Write the command once the shell has settled.
 *
 * The same shape as `sessions/bootstrap.ts`: wait for the first output, let it
 * settle, then write. Characters written before the shell installs its line
 * discipline land in a buffer it may discard, and the session then sits at a
 * bare prompt having silently swallowed the command — which looks exactly like
 * the app failing to start `claude` at all.
 */
async function bootstrap(session, command) {
  await waitFor(() => session.output.length > 0, {
    message: 'the shell to produce its first output',
  });
  // Settled, not slept: quiet for two consecutive polls is the observable that
  // "the prompt has finished drawing" actually has.
  await waitFor(
    async () => {
      const before = session.output.length;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return session.output.length === before;
    },
    { timeout: 8_000, message: 'the shell to stop printing' },
  );
  session.send(command);
}

describe('bootstrap', () => {
  it('a login shell runs the configured command, written as input', async (context) => {
    const marker = join(context.scratch, 'ran.txt');
    writeStub(context.scratch, 'claude', `printf 'STUB-CLAUDE-RAN\\n'\npwd > '${marker}'`);

    const session = context.open({
      shell: '/bin/sh',
      args: LOGIN_SHELL_ARGS,
      env: { PATH: `${context.scratch}:${process.env.PATH ?? ''}` },
    });

    await bootstrap(session, 'claude');

    await session.waitForOutput('STUB-CLAUDE-RAN', { timeout: 15_000 });
  });

  it('the shell outlives the command it bootstrapped', async (context) => {
    writeStub(context.scratch, 'claude', "printf 'STUB-CLAUDE-RAN\\n'");

    const session = context.open({
      shell: '/bin/sh',
      args: LOGIN_SHELL_ARGS,
      env: { PATH: `${context.scratch}:${process.env.PATH ?? ''}` },
    });

    await bootstrap(session, 'claude');
    await session.waitForOutput('STUB-CLAUDE-RAN', { timeout: 15_000 });

    /**
     * The whole argument for writing the command as *input* rather than
     * `$SHELL -l -c claude`.
     *
     * With `-c` the shell exits with the command, leaving the user looking at a
     * corpse in the middle of a repository they were working in — unable to run
     * `git diff`, rerun the tests, or start another turn without a new session.
     */
    assert.equal(session.exit, null, 'the shell must not have exited');
    session.send(emitSentinel('SHELL-STILL-ALIVE'));
    await session.waitForOutput('SHELL-STILL-ALIVE', { timeout: 8_000 });
  });

  it('the command runs in the session’s directory', async (context) => {
    writeStub(context.scratch, 'claude', 'pwd');

    const session = context.open({
      shell: '/bin/sh',
      args: LOGIN_SHELL_ARGS,
      env: { PATH: `${context.scratch}:${process.env.PATH ?? ''}` },
    });

    await bootstrap(session, `claude && ${emitSentinel('CWD-CHECKED')}`);
    await session.waitForOutput('CWD-CHECKED', { timeout: 15_000 });

    // Resolved on both sides: macOS reaches the temp dir through a
    // /var → /private/var symlink, so the raw strings differ.
    session.send(
      `test "$(pwd -P)" = "$(cd '${context.scratch}' && pwd -P)" && ${emitSentinel('CWD-OK')}`,
    );
    await session.waitForOutput('CWD-OK', { timeout: 8_000 });
  });

  it('a command that exits non-zero still leaves a usable shell', async (context) => {
    writeStub(context.scratch, 'claude', "printf 'STUB-FAILING\\n'\nexit 3");

    const session = context.open({
      shell: '/bin/sh',
      args: LOGIN_SHELL_ARGS,
      env: { PATH: `${context.scratch}:${process.env.PATH ?? ''}` },
    });

    await bootstrap(session, 'claude');
    await session.waitForOutput('STUB-FAILING', { timeout: 15_000 });

    // The failure the user most needs to recover from — `claude` not starting —
    // must leave them somewhere they can fix it.
    assert.equal(session.exit, null);
    session.send(emitSentinel('RECOVERABLE'));
    await session.waitForOutput('RECOVERABLE', { timeout: 8_000 });
  });

  it('a missing command reports itself and leaves the shell alive', async (context) => {
    const session = context.open({
      shell: '/bin/sh',
      args: LOGIN_SHELL_ARGS,
      env: { PATH: context.scratch },
    });

    await bootstrap(session, 'definitely-not-a-real-binary');

    // `command not found` in an app whose entire purpose is running `claude` is
    // the exact failure `-l` exists to prevent; when it happens anyway, it must
    // be visible rather than a session that silently does nothing.
    await session.waitForOutput(/not found/, { timeout: 15_000 });
    assert.equal(session.exit, null);
  });
});
