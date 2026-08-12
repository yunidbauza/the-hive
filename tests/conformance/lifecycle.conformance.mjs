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
 * Lifecycle (story 098).
 *
 * How a session ends, and what it leaves behind. The last property in this
 * group is the most important assertion in the epic: its failure mode is a
 * `claude` process still running after the app is closed — invisible,
 * consuming tokens, and able to write to the repository.
 */
describe('lifecycle', () => {
  it('an exit code propagates', async (context) => {
    const session = await context.ready(context.open());

    session.send('exit 42');

    const exit = await session.waitForExit({ timeout: 8_000 });
    assert.equal(exit.code, 42);
  });

  it('a clean exit reports code 0 and signal 0, not undefined', async (context) => {
    const session = await context.ready(context.open());

    session.send('exit 0');

    const exit = await session.waitForExit({ timeout: 8_000 });
    assert.equal(exit.code, 0);
    /**
     * `node-pty` reports a numeric signal on every exit and uses `0` for "no
     * signal". Story 094 tested for `undefined` and sent every ordinary exit
     * down the signal branch, printing `session terminated (signal 0)` where it
     * should have said `session exited`. Pinned here so it cannot come back.
     */
    assert.equal(exit.signal, 0);
  });

  it('output printed immediately before exit is not truncated', async (context) => {
    const session = await context.ready(context.open());

    // The race this guards: the exit event overtaking the final flush, so the
    // error a program printed on its way out never reaches the user.
    session.send('printf "LAST-WORDS\\n"; exit 7');

    const exit = await session.waitForExit({ timeout: 8_000 });
    assert.equal(exit.code, 7);
    assert.ok(
      session.output.includes('LAST-WORDS'),
      'the final output must arrive before the exit is reported',
    );
  });

  it('the transcript is retained after exit', async (context) => {
    const session = await context.ready(context.open());

    session.send('echo KEEP-THIS; exit 0');
    await session.waitForExit({ timeout: 8_000 });

    // A terminal that empties itself the instant a process dies destroys the
    // error the user needed to read.
    assert.ok(session.replay()?.includes('KEEP-THIS'));
  });

  it('a session that exited reports itself as no longer live', async (context) => {
    const session = await context.ready(context.open());

    assert.equal(context.manager.isLive(session.sessionId), true);
    session.send('exit 0');
    await session.waitForExit({ timeout: 8_000 });

    assert.equal(context.manager.isLive(session.sessionId), false);
  });

  it('killAll leaves no descendant of any session', async (context) => {
    /**
     * **The most important assertion in the epic.**
     *
     * Five sessions, each with a grandchild, so this proves process *groups*
     * are signalled rather than just the five shells. A leak here means agents
     * still running after the app is closed.
     */
    const sessions = [];
    for (let i = 0; i < 5; i += 1) {
      sessions.push(await context.ready(context.open()));
    }

    const childPids = [];
    for (const [index, session] of sessions.entries()) {
      childPids.push(
        await startGrandchild(session, context.scratch, `child-${index}`),
      );
    }

    await context.manager.killAll();

    for (const pid of childPids) {
      await waitFor(() => !isAlive(pid), {
        timeout: 10_000,
        message: `descendant pid ${pid} to be gone after killAll`,
      });
    }
  });

  it('spawning a duplicate session id is refused, not silently accepted', async (context) => {
    const session = await context.ready(context.open());

    // Accepting it would orphan the first process: still running, no longer
    // addressable, invisible until the app quits.
    /**
     * The refusal is delivered to the emit of the call that was refused, not
     * to the session that already holds the id — the manager has no reason to
     * tell a healthy session about someone else's mistake.
     */
    const refusals = [];
    context.manager.spawn(
      {
        type: 'spawn',
        sessionId: session.sessionId,
        shell: '/bin/sh',
        args: [],
        cwd: context.scratch,
        env: {},
        cols: 80,
        rows: 24,
      },
      (message) => {
        if (message.type === 'error') refusals.push(message.message);
      },
    );

    await waitFor(() => refusals.length > 0, {
      message: 'an error message for the duplicate id',
    });
    assert.match(refusals[0], /already exists/);

    // And the original is untouched — the point of refusing rather than
    // replacing.
    session.send(emitSentinel('ORIGINAL-ALIVE'));
    await session.waitForOutput('ORIGINAL-ALIVE', { timeout: 8_000 });
  });
});
