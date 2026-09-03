// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  couldNotRun,
  failure,
  MAX_MESSAGE_CHARS,
  SILENT_FAILURE,
  TIMED_OUT,
  transcriptFailure,
} from '../../../../../electron/main/integrations/slack/outcome';

/** What the mcp sdk prints in front of every answer, whatever the answer is. */
const NOISE =
  "[mcp-sdk] SEP-2352: stored OAuth credential has no 'issuer' stamp " +
  '(pre-upgrade storage or provider not round-tripping the value).';

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

  /**
   * The sdk prints this on every call and prints it *first*, so a caption
   * built from the head of stderr opened with a paragraph about credential
   * storage and buried the sentence the user could act on. It is exactly what
   * the settings pane showed for the sign-in that could not reach a terminal.
   */
  it('drops the sdk warning that leads every stream', () => {
    expect(failure({ stderr: `${NOISE}\nbad url`, stdout: '' })).toEqual({
      kind: 'error',
      message: 'bad url',
    });
  });

  /**
   * A stderr carrying nothing but the warning is a stream that said nothing —
   * so stdout, which did say something, must not stay hidden behind it.
   */
  it('reads stdout when the warning was all stderr had', () => {
    expect(failure({ stderr: NOISE, stdout: 'usage: claude mcp add' })).toEqual({
      kind: 'error',
      message: 'usage: claude mcp add',
    });
  });
});

/**
 * A pty carries stdout and stderr on one stream, so a failing sign-in hands
 * back its whole session and the reason it stopped is at the **end** of it.
 */
describe('transcriptFailure', () => {
  const transcript = [
    'Starting authentication for "slack"…',
    NOISE,
    'Visit this URL to authorize:',
    '  https://slack.com/oauth/v2_user/authorize?client_id=1601185624273',
    '',
    'Waiting for authorization… (^C to cancel)',
    'Couldn\'t complete authentication for "slack": access_denied',
  ].join('\n');

  it('captions from the last line of the session, not the banner it opened with', () => {
    expect(transcriptFailure({ stdout: transcript, stderr: '' })).toEqual({
      kind: 'error',
      message: 'Couldn\'t complete authentication for "slack": access_denied',
    });
  });

  it('reads both streams, in the order a terminal would have shown them', () => {
    expect(
      transcriptFailure({ stdout: 'Starting…', stderr: 'callback port 3118 is in use' }),
    ).toEqual({ kind: 'error', message: 'callback port 3118 is in use' });
  });

  /** A transcript that ends mid-wait is not the error it looks like. */
  it('still names a timeout rather than the line it was killed on', () => {
    expect(
      transcriptFailure({
        stdout: 'Waiting for authorization… (^C to cancel)',
        stderr: '',
        timedOut: true,
      }),
    ).toEqual({ kind: 'error', message: TIMED_OUT });
  });

  it('never returns a blank message', () => {
    expect(transcriptFailure({ stdout: `\n${NOISE}\n  \n`, stderr: '' })).toEqual({
      kind: 'error',
      message: SILENT_FAILURE,
    });
  });

  it('caps a runaway line the same way every other caption is capped', () => {
    const status = transcriptFailure({
      stdout: `banner\n${'x'.repeat(MAX_MESSAGE_CHARS * 4)}`,
      stderr: '',
    });

    expect(status).toEqual({
      kind: 'error',
      message: `${'x'.repeat(MAX_MESSAGE_CHARS)}…`,
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
