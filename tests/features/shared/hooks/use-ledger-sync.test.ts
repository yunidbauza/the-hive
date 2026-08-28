import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useLedgerSync } from '@features/shared/hooks/use-ledger-sync';
import { useHiveStore } from '@stores/hive-store';

import type { LedgerEntry } from '@shared/ledger-contract';

const entry = (id: string): LedgerEntry => ({
  id,
  ts: 1,
  from: 'sess-a',
  kind: 'post',
  body: id,
});

describe('useLedgerSync', () => {
  afterEach(() => {
    delete (window as { hive?: unknown }).hive;
    // `hydrateLedger` merges rather than replaces, so it cannot be a reset.
    useHiveStore.setState({ ledger: [] });
  });

  it('does nothing on the browser target, where there is no bridge', () => {
    expect(() => renderHook(() => useLedgerSync())).not.toThrow();
    expect(useHiveStore.getState().ledger).toEqual([]);
  });

  it('hydrates from the bridge on mount', async () => {
    (window as { hive?: unknown }).hive = {
      ledger: {
        list: vi.fn().mockResolvedValue({ entries: [entry('1')], openAsks: [], claims: {} }),
        onChanged: vi.fn().mockReturnValue(() => {}),
      },
    };

    renderHook(() => useLedgerSync());

    await waitFor(() => {
      expect(useHiveStore.getState().ledger.map((found) => found.id)).toEqual(['1']);
    });
  });

  it('appends what the push channel delivers', async () => {
    let deliver: ((entry: LedgerEntry) => void) | undefined;
    (window as { hive?: unknown }).hive = {
      ledger: {
        list: vi.fn().mockResolvedValue({ entries: [], openAsks: [], claims: {} }),
        onChanged: vi.fn((callback: (entry: LedgerEntry) => void) => {
          deliver = callback;
          return () => {};
        }),
      },
    };

    renderHook(() => useLedgerSync());
    await waitFor(() => expect(deliver).toBeDefined());
    deliver?.(entry('2'));

    expect(useHiveStore.getState().ledger.map((found) => found.id)).toEqual(['2']);
  });

  /**
   * The hydrate/push race, at the seam rather than in the store.
   *
   * `list()` resolves with a snapshot main took *before* the pushed entry
   * existed. The hook mounts once and never remounts, so a replacing hydrate
   * would lose `2` with nothing left to re-fetch it.
   */
  it('keeps an entry pushed while the hydrate is still in flight', async () => {
    let deliver: ((entry: LedgerEntry) => void) | undefined;
    let settle: ((snapshot: unknown) => void) | undefined;
    (window as { hive?: unknown }).hive = {
      ledger: {
        list: vi.fn().mockReturnValue(
          new Promise((resolve) => {
            settle = resolve;
          }),
        ),
        onChanged: vi.fn((callback: (entry: LedgerEntry) => void) => {
          deliver = callback;
          return () => {};
        }),
      },
    };

    renderHook(() => useLedgerSync());
    await waitFor(() => expect(deliver).toBeDefined());
    deliver?.(entry('2'));
    settle?.({ entries: [entry('1')], openAsks: [], claims: {} });

    await waitFor(() => {
      expect(useHiveStore.getState().ledger.map((found) => found.id)).toEqual(['1', '2']);
    });
  });

  it('unsubscribes on unmount', async () => {
    const off = vi.fn();
    (window as { hive?: unknown }).hive = {
      ledger: {
        list: vi.fn().mockResolvedValue({ entries: [], openAsks: [], claims: {} }),
        onChanged: vi.fn().mockReturnValue(off),
      },
    };

    const { unmount } = renderHook(() => useLedgerSync());
    await waitFor(() => expect(off).not.toHaveBeenCalled());
    unmount();

    expect(off).toHaveBeenCalledTimes(1);
  });
});
