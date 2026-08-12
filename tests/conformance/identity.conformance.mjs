import { assert, describe, emitSentinel, it } from './harness.mjs';

/**
 * Is this a real terminal? (story 098)
 *
 * The claim under test is not "the UI renders output" — xterm.js has rendered
 * this app's fixtures since story 042. It is that a process running inside The
 * Hive has a **controlling terminal**, which is a kernel-level property no
 * mocked unit test can assert and no text-scraping browser test should.
 *
 * These are the rows that separate a real terminal from a text widget.
 */
describe('identity', () => {
  it('isatty() is true on stdin', async (context) => {
    const session = await context.ready(context.open());

    /**
     * The single most consequential property in the epic: `isatty()` is why
     * Claude Code's TUI renders at all rather than falling back to pipe mode.
     *
     * Asserted through `$?` rather than `... && echo YES || echo NO`, because
     * a pty echoes the command line: both branches would appear in the
     * transcript before the test ever ran, and the negative assertion would
     * fail on text the shell merely repeated back.
     */
    session.send('test -t 0; echo "ISATTY=[$?]"');
    await session.waitForOutput('ISATTY=[0]');

    assert.ok(!session.output.includes('ISATTY=[1]'));
  });

  it('a real device is attached', async (context) => {
    const session = await context.ready(context.open());

    session.send('tty');
    // Not `test -t`: this asks the kernel which device, and a text widget
    // pretending to be a terminal has none to name.
    await session.waitForOutput(/\/dev\/(tty|pts)/);
  });

  it('TERM advertises xterm-256color', async (context) => {
    const session = await context.ready(context.open());

    /**
     * How every program in the terminal decides what it may emit. Get it wrong
     * and colours silently vanish, or garbage appears where a capability was
     * assumed. Deliberately forced by `buildEnv`, last, so an injected override
     * cannot win — it is far more likely a mistake than an intention.
     */
    session.send('echo "TERM=[$TERM]"');
    await session.waitForOutput('TERM=[xterm-256color]');
  });

  it('COLORTERM advertises truecolor', async (context) => {
    const session = await context.ready(context.open());

    // Without it some tools quantise 24-bit colour to 256, and the app's own
    // palette looks subtly wrong next to the same tool in iTerm.
    session.send('echo "CT=[$COLORTERM]"');
    await session.waitForOutput('CT=[truecolor]');
  });

  it('the shell starts in the requested directory', async (context) => {
    const session = await context.ready(context.open());

    session.send('pwd');
    /**
     * Compared with `realpath`, because macOS resolves the temp dir through a
     * `/var` → `/private/var` symlink: the shell reports the resolved path and
     * `mkdtemp` returned the link. Asserting the raw string would fail on macOS
     * and pass on Linux, which is worse than not asserting it.
     */
    session.send(
      `test "$(pwd -P)" = "$(cd '${session.cwd}' && pwd -P)" && ${emitSentinel('CWD-OK')}`,
    );
    await session.waitForOutput('CWD-OK');
  });

  it('reports the pid of the process it started', async (context) => {
    const session = await context.ready(context.open());

    assert.equal(typeof session.pid, 'number');
    assert.ok(session.pid > 0);

    // The pid is what teardown signals as a *group*; a wrong one leaks
    // everything the shell started.
    session.send('echo "PID=[$$]"');
    await session.waitForOutput(`PID=[${session.pid}]`);
  });
});
