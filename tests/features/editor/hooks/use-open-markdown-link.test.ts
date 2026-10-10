import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useOpenMarkdownLink } from '@features/editor/hooks/use-open-markdown-link';
import { useAppearanceStore } from '@stores/appearance-store';
import { fileKey, useEditorStore } from '@stores/editor-store';

const { readFile, resolvePaths } = vi.hoisted(() => ({
  readFile: vi.fn(),
  resolvePaths: vi.fn(),
}));
vi.mock('@lib/explorer/fs-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lib/explorer/fs-client')>()),
  readFile,
  resolvePaths,
}));

const README = { projectId: 'demo', relPath: 'README.md', rootKey: '', sessionId: 'sess-1' };
const guide = { kind: 'relative' as const, path: 'docs/guide.md', fromRoot: false };

beforeEach(() => {
  vi.clearAllMocks();
  readFile.mockResolvedValue({ ok: true, value: { text: '# g\n', mtimeMs: 1, size: 4 } });
  useEditorStore.getState().reset();
  useAppearanceStore.getState().reset();
});

describe('useOpenMarkdownLink', () => {
  it('asks main without a session at the project root, then opens the answer', async () => {
    resolvePaths.mockResolvedValue([{ relPath: 'docs/guide.md', rootKey: '' }]);
    const { result } = renderHook(() => useOpenMarkdownLink(README));

    await act(async () => result.current.open(guide));

    expect(resolvePaths).toHaveBeenCalledWith('demo', undefined, ['docs/guide.md']);
    expect(useEditorStore.getState().activeKey).toBe(fileKey('demo', 'docs/guide.md'));
    expect(result.current.missing).toBeNull();
  });

  it('names a link main would not serve, and opens nothing', async () => {
    resolvePaths.mockResolvedValue([null]);
    const { result } = renderHook(() => useOpenMarkdownLink(README));

    await act(async () => result.current.open(guide));

    expect(result.current.missing).toBe('docs/guide.md');
    expect(useEditorStore.getState().openFiles).toHaveLength(0);

    act(() => result.current.dismiss());
    expect(result.current.missing).toBeNull();
  });

  /** A refused or failed IPC call is a miss too — never an unhandled rejection. */
  it('treats a failed resolve call as a miss', async () => {
    resolvePaths.mockRejectedValue(new Error('ipc closed'));
    const { result } = renderHook(() => useOpenMarkdownLink(README));

    await act(async () => result.current.open(guide));

    expect(result.current.missing).toBe('docs/guide.md');
  });

  it('replaces the open file in one-at-a-time mode, as the explorer does', async () => {
    useAppearanceStore.getState().setEditorNav('single');
    resolvePaths.mockResolvedValue([{ relPath: 'docs/guide.md', rootKey: '' }]);
    await act(async () => useEditorStore.getState().openFile('demo', 'README.md'));
    const { result } = renderHook(() => useOpenMarkdownLink(README));

    await act(async () => result.current.open(guide));

    expect(useEditorStore.getState().openFiles.map((file) => file.relPath)).toEqual([
      'docs/guide.md',
    ]);
  });

  /*
    In split view the dirty source sits beside the link. One-at-a-time mode
    must never close it to make room: the link opens beside it instead.
  */
  it('never discards a dirty buffer to follow a link', async () => {
    useAppearanceStore.getState().setEditorNav('single');
    resolvePaths.mockResolvedValue([{ relPath: 'docs/guide.md', rootKey: '' }]);
    await act(async () => useEditorStore.getState().openFile('demo', 'README.md'));
    act(() => useEditorStore.getState().edit(fileKey('demo', 'README.md'), '# edited\n'));
    const { result } = renderHook(() => useOpenMarkdownLink(README));

    await act(async () => result.current.open(guide));

    const files = useEditorStore.getState().openFiles;
    expect(files.map((file) => file.relPath)).toEqual(['README.md', 'docs/guide.md']);
    expect(files[0]?.text).toBe('# edited\n');
    expect(useEditorStore.getState().activeKey).toBe(fileKey('demo', 'docs/guide.md'));
  });

  it('focuses a target that is already open instead of reopening it', async () => {
    useAppearanceStore.getState().setEditorNav('single');
    resolvePaths.mockResolvedValue([{ relPath: 'README.md', rootKey: '' }]);
    await act(async () => useEditorStore.getState().openFile('demo', 'README.md'));
    act(() => useEditorStore.getState().edit(fileKey('demo', 'README.md'), '# edited\n'));
    const { result } = renderHook(() => useOpenMarkdownLink(README));

    await act(async () => result.current.open({ ...guide, path: 'README.md' }));

    expect(useEditorStore.getState().openFiles[0]?.text).toBe('# edited\n');
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  /*
    Main checked the project root (no session); reading the hit with the
    session could serve a linked worktree's copy under the root's key.
  */
  it('reads a project-root hit without the session main did not use', async () => {
    resolvePaths.mockResolvedValue([{ relPath: 'docs/guide.md', rootKey: '' }]);
    const { result } = renderHook(() => useOpenMarkdownLink(README));

    await act(async () => result.current.open(guide));

    expect(readFile).toHaveBeenLastCalledWith('demo', 'docs/guide.md', undefined);
  });

  it('opens a widened-root hit under that root, with the session that names it', async () => {
    resolvePaths.mockResolvedValue([{ relPath: 'docs/guide.md', rootKey: '/w/tree' }]);
    const { result } = renderHook(() =>
      useOpenMarkdownLink({ ...README, rootKey: '/w/tree' }),
    );

    await act(async () => result.current.open(guide));

    expect(resolvePaths).toHaveBeenCalledWith('demo', 'sess-1', ['/w/tree/docs/guide.md']);
    expect(useEditorStore.getState().activeKey).toBe(fileKey('demo', 'docs/guide.md', '/w/tree'));
    expect(readFile).toHaveBeenLastCalledWith('demo', 'docs/guide.md', 'sess-1');
  });

  it('lets the latest click win when answers arrive out of order', async () => {
    let answerFirst: (value: unknown) => void = () => undefined;
    resolvePaths
      .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce([{ relPath: 'docs/b.md', rootKey: '' }]);
    const { result } = renderHook(() => useOpenMarkdownLink(README));

    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.open(guide);
      await result.current.open({ ...guide, path: 'docs/b.md' });
    });
    await act(async () => {
      answerFirst([null]);
      await first;
    });

    expect(useEditorStore.getState().activeKey).toBe(fileKey('demo', 'docs/b.md'));
    expect(result.current.missing).toBeNull();
  });
});
