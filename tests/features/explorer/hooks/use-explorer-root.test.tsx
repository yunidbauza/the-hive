import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useExplorerRoot } from '@features/explorer/hooks/use-explorer-root';

/**
 * Main's verdict, asked for rather than inferred (review of PR 124).
 *
 * The renderer holds both inputs — the project's path and the session's cwd —
 * and used to draw its own conclusion from them: *cwd differs from the project,
 * therefore the tree is the session's worktree*. That is wrong in the one case
 * that matters. Main widens the root only after proving the cwd is a registered
 * linked worktree of that project, and when the proof fails it serves the
 * project root anyway — so the renderer labelled the project's own files with a
 * worktree's name.
 *
 * Every test here is about that gap.
 */

const { hasFsBridge, readRoot } = vi.hoisted(() => ({
  hasFsBridge: vi.fn(),
  readRoot: vi.fn(),
}));

vi.mock('@lib/explorer/fs-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lib/explorer/fs-client')>()),
  hasFsBridge,
  readRoot,
}));

beforeEach(() => {
  vi.clearAllMocks();
  hasFsBridge.mockReturnValue(true);
});

describe('useExplorerRoot', () => {
  it('answers null until main has said', () => {
    readRoot.mockReturnValue(new Promise(() => undefined));

    const { result } = renderHook(() => useExplorerRoot('nova-web', 'sess-a'));

    /*
      Not `''`. An empty key is a *claim* that the tree is the project's, and
      acting on it before main has answered is the guess this hook removes —
      callers hold their reads back for the one round trip instead.
    */
    expect(result.current).toBeNull();
  });

  it('reports the project root as an empty key', async () => {
    readRoot.mockResolvedValue({
      ok: true,
      value: { root: '/w/nova-web', widened: false },
    });

    const { result } = renderHook(() => useExplorerRoot('nova-web', 'sess-a'));

    await waitFor(() => {
      expect(result.current).toEqual({
        key: '',
        widened: false,
        path: '/w/nova-web',
      });
    });
  });

  it('reports a widened root by its own path', async () => {
    readRoot.mockResolvedValue({
      ok: true,
      value: { root: '/w/trees/side', widened: true },
    });

    const { result } = renderHook(() => useExplorerRoot('nova-web', 'sess-a'));

    await waitFor(() => {
      expect(result.current?.key).toBe('/w/trees/side');
      expect(result.current?.widened).toBe(true);
    });
  });

  /**
   * The whole reason the verdict travels rather than being computed. A session
   * sitting in `/tmp` has a cwd that differs from the project — which is all the
   * renderer could see — and main refuses it.
   */
  it('reports a refused cwd as the project root, not as a worktree', async () => {
    readRoot.mockResolvedValue({
      ok: true,
      value: { root: '/w/nova-web', widened: false },
    });

    const { result } = renderHook(() => useExplorerRoot('nova-web', 'sess-a'));

    await waitFor(() => {
      expect(result.current?.widened).toBe(false);
      expect(result.current?.key).toBe('');
    });
  });

  it('treats a failed read as the project root', async () => {
    readRoot.mockResolvedValue({
      ok: false,
      error: { code: 'EPROJECT', message: 'no such project' },
    });

    const { result } = renderHook(() => useExplorerRoot('nova-web', 'sess-a'));

    await waitFor(() => {
      expect(result.current).toEqual({ key: '', widened: false, path: '' });
    });
  });

  it('clears the previous verdict before reading for a new session', async () => {
    readRoot.mockResolvedValue({
      ok: true,
      value: { root: '/w/trees/side', widened: true },
    });

    const { result, rerender } = renderHook(
      ({ session }: { session: string }) =>
        useExplorerRoot('nova-web', session),
      { initialProps: { session: 'sess-a' } },
    );

    await waitFor(() => {
      expect(result.current?.widened).toBe(true);
    });

    readRoot.mockReturnValue(new Promise(() => undefined));
    act(() => {
      rerender({ session: 'sess-b' });
    });

    // A stale verdict under a new session is the failure this hook exists to
    // prevent; leaving the old one on screen for one round trip would be it.
    expect(result.current).toBeNull();
  });

  it('asks nothing without a project or a bridge', () => {
    const { result: noProject } = renderHook(() =>
      useExplorerRoot(null, 'sess-a'),
    );
    expect(noProject.current).toBeNull();

    hasFsBridge.mockReturnValue(false);
    const { result: noBridge } = renderHook(() =>
      useExplorerRoot('nova-web', 'sess-a'),
    );
    expect(noBridge.current).toBeNull();

    expect(readRoot).not.toHaveBeenCalled();
  });
});
