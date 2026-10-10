import { javascript } from '@codemirror/lang-javascript';
import { highlightCode } from '@lezer/highlight';
import { describe, expect, it } from 'vitest';

import { codeClassHighlighter } from '@components/editor/editor-theme';

/**
 * The preview's code fences have no `EditorView`, so they cannot use the
 * `HighlightStyle`'s generated classes, which only exist once a view mounts
 * them. They take Tailwind utilities from the same role table instead.
 */
describe('codeClassHighlighter', () => {
  it('classes tokens with the code-token utilities', () => {
    const text = 'const a = "s"; // c';
    const spans: Array<[string, string]> = [];
    highlightCode(
      text,
      javascript().language.parser.parse(text),
      codeClassHighlighter,
      (piece, classes) => spans.push([piece, classes]),
      () => undefined,
    );

    expect(spans).toContainEqual(['const', 'text-code-keyword']);
    expect(spans).toContainEqual(['"s"', 'text-code-string']);
    expect(spans).toContainEqual(['// c', 'text-code-comment italic']);
  });
});
