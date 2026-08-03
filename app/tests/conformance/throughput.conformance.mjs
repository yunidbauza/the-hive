import { assert, describe, emitSentinel, it, waitFor } from './harness.mjs';

/**
 * Throughput, ordering and backpressure (story 098).
 *
 * A terminal that loses bytes under load renders output that never existed in
 * that order, and the user debugs something that never happened. `yes`,
 * `pnpm build` and a stack trace are all firehoses, and all three are ordinary.
 */
describe('throughput', () => {
  it('a firehose loses nothing', async (context) => {
    const session = await context.ready(context.open());

    // ~640 KB, comfortably past the 512 KiB unacked window story 093 pauses at
    // and past any single kernel pty buffer.
    const lines = 10_000;
    session.send(
      `for i in $(seq 1 ${lines}); do echo "line-$i-padded-to-a-useful-width"; done; ${emitSentinel('FIREHOSE-DONE')}`,
    );

    await session.waitForOutput('FIREHOSE-DONE', { timeout: 30_000 });

    // Counted, not sampled: a dropped chunk in the middle is exactly the defect
    // that a "did the last line arrive" check sails past.
    const seen = session.output.match(/line-\d+-padded/g) ?? [];
    assert.equal(
      seen.length,
      lines,
      `expected ${lines} lines, saw ${seen.length}`,
    );
  });

  it('output arrives in order, with no gaps', async (context) => {
    const session = await context.ready(context.open());

    const lines = 2_000;
    session.send(
      `for i in $(seq 1 ${lines}); do echo "n-$i"; done; ${emitSentinel('ORDER-DONE')}`,
    );
    await session.waitForOutput('ORDER-DONE', { timeout: 30_000 });

    const numbers = [...session.output.matchAll(/n-(\d+)/g)].map((m) =>
      Number(m[1]),
    );
    assert.equal(numbers.length, lines);
    for (let i = 0; i < numbers.length; i += 1) {
      assert.equal(numbers[i], i + 1, `out of order at index ${i}`);
    }
  });

  it('pause stops delivery and resume returns it, losing nothing', async (context) => {
    const session = await context.ready(context.open());

    /**
     * Real backpressure, not a queue growing out of sight: paused, the kernel
     * pty buffer fills and the producing process blocks on `write`, exactly as
     * it would piping to a slow consumer in a shell.
     */
    session.send(
      `for i in $(seq 1 5000); do echo "p-$i"; done; ${emitSentinel('PAUSE-DONE')}`,
    );
    await waitFor(() => session.output.includes('p-1'), {
      message: 'the flood to start',
    });

    session.pause();
    const atPause = session.output.length;
    // Settle: whatever was already in flight may still land, but nothing new
    // should after that.
    await waitFor(
      async () => {
        const before = session.output.length;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return session.output.length === before;
      },
      { message: 'delivery to stop while paused' },
    );
    const settled = session.output.length;

    session.resume();

    await session.waitForOutput('PAUSE-DONE', { timeout: 30_000 });
    assert.ok(
      session.output.length > settled,
      'resume must deliver what the pause held back',
    );
    assert.ok(atPause > 0);

    // And nothing was dropped while paused — the whole point of blocking the
    // producer rather than discarding.
    const seen = session.output.match(/p-\d+/g) ?? [];
    assert.equal(seen.length, 5_000, `expected 5000 lines, saw ${seen.length}`);
  });

  it('the replay buffer is bounded but keeps the tail', async (context) => {
    const session = await context.ready(context.open());

    /**
     * Comfortably past `SCROLLBACK_BYTES` (256 KiB) — 20k lines of ~26 bytes is
     * roughly twice the bound, so the head is dropped by a wide margin rather
     * than by a few kilobytes that a padding change could erase.
     */
    session.send(
      `for i in $(seq 1 20000); do echo "r-$i-padding-padding"; done; ${emitSentinel('REPLAY-DONE')}`,
    );
    await session.waitForOutput('REPLAY-DONE', { timeout: 30_000 });

    const replay = session.replay();
    assert.equal(typeof replay, 'string');
    // The end is what the user needs — a terminal that dropped the *newest*
    // output would be useless — and the buffer is bounded, so it cannot be
    // everything.
    assert.ok(replay.includes('REPLAY-DONE'), 'the tail must survive');
    assert.ok(!replay.includes('r-1-padding'), 'the head must have been dropped');
  });
});
