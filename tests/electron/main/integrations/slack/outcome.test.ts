// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  couldNotRun,
  failure,
  MAX_MESSAGE_CHARS,
  SILENT_FAILURE,
  TIMED_OUT,
} from '../../../../../electron/main/integrations/slack/outcome';

/**
 * The shared failure shape (HIVE-123).
 *
 * Three modules used to carry their own copy of this, which is three places to
 * drift and three copies of the same hole: a silent failure produced an error
 * status with an **empty** message, which the pane renders as a blank red line.
 */

describe('failure', () => {
  it('prefers stderr, where claude writes its diagnostics', () => {
    expect(failure({ stderr: 'bad url', stdout: 'usage: claude mcp add' })).toEqual({
      kind: 'error',
      message: 'bad url',
    });
  });

  /**
   * The runner caps a child at 8 MiB, and every byte of that was eligible to
   * cross IPC and be rendered into one `<p>` in the settings pane.
   */
  it('caps the caption rather than handing the pane the whole stream', () => {
    const status = failure({ stderr: 'x'.repeat(MAX_MESSAGE_CHARS * 4), stdout: '' });

    expect(status).toEqual({
      kind: 'error',
      message: `${'x'.repeat(MAX_MESSAGE_CHARS)}…`,
    });
  });

  it('leaves a message that already fits exactly as it was', () => {
    const message = 'y'.repeat(MAX_MESSAGE_CHARS);

    expect(failure({ stderr: message, stdout: '' })).toEqual({
      kind: 'error',
      message,
    });
  });

  it('falls back to stdout for a subcommand that fails by printing usage', () => {
    expect(failure({ stderr: '   ', stdout: 'usage: claude mcp add' })).toEqual({
      kind: 'error',
      message: 'usage: claude mcp add',
    });
  });

  it('never returns a blank message', () => {
    expect(failure({ stderr: '', stdout: '' })).toEqual({
      kind: 'error',
      message: SILENT_FAILURE,
    });
    expect(SILENT_FAILURE).not.toBe('');
  });

  /**
   * A killed run's partial output is whatever it had got to — for the sign-in
   * that is a "waiting for your browser" line, which as an error message would
   * be actively misleading. So the timeout wins over both streams.
   */
  it('reports a timeout as a timeout, not as its half-written output', () => {
    expect(
      failure({ stderr: '', stdout: 'Opening your browser…', timedOut: true }),
    ).toEqual({ kind: 'error', message: TIMED_OUT });
  });

  it('takes the synchronous runner\'s result, which carries no timedOut field', () => {
    expect(failure({ stderr: 'no such server', stdout: '' })).toEqual({
      kind: 'error',
      message: 'no such server',
    });
  });
});

describe('couldNotRun', () => {
  it('names the cause of a binary that never started', () => {
    expect(couldNotRun(new Error('spawn ENOENT'))).toEqual({
      kind: 'error',
      message: 'Could not run claude: spawn ENOENT',
    });
  });

  it('survives a thrown non-Error', () => {
    expect(couldNotRun('nope')).toEqual({
      kind: 'error',
      message: 'Could not run claude: nope',
    });
  });
});
