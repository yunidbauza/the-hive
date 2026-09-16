import { describe, expect, it } from 'vitest';

import { OSC52_PAYLOAD_LIMIT, decodeOsc52Write } from '@lib/terminal/osc52';

/** What a program puts after `ESC ] 52 ;` — the part xterm hands a handler. */
function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

describe('decodeOsc52Write (#288)', () => {
  it('decodes the write form Claude Code emits', () => {
    expect(decodeOsc52Write(`c;${b64('copied text')}`)).toBe('copied text');
  });

  it('decodes UTF-8, not Latin-1', () => {
    expect(decodeOsc52Write(`c;${b64('héllo ✓ 日本')}`)).toBe('héllo ✓ 日本');
  });

  it('accepts any selection target, including none', () => {
    expect(decodeOsc52Write(`;${b64('a')}`)).toBe('a');
    expect(decodeOsc52Write(`ps0;${b64('a')}`)).toBe('a');
  });

  /**
   * The query form asks the terminal to type the clipboard onto stdin, which
   * hands whatever the user last copied to any program — or any hostile output
   * a program merely prints. Refused, never answered.
   */
  it('refuses the query form', () => {
    expect(decodeOsc52Write('c;?')).toBeNull();
  });

  it('ignores a payload that is not base64', () => {
    expect(decodeOsc52Write('c;not base64!')).toBeNull();
    expect(decodeOsc52Write('c;abc')).toBeNull();
    expect(decodeOsc52Write('no-separator')).toBeNull();
  });

  it('ignores an empty payload rather than clearing the clipboard', () => {
    expect(decodeOsc52Write('c;')).toBeNull();
  });

  it('ignores a payload over the cap', () => {
    const over = 'A'.repeat(OSC52_PAYLOAD_LIMIT + 4);
    expect(decodeOsc52Write(`c;${over}`)).toBeNull();
    const at = 'A'.repeat(OSC52_PAYLOAD_LIMIT);
    expect(decodeOsc52Write(`c;${at}`)).not.toBeNull();
  });
});
