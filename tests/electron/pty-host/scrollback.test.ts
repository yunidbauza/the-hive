// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { Scrollback } from '../../../electron/pty-host/scrollback';
import { TRUNCATION_NOTICE } from '../../../electron/shared/pty-host-protocol';

/**
 * Bounded scrollback (story 092).
 *
 * The session manager's tests cover the ordinary path. This file exists for
 * the boundary cases that are awkward to provoke through a pty — a single
 * chunk larger than the whole cap, and the exact point at which truncation
 * starts being announced.
 */

describe('Scrollback', () => {
  it('holds everything while it fits, and says it is complete', () => {
    const buffer = new Scrollback(1024);

    buffer.push('one ');
    buffer.push('two');

    expect(buffer.read()).toBe('one two');
    expect(buffer.truncated).toBe(false);
  });

  it('ignores an empty chunk rather than recording a no-op', () => {
    const buffer = new Scrollback(1024);

    buffer.push('');

    expect(buffer.read()).toBe('');
    expect(buffer.size).toBe(0);
  });

  it('drops from the front once over cap and announces it', () => {
    const buffer = new Scrollback(10);

    buffer.push('aaaaa');
    buffer.push('bbbbb');
    buffer.push('ccccc');

    const text = buffer.read();
    expect(buffer.truncated).toBe(true);
    expect(text.startsWith(TRUNCATION_NOTICE)).toBe(true);
    // Oldest output goes first — the tail is what the user is looking at.
    expect(text).not.toContain('aaaaa');
    expect(text).toContain('ccccc');
  });

  it('keeps a single chunk larger than the cap rather than showing nothing', () => {
    const buffer = new Scrollback(4);
    const huge = 'x'.repeat(100);

    buffer.push(huge);

    // Overshooting by at most one chunk is the deliberate trade: dropping it
    // would leave a terminal with an empty transcript and no explanation.
    expect(buffer.read()).toBe(huge);
    expect(buffer.truncated).toBe(false);
  });

  it('measures bytes, not characters, so multi-byte output cannot overshoot', () => {
    const buffer = new Scrollback(1024);

    // Three bytes each, one character each.
    buffer.push('───');

    expect(buffer.size).toBe(9);
  });

  it('stays announced once truncation has happened, even if it later fits', () => {
    const buffer = new Scrollback(6);

    buffer.push('aaaaaa');
    buffer.push('b');

    // The dropped output is gone; a later small buffer must not pretend the
    // transcript became complete again.
    expect(buffer.truncated).toBe(true);
    expect(buffer.read().startsWith(TRUNCATION_NOTICE)).toBe(true);
  });
});
