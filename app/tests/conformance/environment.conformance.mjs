import { assert, describe, it } from './harness.mjs';

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

    session.send('env | grep -c "^ELECTRON_" || echo ELECTRON-COUNT-0');
    await session.waitForOutput('ELECTRON-COUNT-0');
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
