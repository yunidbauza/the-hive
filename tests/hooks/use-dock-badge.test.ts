import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemoteLinkStatus } from '@shared/ipc-contract';
import type { HiveNotification } from '@shared/notification-contract';

import { useDockBadge } from '@/hooks/use-dock-badge';
import { useHiveStore } from '@stores/hive-store';

/**
 * The renderer half of this machine's dock badge (HIVE-159).
 *
 * While attached, no hub runs in this process, so the only thing that knows
 * the count of the inbox on screen is the renderer that is showing it.
 */

const badge = vi.fn<(count: number) => Promise<void>>(async () => undefined);

const notif = (id: string, unread: boolean): HiveNotification =>
  ({ id, unread }) as unknown as HiveNotification;

const link = (epoch: number): RemoteLinkStatus => ({
  state: 'attached',
  serverName: 'mini',
  attempt: 0,
  nextAttemptAt: null,
  reason: null,
  epoch,
  lost: 0,
});

beforeEach(() => {
  badge.mockClear();
  useHiveStore.setState({ notifs: [], remoteLink: null });
  window.hive = { notifications: { badge } } as unknown as typeof window.hive;
});

afterEach(() => {
  window.hive = undefined;
});

describe('useDockBadge', () => {
  it('reports the unread count on mount', () => {
    useHiveStore.setState({ notifs: [notif('a', true), notif('b', false), notif('c', true)] });

    renderHook(() => useDockBadge());

    expect(badge).toHaveBeenLastCalledWith(2);
  });

  it('reports again when the count changes', () => {
    renderHook(() => useDockBadge());

    act(() => {
      useHiveStore.setState({ notifs: [notif('a', true)] });
    });

    expect(badge).toHaveBeenLastCalledWith(1);
  });

  it('does not report again for a change that leaves the count alone', () => {
    useHiveStore.setState({ notifs: [notif('a', true)] });
    renderHook(() => useDockBadge());
    badge.mockClear();

    act(() => {
      useHiveStore.setState({ notifs: [notif('a', true), notif('b', false)] });
    });

    expect(badge).not.toHaveBeenCalled();
  });

  /*
    The case the count alone cannot catch. Attaching tears down the local hub
    and clears the badge it wrote, and if the server's inbox happens to hold
    the same count the store's number never moves.
  */
  it('reports again when this window attaches, even with the count unchanged', () => {
    useHiveStore.setState({ notifs: [notif('a', true)] });
    renderHook(() => useDockBadge());
    badge.mockClear();

    act(() => {
      useHiveStore.setState({ remoteLink: link(0) });
    });

    expect(badge).toHaveBeenCalledWith(1);
  });

  /*
    Ship's self review. A switch from one server straight to another clears the
    badge on teardown while `remoteLink` stays non-null and the rows stay put
    (`set-remote.ts` answers `changed: null` for a like-for-like switch), so a
    key on "is linked" never moves. The fresh status object does.
  */
  it('reports again on a switch between servers, with the link non-null throughout', () => {
    useHiveStore.setState({ notifs: [notif('a', true)], remoteLink: link(0) });
    renderHook(() => useDockBadge());
    badge.mockClear();

    act(() => {
      useHiveStore.setState({ remoteLink: { ...link(0), serverName: 'studio' } });
    });

    expect(badge).toHaveBeenCalledWith(1);
  });

  it('reports again when this window detaches, even with the count unchanged', () => {
    useHiveStore.setState({ notifs: [notif('a', true)], remoteLink: link(0) });
    renderHook(() => useDockBadge());
    badge.mockClear();

    act(() => {
      useHiveStore.setState({ remoteLink: null });
    });

    expect(badge).toHaveBeenCalledWith(1);
  });

  it('does nothing without a bridge, which is the browser demo', () => {
    window.hive = undefined;

    expect(() => renderHook(() => useDockBadge())).not.toThrow();
  });
});
