// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { RunResult } from '../../../../../electron/main/integrations/github/run';
import {
  readTranscript,
  TTY_LAUNCHER,
  TTY_LAUNCHER_ARGS,
  withTty,
} from '../../../../../electron/main/integrations/slack/tty';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const result = (over: Partial<RunResult> = {}): RunResult => ({
  code: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  ...over,
});

describe('withTty', () => {
  it('runs the command through the launcher, keeping its argv intact', async () => {
    const calls: { file: string; args: string[] }[] = [];
    const run = (file: string, args: readonly string[]) => {
      calls.push({ file, args: [...args] });

      return Promise.resolve(result());
    };

    await withTty(run)('/usr/local/bin/claude', ['mcp', 'login', 'slack']);

    expect(calls).toEqual([
      {
        file: TTY_LAUNCHER,
        args: [...TTY_LAUNCHER_ARGS, '/usr/local/bin/claude', 'mcp', 'login', 'slack'],
      },
    ]);
  });

  /**
   * The timeout and the quit `AbortSignal` are the whole reason this is a
   * decorator over the shared runner rather than its own spawn.
   */
  it('passes the caller’s options through untouched', async () => {
    const seen: unknown[] = [];
    const run = (_f: string, _a: readonly string[], options?: unknown) => {
      seen.push(options);

      return Promise.resolve(result());
    };
    const signal = new AbortController().signal;

    await withTty(run)('claude', [], { timeoutMs: 1234, signal });

    expect(seen).toEqual([{ timeoutMs: 1234, signal }]);
  });

  it('reports the child’s own exit status and timeout flag', async () => {
    const run = () => Promise.resolve(result({ code: 7, timedOut: true }));

    await expect(withTty(run)('claude', [])).resolves.toMatchObject({
      code: 7,
      timedOut: true,
    });
  });

  it('hands back a transcript a caption can be built from', async () => {
    const run = () =>
      Promise.resolve(result({ code: 1, stdout: `${ESC}[94mnope${ESC}[39m\r\n` }));

    await expect(withTty(run)('claude', [])).resolves.toMatchObject({
      stdout: 'nope\n',
    });
  });

  /** A failure to start is the runner's to reject, not this decorator's. */
  it('does not swallow a launcher that could not be executed', async () => {
    const run = () => Promise.reject(new Error('spawn ENOENT'));

    await expect(withTty(run)('claude', [])).rejects.toThrow('spawn ENOENT');
  });
});

describe('readTranscript', () => {
  it('drops the colour a terminal would have consumed', () => {
    expect(readTranscript(`${ESC}[1mbold${ESC}[0m text`)).toBe('bold text');
  });

  /**
   * `OSC 8` wraps a link around text that already spells the same URL, so the
   * sequence is noise and dropping it keeps the address out of the caption
   * twice.
   */
  it('unwraps an osc-8 hyperlink to the text it decorated', () => {
    const link = `${ESC}]8;;https://slack.com/oauth${BEL}https://slack.com/oauth${ESC}]8;;${BEL}`;

    expect(readTranscript(link)).toBe('https://slack.com/oauth');
  });

  it('reads a carriage return as the line break a terminal draws', () => {
    expect(readTranscript('first\r\nsecond\rthird')).toBe('first\nsecond\nthird');
  });

  /**
   * Cursor motion and erase are how a program starts a line over. Treating
   * them as nothing glues a cleared prompt onto the message that replaced it.
   */
  it('reads a cleared line as a new line rather than as nothing', () => {
    const redrawn = `Or paste the redirect URL here: ${ESC}[1G${ESC}[0JCouldn't complete`;

    expect(readTranscript(redrawn)).toBe(
      "Or paste the redirect URL here:\nCouldn't complete",
    );
  });

  it('strips the control characters an unread tty echoes', () => {
    expect(readTranscript(`${String.fromCharCode(4)}\b\bStarting`)).toBe('Starting');
  });

  it('leaves plain text exactly as it found it', () => {
    expect(readTranscript('Starting authentication for "slack"…\n')).toBe(
      'Starting authentication for "slack"…\n',
    );
  });
});
