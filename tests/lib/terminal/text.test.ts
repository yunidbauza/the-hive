import { describe, expect, it } from 'vitest';

import { flattenLines, normalizeLines } from '@lib/terminal/text';

/**
 * Two ways to make text safe to send, and the difference between them is the
 * whole reason the module exists.
 *
 * Both drop the control characters that would let a paste address the cursor or
 * switch to the alternate screen. They disagree about the **line break**:
 * `normalizeLines` keeps it, because text bound for a live prompt can now carry
 * one; `flattenLines` folds it away, because main's IPC guard rejects every
 * control character and would refuse the whole message.
 */

describe('normalizeLines', () => {
  it('keeps line breaks, normalising every form to `\\n`', () => {
    expect(normalizeLines('first\nsecond')).toBe('first\nsecond');
    expect(normalizeLines('first\r\nsecond')).toBe('first\nsecond');
    expect(normalizeLines('first\rsecond')).toBe('first\nsecond');
  });

  it('reads a CRLF as one break, not two', () => {
    // The order of the alternation is what makes this true; a naive
    // `replace(/\n/g).replace(/\r/g)` would double it.
    expect(normalizeLines('a\r\nb')).toBe('a\nb');
  });

  it('strips every other control character', () => {
    // Written by code point rather than as literals, so this file stays free of
    // control bytes — a raw ESC is invisible in review and mangled by tooling.
    expect(normalizeLines('a\u001b[31mb')).toBe('a[31mb');
    expect(normalizeLines('a\u0000b')).toBe('ab');
    expect(normalizeLines('a\u0007b')).toBe('ab');
    expect(normalizeLines('a\u007fb')).toBe('ab');
  });

  it('keeps non-ASCII text intact', () => {
    // A naive code-unit loop would split the surrogate pair and corrupt it.
    expect(normalizeLines('日本語 🐝 ok')).toBe('日本語 🐝 ok');
  });

  it('trims the ends but leaves interior spacing alone', () => {
    expect(normalizeLines('  a  b  ')).toBe('a  b');
  });

  it('keeps a blank line in the middle', () => {
    // A paragraph break is content, not whitespace to tidy away.
    expect(normalizeLines('a\n\nb')).toBe('a\n\nb');
  });
});

describe('flattenLines', () => {
  it('folds every line break to a single space', () => {
    expect(flattenLines('first\nsecond')).toBe('first second');
    expect(flattenLines('first\r\nsecond')).toBe('first second');
  });

  it('folds a CRLF to one space, not two', () => {
    expect(flattenLines('a\r\nb')).toHaveLength(3);
  });

  it('strips the control characters main would refuse', () => {
    /**
     * The point of the function. `electron/shared/guards.ts` rejects every code
     * point below 0x20 and refuses the whole spawn, so anything that survives
     * here has to be something that guard will accept.
     */
    expect(flattenLines('a\u001bb')).toBe('ab');
    expect(flattenLines('a\u0007b')).toBe('ab');
  });

  it('leaves nothing behind for input that was only breaks', () => {
    // The caller reads the empty string as "no task", which is a real state:
    // the picker starts a session with no job and says so by passing ''.
    expect(flattenLines('\n\n')).toBe('');
  });
});
