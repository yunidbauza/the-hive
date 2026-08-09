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

  /** Nothing ran, so there is nothing to read — this is the one case that rejects. */
  it('rejects when the program does not exist', async () => {
    await expect(
      runAsync('/nonexistent/definitely-not-a-program', []),
    ).rejects.toThrow();
  });
});
