import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPtyTransport,
  resetPtyChannels,
} from '@lib/terminal/pty-transport';
import { normalizeInput, sendToSession } from '@lib/terminal/session-input';

import type { ExitEvent } from '@shared/ipc-contract';

/**
 * The send primitive against a stubbed bridge (story 097).
 *
 * The bridge is the only thing this module touches, so the stub is the world.
 * Every assertion is either "the right bytes reached the bridge" or "nothing
 * reached it at all" — the second being the one that matters, because a
 * routing layer that writes into a dead session fails silently.
 */

type ExitCb = (event: ExitEvent) => void;

const write = vi.fn();
const spawn = vi.fn(() => Promise.resolve());
let exits: Set<ExitCb>;

beforeEach(() => {
  exits = new Set<ExitCb>();
  (window as { hive?: unknown }).hive = {
    pty: {
      spawn,
      write,
      resize: vi.fn(),
      kill: vi.fn(() => Promise.resolve()),
      ack: vi.fn(),
      onData: () => () => {},
      onExit: (cb: ExitCb) => {
        exits.add(cb);
        return () => exits.delete(cb);
      },
      onLost: () => () => {},
      restart: vi.fn(() => Promise.resolve()),
    },
  };
});

afterEach(() => {
  resetPtyChannels();
  delete (window as { hive?: unknown }).hive;
  vi.clearAllMocks();
});

/** Bring an entity to `live` the way a mounted surface would. */
const openSession = (id: string) => {
  createPtyTransport(id, 'apfm-web').onData(() => {});
};

const exit = (id: string) => {
  for (const cb of [...exits]) cb({ sessionId: id, exitCode: 0, signal: 0 });
};

describe('normalizeInput', () => {
  it('keeps a line break, normalising every form to one `\\n`', () => {
    /**
     * **This assertion is inverted from what it used to be, and the premise is
     * what changed rather than the standard.**
     *
     * It read "collapses every newline form to a single space", because a
     * multi-line message would otherwise submit its first line and strand the
     * rest at the prompt — true while `\r` was the only byte this module could
     * send. `Shift+Enter` now gives the pty a sequence that starts a line
     * *without* submitting, so flattening here would mean offering a key that
     * inserts a break and then silently removing it on the way out.
     */
    expect(normalizeInput('first\nsecond')).toBe('first\nsecond');
    expect(normalizeInput('first\r\nsecond')).toBe('first\nsecond');
    expect(normalizeInput('first\rsecond')).toBe('first\nsecond');
  });

  it('reads a CRLF as one break, not two', () => {
    // The order of the alternation is what makes this true; a naive
    // `replace(/\n/g).replace(/\r/g)` would double it.
    expect(normalizeInput('a\r\nb').length).toBe(3);
    expect(normalizeInput('a\r\nb')).toBe('a\nb');
  });

  it('strips other control characters', () => {
    // This text is written into a terminal the user trusts; a pasted ESC could
    // address the cursor or switch to the alternate screen.
    expect(normalizeInput('a\u001b[31mb')).toBe('a[31mb');
    expect(normalizeInput('a\u0000b')).toBe('ab');
    expect(normalizeInput('a\u0007b')).toBe('ab');
  });

  it('keeps non-ASCII text intact', () => {
    expect(normalizeInput('日本語 🐝 ok')).toBe('日本語 🐝 ok');
  });

  it('trims the ends but leaves interior spacing alone', () => {
    expect(normalizeInput('  a  b  ')).toBe('a  b');
  });
});

describe('sendToSession', () => {
  it('submits with a carriage return, not a newline', () => {
    openSession('sess-a');

    expect(sendToSession('sess-a', 'y')).toEqual({ ok: true });
    expect(write).toHaveBeenCalledWith({ sessionId: 'sess-a', data: 'y\r' });
  });

  it('sends the normalised text, so a paste submits once', () => {
    /**
     * Still one submit, which was always the point of normalising — but the
     * interior break is now carried rather than destroyed. `\x1b\r` starts a
     * line without submitting (it is what `Shift+Enter` sends), so the message
     * arrives as the two lines it was written as and the single trailing `\r`
     * is the only thing that ends the turn.
     */
    openSession('sess-a');

    sendToSession('sess-a', 'one\ntwo');

    expect(write).toHaveBeenCalledWith({
      sessionId: 'sess-a',
      data: 'one\x1b\rtwo\r',
    });
  });

  it('refuses a session that was never opened, and writes nothing', () => {
    expect(sendToSession('sess-a', 'y')).toEqual({
      ok: false,
      reason: 'sess-a has no live session — open it to start one',
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a session that has exited, and writes nothing', () => {
    openSession('sess-a');
    exit('sess-a');

    expect(sendToSession('sess-a', 'y')).toEqual({
      ok: false,
      reason: 'sess-a has exited — restart it to send again',
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses an empty message rather than submitting a bare carriage return', () => {
    openSession('sess-a');

    expect(sendToSession('sess-a', '   ')).toEqual({
      ok: false,
      reason: 'nothing to send',
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a message that is only newlines', () => {
    openSession('sess-a');

    expect(sendToSession('sess-a', '\n\n').ok).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses when there is no bridge at all', () => {
    openSession('sess-a');
    delete (window as { hive?: unknown }).hive;

    expect(sendToSession('sess-a', 'y')).toEqual({
      ok: false,
      reason: 'this build has no terminal bridge',
    });
    expect(write).not.toHaveBeenCalled();
  });
});
