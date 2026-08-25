import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNotificationActivate } from '@features/settings/hooks/use-notification-activate';
import { useUiStore } from '@stores/ui-store';

/**
 * The renderer half of click-to-open (story 106).
 *
 * Main raises the window; this opens the tab. The test that matters most is the
 * unsubscribe: this mounts at the composition root, so a leak here is a
 * listener per app lifetime rather than per component.
 */

type Listener = (event: { entityId: string }) => void;

let listeners: Listener[] = [];
const unsubscribe = vi.fn();

const bridge = {
  notifications: {
    onActivate: vi.fn((callback: Listener) => {
      listeners.push(callback);
      return unsubscribe;
    }),
  },
} as unknown as Window['hive'];

beforeEach(() => {
  listeners = [];
  vi.clearAllMocks();
  useUiStore.getState().openTab('orch');
});

afterEach(() => {
  delete (window as { hive?: unknown }).hive;
});

describe('useNotificationActivate', () => {
  it('opens the session the notification named', () => {
    (window as { hive?: unknown }).hive = bridge;
    renderHook(() => useNotificationActivate());

    listeners[0]?.({ entityId: 'nova-web' });

    expect(useUiStore.getState().activeTab).toBe('nova-web');
  });

  it('unsubscribes on unmount', () => {
    (window as { hive?: unknown }).hive = bridge;
    const { unmount } = renderHook(() => useNotificationActivate());

    unmount();

    expect(unsubscribe).toHaveBeenCalled();
  });

  it('does nothing without a bridge — the browser demo has no OS to notify', () => {
    expect(() => renderHook(() => useNotificationActivate())).not.toThrow();
  });
});
