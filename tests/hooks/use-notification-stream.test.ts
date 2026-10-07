import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HiveNotification } from '@shared/notification-contract';

import { useNotificationStream } from '@hooks/use-notification-stream';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

import { notif, resetNotifIds } from '@tests/support/notifications';

let onNew: (n: HiveNotification) => void = () => {};
let resolveList: (rows: HiveNotification[]) => void = () => {};

const bridge = {
  notifications: {
    onNew: vi.fn((cb: (n: HiveNotification) => void) => {
      onNew = cb;
      return () => {};
    }),
    onRead: vi.fn(() => () => {}),
    onDismissed: vi.fn(() => () => {}),
    list: vi.fn(
      () =>
        new Promise<HiveNotification[]>((resolve) => {
          resolveList = resolve;
        }),
    ),
  },
} as unknown as Window['hive'];

beforeEach(() => {
  resetNotifIds();
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
  (window as { hive?: unknown }).hive = bridge;
});

afterEach(() => {
  delete (window as { hive?: unknown }).hive;
  document.body.innerHTML = '';
});

const ask = () => notif({ kind: 'agent.ask', action: { type: 'ask', thread: 't1' } });

describe('useNotificationStream — arrivals (HIVE-198)', () => {
  it('a live Summons row rises', () => {
    renderHook(() => useNotificationStream());
    const row = ask();
    onNew(row);
    expect(useUiStore.getState().stackUp).toBe(true);
  });

  it('an echo does not', () => {
    renderHook(() => useNotificationStream());
    onNew(notif({ kind: 'clone.done', action: { type: 'none' } }));
    expect(useUiStore.getState().stackUp).toBe(false);
  });

  it('the boot snapshot raises nothing', async () => {
    renderHook(() => useNotificationStream());
    resolveList([ask()]);
    await vi.waitFor(() => expect(useHiveStore.getState().notifs).toHaveLength(1));
    expect(useUiStore.getState().stackUp).toBe(false);
  });

  it('after a hydrate, only the live arrival rises', async () => {
    renderHook(() => useNotificationStream());
    const old = ask();
    resolveList([old]);
    await vi.waitFor(() => expect(useHiveStore.getState().notifs).toHaveLength(1));
    const live = notif({ kind: 'agent.ask', action: { type: 'ask', thread: 't2' } });
    onNew(live);
    expect(useUiStore.getState().stackUp).toBe(true);
  });

  it('with the keyboard in a terminal it pulses instead of rising', () => {
    document.body.innerHTML = '<div data-terminal-id="t"><textarea></textarea></div>';
    document.querySelector('textarea')?.focus();
    renderHook(() => useNotificationStream());
    const row = ask();
    onNew(row);
    expect(useUiStore.getState().stackUp).toBe(false);
    expect(useUiStore.getState().arrivalPulse).toBe(row.id);
  });
});
