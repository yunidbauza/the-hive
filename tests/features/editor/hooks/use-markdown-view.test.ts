import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useMarkdownView } from '@features/editor/hooks/use-markdown-view';
import { useAppearanceStore } from '@stores/appearance-store';
import { useEditorStore } from '@stores/editor-store';

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('@lib/explorer/fs-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lib/explorer/fs-client')>()),
  readFile,
}));

beforeEach(() => {
  readFile.mockResolvedValue({ ok: true, value: { text: '# a\n', mtimeMs: 1, size: 4 } });
  useEditorStore.getState().reset();
  useAppearanceStore.getState().reset();
});

describe('useMarkdownView', () => {
  it('follows the setting until the file has a choice of its own', async () => {
    const { result } = renderHook(() => useMarkdownView());
    await act(async () => useEditorStore.getState().openFile('demo', 'README.md'));
    expect(result.current?.view).toBe('preview');

    act(() => useAppearanceStore.getState().setMarkdownOpensIn('source'));
    expect(result.current?.view).toBe('source');

    act(() => result.current?.setView('split'));
    act(() => useAppearanceStore.getState().setMarkdownOpensIn('preview'));
    expect(result.current?.view).toBe('split');
  });

  it('is null for a file with no preview', async () => {
    const { result } = renderHook(() => useMarkdownView());
    await act(async () => useEditorStore.getState().openFile('demo', 'src/a.ts'));
    expect(result.current).toBeNull();
  });
});
