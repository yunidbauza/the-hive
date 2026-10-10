import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PARSE_DEBOUNCE_MS, useMarkdownDoc } from '@features/editor/hooks/use-markdown-doc';

const { parseMarkdown } = vi.hoisted(() => ({ parseMarkdown: vi.fn() }));
vi.mock('@lib/markdown/parse', () => ({ parseMarkdown }));

const DOC_A = { blocks: [] };
const DOC_B = { blocks: [{ kind: 'hr' as const, line: 0 }] };

beforeEach(() => {
  vi.useFakeTimers();
  parseMarkdown.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

const flush = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('useMarkdownDoc', () => {
  it('parses the first text at once, then debounces edits', async () => {
    parseMarkdown.mockResolvedValueOnce(DOC_A).mockResolvedValueOnce(DOC_B);
    const { result, rerender } = renderHook(({ text }) => useMarkdownDoc(text), {
      initialProps: { text: '# a' },
    });

    await flush(0);
    expect(result.current).toEqual({ doc: DOC_A, failed: false });

    rerender({ text: '# ab' });
    rerender({ text: '# abc' });
    await flush(PARSE_DEBOUNCE_MS - 1);
    expect(parseMarkdown).toHaveBeenCalledTimes(1);

    await flush(1);
    expect(parseMarkdown).toHaveBeenCalledTimes(2);
    expect(parseMarkdown).toHaveBeenLastCalledWith('# abc');
    expect(result.current.doc).toBe(DOC_B);
  });

  it('reports a failed parse and recovers on the next edit', async () => {
    parseMarkdown.mockRejectedValueOnce(new Error('chunk failed')).mockResolvedValueOnce(DOC_A);
    const { result, rerender } = renderHook(({ text }) => useMarkdownDoc(text), {
      initialProps: { text: 'x' },
    });

    await flush(0);
    expect(result.current).toEqual({ doc: null, failed: true });

    rerender({ text: 'xy' });
    await flush(PARSE_DEBOUNCE_MS);
    expect(result.current).toEqual({ doc: DOC_A, failed: false });
  });

  it('parses nothing without text', async () => {
    renderHook(() => useMarkdownDoc(null));
    await flush(PARSE_DEBOUNCE_MS);
    expect(parseMarkdown).not.toHaveBeenCalled();
  });
});
