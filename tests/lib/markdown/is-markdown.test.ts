import { describe, expect, it } from 'vitest';

import { isMarkdownFile } from '@lib/markdown/is-markdown';

describe('isMarkdownFile', () => {
  it('admits .md and .markdown in any case, and not .mdx', () => {
    expect(['README.md', 'notes.MARKDOWN', 'x.mdx', 'md', 'app.ts'].map(isMarkdownFile)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});
