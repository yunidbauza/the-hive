import {
  assert,
  describe,
  emitSentinel,
  isAlive,
  it,
  startGrandchild,
  waitFor,
} from './harness.mjs';

/**
 * Signals and job control (story 098).
 *
 * The group Vitest structurally cannot cover: `node-pty` is mocked there, and
 * a mock can assert that `write` was called with `\x03` — it cannot assert
 * that SIGINT was *delivered to a process group*. That is a kernel property,
 * and this is the only layer that can see it.
 *
 * Ctrl-C is the headline. It is the assertion most likely to silently regress:
 * a change in how bytes are forwarded turns `\x03` into three literal
 * characters, and every other test in the repository still passes.
 */

const CTRL_C = '\x03';
const CTRL_D = '\x04';

describe('signals', () => {
  it('ctrl-c interrupts the foreground job', async (context) => {
    const session = await context.ready(context.open());

    // Would run for a hundred seconds if it were ever allowed to.
    /**
     * `&&`, not `;`. An interrupted `sleep` exits non-zero, and a `;` would run
     * the sentinel anyway — the assertion below would then fail on a *correct*
     * interrupt, which is the worst kind of test.
     */
    session.send(`sleep 100 && ${emitSentinel('SLEEP-FINISHED')}`);
    // Wait for the job to actually be running before interrupting it —
    // interrupting an empty prompt proves nothing and passes anyway.
    await waitFor(() => session.output.includes('sleep 100'), {
      message: 'the sleep command to be echoed',
    });
    session.clear();

    session.write(CTRL_C);

    // The only honest proof the interrupt landed: the shell is taking commands
    // again, and the sleep never reached its own echo.
    session.send(emitSentinel('AFTER-INTERRUPT'));
    await session.waitForOutput('AFTER-INTERRUPT', { timeout: 8_000 });

    assert.ok(
      !session.output.includes('SLEEP-FINISHED'),
      'the interrupted job must not have run to completion',
    );
  });

  it('SIGINT hits the job, not the shell', async (context) => {
    const session = await context.ready(context.open());

    session.send('sleep 100');
    await waitFor(() => session.output.includes('sleep 100'), {
      message: 'the sleep command to be echoed',
    });

    session.write(CTRL_C);

    // Still alive and still answering. A SIGINT that killed the shell would
    // end the session, which is a different and much worse bug.
    session.send(emitSentinel('STILL-HERE'));
    await session.waitForOutput('STILL-HERE', { timeout: 8_000 });
    assert.equal(session.exit, null, 'the shell must not have exited');
  });

  it('ctrl-d at a prompt exits the shell', async (context) => {
    const session = await context.ready(context.open());

    session.write(CTRL_D);

    const exit = await session.waitForExit({ timeout: 8_000 });
    assert.equal(exit.code, 0);
  });

  it('the process group is killable, leaving no descendant', async (context) => {
    const session = await context.ready(context.open());

    // A grandchild, so this proves the *group* is signalled rather than just
    // the shell. SIGTERM to the shell alone leaves `claude` — and anything it
    // spawned — running with a dangling pty.
    const childPid = await startGrandchild(session, context.scratch, 'child');

    session.kill('SIGKILL');

    await waitFor(() => !isAlive(childPid), {
      timeout: 8_000,
      message: `the descendant pid ${childPid} to be gone`,
    });
  });

  it('a killed session reports the signal that killed it', async (context) => {
    const session = await context.ready(context.open());

    session.kill('SIGKILL');

    const exit = await session.waitForExit({ timeout: 8_000 });
    /**
     * `node-pty` reports a numeric signal on every exit and uses `0` for "no
     * signal" — the distinction story 094 got wrong first time, sending every
     * ordinary exit down the signal branch.
     */
    assert.notEqual(exit.signal, 0, 'a signalled death must report its signal');
    assert.equal(typeof exit.signal, 'number');
  });
});
