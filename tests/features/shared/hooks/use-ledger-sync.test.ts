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
    useHiveStore.getState().hydrateLedger([]);
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
