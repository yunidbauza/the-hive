// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createTitleReader, nameFromTitle } from '../../../../electron/main/sessions/title';

/** `ESC ] 0 ; <text> BEL` — what Claude Code writes when its name changes. */
const osc0 = (text: string) => `\x1b]0;${text}\x07`;

describe('nameFromTitle', () => {
  it('strips the settled glyph', () => {
    expect(nameFromTitle('✳ sess-07')).toBe('sess-07');
  });

  it('strips a spinner frame', () => {
    // The braille frames are what the title carries while Claude is working.
    expect(nameFromTitle('⠂ sess-07')).toBe('sess-07');
    expect(nameFromTitle('⠐ fix the login bug')).toBe('fix the login bug');
  });

  /**
   * The frames a **real** `claude` emits today, captured off a pty rather than
   * assumed: `✳` settled, then `◐` (U+25D0) and `◑` (U+25D1) cycling while it
   * works. They are Geometric Shapes, and the two block ranges this stripper
   * used to carry — braille and dingbats — covered neither.
   *
   * The visible cost was on the fleet table, not here: a session that ended
   * mid-frame kept the half-filled circle in front of its name, so a row
   * reading `done` still wore a spinner and looked like work in progress.
   */
  it('strips the circle frames the current release actually uses', () => {
    expect(nameFromTitle('◐ sess-0c')).toBe('sess-0c');
    expect(nameFromTitle('◑ sess-0c')).toBe('sess-0c');
    // The other two of the four, unobserved but in the same cycle.
    expect(nameFromTitle('◒ sess-0c')).toBe('sess-0c');
    expect(nameFromTitle('◓ sess-0c')).toBe('sess-0c');
  });

  /**
   * The point of moving from blocks to `\p{So}`: a frame from a block nobody
   * has seen yet is still a symbol, so it degrades to "one unknown glyph
   * stripped" rather than to "the glyph is part of every session's name".
   */
  it('strips a glyph from a block this file has never met', () => {
    // U+2B24 BLACK LARGE CIRCLE — Miscellaneous Symbols and Arrows.
    expect(nameFromTitle('⬤ sess-0c')).toBe('sess-0c');
    // U+1F311 NEW MOON — a plausible spinner, and outside the BMP.
    expect(nameFromTitle('🌑 sess-0c')).toBe('sess-0c');
  });

  /**
   * The carve-out the old class maintained by hand, now falling out of the
   * category: `*` and `·` are punctuation rather than symbols, so a session
   * somebody renamed to `*scratch*` is never mangled.
   */
  it('leaves punctuation that could pass for a spinner alone', () => {
    expect(nameFromTitle('*scratch*')).toBe('*scratch*');
    expect(nameFromTitle('· notes')).toBe('· notes');
    expect(nameFromTitle('#4 retry')).toBe('#4 retry');
  });

  /**
   * A user's own leading emoji survives, because Claude's glyph is always in
   * front of it and the run stops at the space between them.
   */
  it('keeps a symbol the user put in the name', () => {
    expect(nameFromTitle('✳ 🚀 deploy')).toBe('🚀 deploy');
  });

  /**
   * The default title is the *absence* of a name, and reporting it as one broke
   * `/clear` in a way that took a probe to see. Measured order after a clear:
   *
   * ```
   * title "pepe"          the finished conversation's name, correctly refused
   * title "Claude Code"   taken for a real rename, so the guard was dropped
   * title "pepe"          no longer refused — the successor inherited it
   * ```
   */
  it('reports the default title as no name at all', () => {
    expect(nameFromTitle('✳ Claude Code')).toBe('');
    expect(nameFromTitle('⠂ Claude Code')).toBe('');
    expect(nameFromTitle('Claude Code')).toBe('');
  });

  it('still accepts a name that merely contains it', () => {
    // Only the exact default is meaningless; this is somebody's real session.
    expect(nameFromTitle('✳ Claude Code rewrite')).toBe('Claude Code rewrite');
  });

  it('leaves a name with no glyph alone', () => {
    expect(nameFromTitle('sess-07')).toBe('sess-07');
  });

  it('keeps interior spaces — a renamed session is a sentence, not a slug', () => {
    expect(nameFromTitle('✳ fix the login bug')).toBe('fix the login bug');
  });
});

describe('createTitleReader', () => {
  it('reads a whole sequence from one chunk', () => {
    const reader = createTitleReader();
    expect(reader.read(osc0('✳ sess-07'))).toEqual(['sess-07']);
  });

  it('reads a sequence split across two chunks', () => {
    /**
     * The case that motivates the whole module. A pty splits wherever it likes,
     * and a per-chunk regex sees neither half.
     */
    const reader = createTitleReader();
    expect(reader.read('\x1b]0;✳ sess')).toEqual([]);
    expect(reader.read('-07\x07')).toEqual(['sess-07']);
  });

  it('reads a sequence split immediately after the escape byte', () => {
    // The nastiest boundary: a lone ESC ending a chunk.
    const reader = createTitleReader();
    expect(reader.read('output\x1b')).toEqual([]);
    expect(reader.read(']0;✳ sess-07\x07')).toEqual(['sess-07']);
  });

  it('accepts the ST terminator as well as BEL', () => {
    const reader = createTitleReader();
    expect(reader.read('\x1b]0;✳ sess-07\x1b\\')).toEqual(['sess-07']);
  });

  it('ignores OSC 9 — the permission notification is not a name', () => {
    /**
     * Claude emits `OSC 9 ; Claude needs your permission` when it blocks on the
     * user. Reading it as a title would rename the row to a sentence about
     * permissions every time a tool asked for approval.
     */
    const reader = createTitleReader();
    expect(reader.read('\x1b]9;Claude needs your permission\x07')).toEqual([]);
  });

  it('reads several titles from one chunk, in order', () => {
    const reader = createTitleReader();
    expect(reader.read(`${osc0('⠂ first')}some output${osc0('✳ second')}`)).toEqual([
      'first',
      'second',
    ]);
  });

  it('ignores an empty title — Claude clears it at exit', () => {
    const reader = createTitleReader();
    expect(reader.read(osc0(''))).toEqual([]);
  });

  it('ignores ordinary output', () => {
    const reader = createTitleReader();
    expect(reader.read('$ pnpm build\r\n✓ built in 1.2s\r\n')).toEqual([]);
  });

  it('abandons an unterminated sequence rather than buffering a build log', () => {
    /**
     * An OSC introducer with no terminator must not accumulate output forever.
     * Past the cap the reader drops it, and the *next* well-formed title still
     * parses — proving it recovered rather than wedged.
     */
    const reader = createTitleReader();
    expect(reader.read(`\x1b]0;${'x'.repeat(4_000)}`)).toEqual([]);
    expect(reader.read(osc0('✳ sess-07'))).toEqual(['sess-07']);
  });

  it('forgets a partial sequence on reset', () => {
    const reader = createTitleReader();
    reader.read('\x1b]0;✳ sess');
    reader.reset();
    // Without the reset this would complete the abandoned generation's title.
    expect(reader.read('-07\x07')).toEqual([]);
  });
});
