import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRemoteLinkStream } from '@hooks/use-remote-link';
import { useHiveStore } from '@stores/hive-store';

/**
 * The subscription that keeps the store's picture of the attachment current
 * (HIVE-150).
 *
 * The defect underneath it: `AppInfo.attachedServerName` is the runtime truth
 * but it is read on demand, and `useAttachedServer` re-read it only when a
 * `ConfigSnapshot` changed. A socket dying writes no config, so the chip went
 * on naming a machine this window could no longer reach.
 */

type LinkListener = (status: unknown) => void;

let listeners: LinkListener[] = [];
let appInfo: { attachedServerName: string | null; remoteLink: unknown } | null = null;
let onLinkStatus: ReturnType<typeof vi.fn>;
let unsubscribe: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useHiveStore.getState().reset();
  listeners = [];
  appInfo = { attachedServerName: null, remoteLink: null };
  unsubscribe = vi.fn();
  onLinkStatus = vi.fn((listener: LinkListener) => {
    listeners.push(listener);
    return unsubscribe;
  });

  window.hive = {
    remote: { onLinkStatus },
    appInfo: () => Promise.resolve(appInfo),
  } as unknown as Window['hive'];
});

afterEach(() => {
  delete (window as { hive?: unknown }).hive;
});

const push = (status: Record<string, unknown>): void => {
  for (const listener of listeners) listener(status);
};

const attached = (over: Record<string, unknown> = {}) => ({
  state: 'attached',
  serverName: 'mini',
  attempt: 0,
  nextAttemptAt: null,
  reason: null,
  epoch: 0,
  ...over,
});

describe('useRemoteLinkStream', () => {
  it('installs what main pushes', async () => {
    renderHook(() => {
      useRemoteLinkStream();
    });

    push(attached({ state: 'reconnecting', attempt: 2 }));

    await waitFor(() => {
      expect(useHiveStore.getState().remoteLink).toMatchObject({
        state: 'reconnecting',
        attempt: 2,
      });
    });
  });

  it('hydrates a boot attach, whose push happened before this window existed', async () => {
    appInfo = { attachedServerName: 'mini', remoteLink: attached() };

    renderHook(() => {
      useRemoteLinkStream();
    });

    /*
      The case a push-only hook cannot cover. `switchIpcMode` raises its
      `attached` status while the window is still being created, so without this
      read a window that really is attached would show no chip at all until
      something went wrong.
    */
    await waitFor(() => {
      expect(useHiveStore.getState().remoteLink).toMatchObject({
        state: 'attached',
        serverName: 'mini',
        epoch: 0,
      });
    });
  });

  it('claims no link for a window that has none', async () => {
    renderHook(() => {
      useRemoteLinkStream();
    });

    await waitFor(() => {
      expect(onLinkStatus).toHaveBeenCalled();
    });

    /*
      `null` is both the store's initial value and the chip's render-nothing
      case. Synthesising a `disconnected` here would claim a link was lost that
      this window never had.
    */
    expect(useHiveStore.getState().remoteLink).toBeNull();
  });

  it('lets a drop that arrives first win over the stale read behind it', async () => {
    appInfo = { attachedServerName: 'mini', remoteLink: attached() };

    renderHook(() => {
      useRemoteLinkStream();
    });
    // The socket dies while `app:info` is still in flight. That read was always
    // going to answer "attached", and installing it would undo the truth.
    push(attached({ state: 'reconnecting', attempt: 1 }));

    await waitFor(() => {
      expect(useHiveStore.getState().remoteLink).toMatchObject({ state: 'reconnecting' });
    });
    // And it stays lost once the read lands.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useHiveStore.getState().remoteLink).toMatchObject({ state: 'reconnecting' });
  });

  it('hydrates a degraded link as degraded, never as attached', async () => {
    /*
      `AppInfo.attachedServerName` stays non-null through a drop and through a
      terminal disconnect, so a window opened or reloaded mid-outage used to
      synthesise a healthy `attached` status out of it and paint a brand chip
      over a link that was down. While reconnecting the next backoff emit
      corrected it; after a terminal disconnect no further transition ever
      arrives, and the lie was permanent.
    */
    appInfo = {
      attachedServerName: 'mini',
      remoteLink: attached({ state: 'disconnected', reason: 'That device was revoked.' }),
    };

    renderHook(() => {
      useRemoteLinkStream();
    });

    await waitFor(() => {
      expect(useHiveStore.getState().remoteLink).toMatchObject({
        state: 'disconnected',
        serverName: 'mini',
        reason: 'That device was revoked.',
      });
    });
  });

  it('re-states the fleet from a reattach’s snapshot', async () => {
    renderHook(() => {
      useRemoteLinkStream();
    });

    push(attached({ epoch: 2, snapshot: { 'notifications:list': [] } }));

    /*
      Everything the server pushed while the socket was down is gone —
      terminals are covered by `resumeFrom` and per-surface state by the epoch,
      and this is the third category. Asserted through the store action rather
      than by inspecting hydrated rows: what this hook owes is that the snapshot
      reaches `applyAttachSnapshot` at all.
    */
    await waitFor(() => {
      expect(useHiveStore.getState().remoteLink?.epoch).toBe(2);
    });
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => {
      useRemoteLinkStream();
    });

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a bridge, which is the browser demo', () => {
    delete (window as { hive?: unknown }).hive;

    expect(() => {
      renderHook(() => {
        useRemoteLinkStream();
      });
    }).not.toThrow();
    expect(useHiveStore.getState().remoteLink).toBeNull();
  });
});
