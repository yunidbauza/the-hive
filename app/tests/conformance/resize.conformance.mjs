import { assert, describe, emitSentinel, it, waitFor } from './harness.mjs';

/**
 * Resize and SIGWINCH (story 098).
 *
 * A text widget can be told its new size. A terminal *tells its child*, and the
 * child finds out through a signal it can trap. Vitest can assert that
 * `resize()` was called; only this layer can assert that the child noticed.
 */
describe('resize', () => {
  it('a resize changes what the child sees', async (context) => {
    const session = await context.ready(context.open({ cols: 80, rows: 24 }));

    session.send('stty size');
    await session.waitForOutput('24 80');
    session.clear();

    session.resize(100, 30);

    // `stty size` asks the kernel, not the app. If the ioctl never happened,
    // this still says 24 80.
    session.send('stty size');
    await session.waitForOutput('30 100');
  });

  it('SIGWINCH is delivered to the child', async (context) => {
    const session = await context.ready(context.open({ cols: 80, rows: 24 }));

    // A trap is the only way to prove the *signal* arrived rather than the
    // size merely being readable afterwards.
    session.send("trap 'echo GOT-WINCH' WINCH");
    /**
     * Confirmed by a sentinel, not by looking for "WINCH" in the output — the
     * typed command line contains that word and the pty echoes it straight
     * back, so the wait was satisfied before the trap existed. Exactly the trap
     * `emitSentinel` documents.
     */
    session.send(emitSentinel('TRAP-READY'));
    await session.waitForOutput('TRAP-READY', {
      message: 'the trap to be installed',
    });
    session.clear();

    session.resize(120, 40);

    await session.waitForOutput('GOT-WINCH', { timeout: 8_000 });
  });

  it('a zero-size resize is dropped, and nothing crashes', async (context) => {
    const session = await context.ready(context.open({ cols: 80, rows: 24 }));

    /**
     * A zero-width pty is meaningless to the kernel and catastrophic to a TUI
     * doing arithmetic with the value. It happens for real: a hidden or
     * unmounted surface measures 0×0 for a frame.
     */
    session.resize(0, 0);

    session.send('stty size');
    await session.waitForOutput('24 80');
    assert.equal(session.exit, null, 'the session must survive a zero resize');
  });

  it('a negative or absurd size is dropped too', async (context) => {
    const session = await context.ready(context.open({ cols: 80, rows: 24 }));

    session.resize(-10, -10);

    session.send('stty size');
    await session.waitForOutput('24 80');
    assert.equal(session.exit, null);
  });

  it('repeated resizes settle on the last one', async (context) => {
    const session = await context.ready(context.open({ cols: 80, rows: 24 }));

    // Story 093 throttles resizes in main; whatever survives the throttle, the
    // *final* geometry must be the one the child ends up with — a window drag
    // that leaves the shell believing an intermediate size is the visible bug.
    for (const [cols, rows] of [[90, 25], [100, 28], [110, 32]]) {
      session.resize(cols, rows);
    }

    session.send('stty size');
    await session.waitForOutput('32 110', { timeout: 8_000 });
  });
});
