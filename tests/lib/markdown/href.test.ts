import { describe, expect, it } from 'vitest';

import { classifyHref } from '@lib/markdown/href';

describe('classifyHref', () => {
  it('lets only http and https out to the browser', () => {
    expect(classifyHref('https://example.com/a?b#c')).toEqual({
      kind: 'external',
      url: 'https://example.com/a?b#c',
    });
    expect(classifyHref('HTTP://example.com')).toEqual({
      kind: 'external',
      url: 'http://example.com/',
    });
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'vbscript:x',
    'data:text/html,<script>1</script>',
    'file:///etc/passwd',
    'C:\\Windows',
    '//evil.example/x',
    '',
    '#',
    '?only=query',
    '%E0%A4%A',
    // main's isSafeExternalUrl opens http(s) only; a mailto anchor would be a dead link.
    'mailto:a@b.co',
    // A browser strips tabs and newlines inside a URL and leading C0 controls,
    // so each of these reads as javascript: to it.
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    '\u0001javascript:alert(1)',
    'a%0Ab.md',
    '#a%00b',
    // A browser reads a leading \\ or /\ as // for http(s).
    '\\\\evil.example\\x',
    '/\\evil.example',
    // A scheme the allowlist admits, but no URL.
    'https://',
  ])('refuses %j', (href) => {
    expect(classifyHref(href)).toEqual({ kind: 'refused' });
  });

  it('reads a fragment as an anchor, decoded', () => {
    expect(classifyHref('#caf%C3%A9')).toEqual({ kind: 'anchor', id: 'café' });
  });

  it('reads a path as relative to the file, decoded, fragment and query dropped', () => {
    expect(classifyHref('docs/a%20b.md#part')).toEqual({
      kind: 'relative',
      path: 'docs/a b.md',
      fromRoot: false,
    });
    expect(classifyHref('../x.md?raw=1')).toEqual({
      kind: 'relative',
      path: '../x.md',
      fromRoot: false,
    });
  });

  it('reads a leading slash as the repository root, as GitHub does', () => {
    expect(classifyHref('/docs/x.md')).toEqual({
      kind: 'relative',
      path: 'docs/x.md',
      fromRoot: true,
    });
  });
});
