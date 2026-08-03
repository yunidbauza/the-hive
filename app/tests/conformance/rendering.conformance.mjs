import { assert, describe, emitSentinel, it } from './harness.mjs';

/**
 * Rendering fidelity (story 098).
 *
 * Not "does it look right" — that is a browser question. These assert that the
 * **bytes round-trip**: what a program writes into the pty is what comes back
 * out, unmangled. Everything a TUI does rests on that, and the failures are
 * silent — a quantised colour, a replacement character where a box-drawing
 * glyph should be.
 */

/**
 * The escape byte, written as a **printf escape** rather than typed.
 *
 * Sending a raw `\x1b` into a pty's *input* is not "printing an escape
 * sequence" — the terminal line discipline sees an escape in what the user is
 * typing and mangles the whole command. `printf` generating it from `\033` is
 * what actually exercises the output path.
 */
const ESC = '\\033';
/** What comes back out, for the assertion. */
const OUT = '\x1b';

describe('rendering', () => {
  it('8-colour SGR round-trips exactly', async (context) => {
    const session = await context.ready(context.open());

    session.send(`printf '${ESC}[31mRED${ESC}[0m\\n'`);
    await session.waitForOutput(`${OUT}[31mRED${OUT}[0m`);
  });

  it('24-bit colour round-trips exactly', async (context) => {
    const session = await context.ready(context.open());

    // The app's own palette is truecolor SGR (story 011). This is the byte
    // sequence `ansi.ts` emits, checked end to end.
    session.send(`printf '${ESC}[38;2;143;181;255mBRAND${ESC}[0m\\n'`);
    await session.waitForOutput(`${OUT}[38;2;143;181;255mBRAND`);
  });

  it('the alternate screen is entered and left', async (context) => {
    const session = await context.ready(context.open());

    // `?1049h` / `?1049l` are what vim, htop and every full-screen TUI use.
    // Without them the app cannot host the tools it exists to host.
    session.send('tput smcup');
    await session.waitForOutput('?1049h');
    session.send('tput rmcup');
    await session.waitForOutput('?1049l');
  });

  it('cursor addressing survives', async (context) => {
    const session = await context.ready(context.open());

    session.send('tput cup 5 10');
    await session.waitForOutput(/\x1b\[6;11[Hf]/);
  });

  it('UTF-8 survives a chunk boundary', async (context) => {
    const session = await context.ready(context.open());

    /**
     * The direct test of the `StringDecoder` in story 092.
     *
     * A multi-byte character can straddle a read boundary, and decoding each
     * chunk independently turns the split character into a replacement
     * character **permanently** — the damage happens before the bytes reach
     * xterm. A large payload of box-drawing characters makes a split
     * overwhelmingly likely rather than hoping for one.
     */
    session.send(`printf '─%.0s' $(seq 1 4000); ${emitSentinel('BOX-DONE')}`);
    await session.waitForOutput('BOX-DONE', { timeout: 15_000 });

    assert.ok(
      !session.output.includes('�'),
      'a replacement character means a multi-byte sequence was split and lost',
    );
    // And the payload really did arrive, rather than the assertion above
    // passing over an empty transcript.
    assert.ok(session.output.split('─').length > 3_900);
  });

  it('wide characters keep their bytes', async (context) => {
    const session = await context.ready(context.open());

    session.send("printf '日本語 🐝 ok\\n'");
    await session.waitForOutput('日本語 🐝 ok');
    assert.ok(!session.output.includes('�'));
  });

  it('a lone high byte does not corrupt what follows', async (context) => {
    const session = await context.ready(context.open());

    // Invalid UTF-8 is a fact of life in a terminal (binary accidentally
    // `cat`ed). It may render as a replacement character — it must not
    // desynchronise the decoder for everything after it.
    session.send("printf '\\xc3 AFTER-BAD-BYTE\\n'");
    await session.waitForOutput('AFTER-BAD-BYTE');
  });
});
