// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { runAsync } from '../../../../../electron/main/integrations/github/run';

/**
 * The async runner.
 *
 * This is the one file in the integration that executes a real program, and it
 * is deliberate: what is under test is the *contract* with `execFile` — which
 * failures resolve and which reject — and that contract belongs to Node, not to
 * a fake. The programs are `/bin/echo` and `/bin/sh`, they exit immediately, and
 * nothing is left running. (The ban on real spawns in unit tests is about
 * `node-pty` leaking long-lived processes; a two-millisecond `echo` is not
 * that.)
 */
describe('runAsync', () => {
  it('resolves with stdout for a program that succeeds', async () => {
    const result = await runAsync('/bin/echo', ['hello']);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.timedOut).toBe(false);
  });

  /**
   * A non-zero exit **resolves**. A `gh` that ran and refused has told us
   * something, and a caller that had to catch in order to read it would be
   * catching the normal path.
   */
  it('resolves with the exit code for a program that fails', async () => {
    const result = await runAsync('/bin/sh', ['-c', 'echo out; echo err >&2; exit 3']);

    expect(result.code).toBe(3);
    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
  });

  it('runs in the directory it is given', async () => {
    const result = await runAsync('/bin/sh', ['-c', 'pwd'], { cwd: '/tmp' });

    // macOS resolves /tmp through a symlink, so the tail is what is stable.
    expect(result.stdout.trim().endsWith('/tmp')).toBe(true);
  });

  /**
   * A response too large for the buffer must not read as a timeout.
   *
   * Node kills the child for a `maxBuffer` overflow, so it arrives looking
   * exactly like one — killed, signalled, non-numeric code. Reporting it as a
   * timeout would tell the user GitHub was slow when GitHub in fact answered at
   * length and the app discarded it.
   */
  it('reports an oversized response as a failure, not a timeout', async () => {
    // 9 MiB, past the 8 MiB cap. `dd` writes it in milliseconds.
    const result = await runAsync('/bin/dd', [
      'if=/dev/zero',
      'bs=1024',
      'count=9216',
    ]);

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain('output limit');
  });

  /** Nothing ran, so there is nothing to read — this is the one case that rejects. */
  it('rejects when the program does not exist', async () => {
    await expect(
      runAsync('/nonexistent/definitely-not-a-program', []),
    ).rejects.toThrow();
  });
});

/**
 * Only *our* timeout is a timeout — against real processes.
 *
 * Node sets `killed: true` when its own `timeout` option fires and leaves it
 * `false` for a kill from anywhere else. Reporting every signal as a timeout
 * told the user "GitHub did not answer in time" about a process the system had
 * shot. A self-`kill -9` reproduces that second case exactly, and in
 * milliseconds.
 */
describe('killed by a signal', () => {
  it('does not call an external SIGKILL a timeout', async () => {
    const result = await runAsync('/bin/sh', ['-c', 'kill -9 $$']);

    expect(result.code).toBe(-1);
    expect(result.timedOut).toBe(false);
  });

  /**
   * The stdin half of the same function, also measured rather than assumed.
   * `execFile` ignores a `stdio` option and always hands the child an open
   * pipe, so a `gh` that decides to prompt would block for the full timeout.
   * Ending stdin gives it EOF at once.
   */
  it('gives the child EOF on stdin instead of leaving it to block', async () => {
    const started = Date.now();
    const result = await runAsync('/bin/sh', ['-c', 'cat; echo done']);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('done');
    // Nowhere near the 20s timeout it would hit with stdin left open.
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
