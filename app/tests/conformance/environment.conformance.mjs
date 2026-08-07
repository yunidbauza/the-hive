import { assert, describe, emitSentinel, it } from './harness.mjs';

/**
 * Environment hygiene (story 098).
 *
 * The bug class that produces "it works in my terminal but not in the app".
 * A child must not inherit Electron's environment verbatim, and every failure
 * here is invisible until something downstream behaves strangely — a `node`
 * that silently runs with different options, an `electron` invocation that
 * turns itself into a Node process.
 *
 * This group is the reason the suite runs under `ELECTRON_RUN_AS_NODE=1`
 * rather than plain Node: the runner's own environment carries the variables
 * being denied, so "not inherited" is a real assertion here and would be
 * vacuous anywhere else.
 */
describe('environment', () => {
  it('ELECTRON_RUN_AS_NODE is not inherited', async (context) => {
    /**
     * The headline row, and the one that catches a whole class of confusing
     * downstream bugs. The runner itself was launched with this set — the
     * suite could not exist otherwise — so a child that sees it means the
     * deny-list is not working.
     */
    assert.equal(
      process.env.ELECTRON_RUN_AS_NODE,
      '1',
      'the runner must itself be running with ELECTRON_RUN_AS_NODE set, or this test proves nothing',
    );

    const session = await context.ready(context.open());
    session.send('echo "ERAN=[$ELECTRON_RUN_AS_NODE]"');
    await session.waitForOutput('ERAN=[]');
  });

  it('no ELECTRON_* variable leaks', async (context) => {
    const session = await context.ready(context.open());

    /**
     * `emitSentinel`, not a bare `echo` — the sweep is worthless without it.
     *
     * A pty echoes what is typed into it, so `echo ELECTRON-COUNT-0` puts that
     * token in the transcript *as part of the command line*, before the command
     * has run. `waitForOutput` then resolves on the echo whatever `grep` goes on
     * to find, and the assertion can never fail. `emitSentinel` splits the token
     * across a quote boundary so only the shell's own output spells it whole.
     */
    session.send(
      `env | grep -c "^ELECTRON_" || ${emitSentinel('ELECTRON-COUNT-0')}`,
    );
    await session.waitForOutput('ELECTRON-COUNT-0');
  });

  it('no CLAUDE_* variable leaks into a session (HIVE-64)', async (context) => {
    /**
     * The most consequential entry on the deny list for *this* app.
     *
     * Launch The Hive from a terminal that is itself inside a Claude Code
     * session — which is how it gets developed — and every pty would hand
     * `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_CHILD_SESSION` to the `claude`
     * it starts. That agent then joins the launching session instead of
     * starting its own: every session opened under the launcher's name, and
     * renaming any one of them renamed all of them at once.
     *
     * Injected explicitly rather than relying on the runner's own environment,
     * so the assertion holds whether or not the suite was started from inside
     * a session. That is the difference between this and the
     * `ELECTRON_RUN_AS_NODE` row above, which can lean on the runner.
     */
    const session = await context.ready(
      context.open({
        env: {
          CLAUDE_CODE_SESSION_ID: 'leaked-session-id',
          CLAUDE_CODE_CHILD_SESSION: '1',
          CLAUDECODE: '1',
        },
      }),
    );

    session.send('echo "CS=[$CLAUDE_CODE_SESSION_ID] CC=[$CLAUDECODE]"');
    await session.waitForOutput('CS=[] CC=[]');

    // Split token, for the echo reason spelled out on the ELECTRON_ sweep above.
    // Without it this line passes even if every CLAUDE_* variable leaks.
    session.send(`env | grep -c "^CLAUDE" || ${emitSentinel('CLAUDE-COUNT-0')}`);
    await session.waitForOutput('CLAUDE-COUNT-0');
  });

  it('NODE_OPTIONS is not inherited', async (context) => {
    const session = await context.ready(
      context.open({ env: {} }),
    );

    session.send('echo "NO=[$NODE_OPTIONS]"');
    await session.waitForOutput('NO=[]');
  });

  it('NODE_PATH is not inherited', async (context) => {
    /**
     * Not in the story's table, and it should be — story 092 found it the
     * first time a real shell was spawned under Electron and its environment
     * read back. Electron's launcher sets `NODE_PATH` to Electron's own bundled
     * `node_modules`, so inheriting it means a `node` the user runs inside
     * their session resolves modules out of Electron's tree instead of their
     * project's. Exactly the invisible behaviour change `NODE_OPTIONS` is
     * denied for.
     */
    const session = await context.ready(context.open());

    session.send('echo "NP=[$NODE_PATH]"');
    await session.waitForOutput('NP=[]');
  });

  it('the user’s own variables survive', async (context) => {
    // The deny-list must be a list, not a purge: a session that lost the
    // user's PATH could not find `claude`, which is the entire point.
    const session = await context.ready(
      context.open({ env: { HIVE_CONFORMANCE: 'kept' } }),
    );

    session.send('echo "MINE=[$HIVE_CONFORMANCE]"');
    await session.waitForOutput('MINE=[kept]');
  });

  it('an injected variable cannot override TERM', async (context) => {
    // TERM, COLORTERM and PWD are applied last on purpose: they are the
    // terminal's identity, and an override is far likelier to be a mistake.
    const session = await context.ready(
      context.open({ env: { TERM: 'dumb' } }),
    );

    session.send('echo "TERM=[$TERM]"');
    await session.waitForOutput('TERM=[xterm-256color]');
  });

  it('an injected variable cannot smuggle a denied name back in', async (context) => {
    const session = await context.ready(
      context.open({ env: { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' } }),
    );

    session.send('echo "SMUGGLED=[$ELECTRON_RUN_AS_NODE][$NODE_OPTIONS]"');
    await session.waitForOutput('SMUGGLED=[][]');
  });

  it('PATH survives, so the session can find its tooling', async (context) => {
    const session = await context.ready(context.open());

    session.send('test -n "$PATH" && echo PATH-OK');
    await session.waitForOutput('PATH-OK');
  });
});
