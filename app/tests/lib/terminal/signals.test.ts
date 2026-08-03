import { describe, expect, it } from 'vitest';

import { signalName } from '@lib/terminal/signals';

describe('signalName', () => {
  it('names the signals that actually end a terminal session', () => {
    expect(signalName(2)).toBe('SIGINT');
    expect(signalName(9)).toBe('SIGKILL');
    expect(signalName(15)).toBe('SIGTERM');
  });

  it('falls back to the number rather than guessing', () => {
    /**
     * The platforms diverge past the POSIX-fixed set (`SIGUSR1` is 10 on Linux
     * and 30 on macOS). A wrong name is worse than a number: it sends the
     * reader looking for a cause that never happened.
     */
    expect(signalName(30)).toBe('signal 30');
  });

  it('never returns an empty string', () => {
    // This text lands inside a sentence the user reads. A blank there reads as
    // a rendering bug rather than as an unusual signal.
    for (const signal of [0, 1, 42, 99]) {
      expect(signalName(signal)).not.toBe('');
    }
  });
});
