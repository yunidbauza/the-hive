// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { isSafeExternalUrl } from '../../../electron/main/external-links';

/**
 * Terminal output is untrusted input, and the web-links addon makes anything
 * URL-shaped in it clickable. Everything here is a string that could plausibly
 * arrive as the output of a command.
 */
describe('isSafeExternalUrl', () => {
  it('allows http and https', () => {
    expect(isSafeExternalUrl('https://github.com/yunidbauza/the-hive')).toBe(true);
    expect(isSafeExternalUrl('http://localhost:5173/')).toBe(true);
  });

  it('rejects file:, which would open a local path from terminal output', () => {
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects custom schemes registered by other installed apps', () => {
    expect(isSafeExternalUrl('vscode://file/etc/hosts')).toBe(false);
    expect(isSafeExternalUrl('slack://channel?id=C123')).toBe(false);
    expect(isSafeExternalUrl('ms-msdt:/id')).toBe(false);
  });

  it('rejects javascript:', () => {
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects data: URLs', () => {
    expect(isSafeExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects a scheme that merely starts with http', () => {
    // `httpsx:` parses fine and is not https.
    expect(isSafeExternalUrl('httpsx://evil.example')).toBe(false);
  });

  it('rejects anything that is not a parseable URL', () => {
    expect(isSafeExternalUrl('not a url')).toBe(false);
    expect(isSafeExternalUrl('')).toBe(false);
    expect(isSafeExternalUrl('/relative/path')).toBe(false);
  });
});
