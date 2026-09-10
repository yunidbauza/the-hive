import { useEffect } from 'react';

import { readAppInfo } from '@lib/project-config';
import { useSetRemoteLink } from '@stores/hive-store';

/**
 * Keeps the store's picture of this window's attachment current (HIVE-150).
 *
 * Mounted once, beside `useNotificationStream`, and for the same reason: the
 * link changes while nobody is looking at Settings, and a state read on demand
 * is wrong for as long as nobody asks. Before this, the header chip's only
 * source was `AppInfo.attachedServerName` read inside an effect keyed on the
 * config snapshot — so a socket that died without a config write left the chip
 * naming a machine this window could no longer reach, for as long as the window
 * stayed open.
 *
 * **Subscribe first, then hydrate**, exactly as `useNotificationStream` argues:
 * the other order drops a transition that lands between the read and the
 * subscription. Here the hydration is genuinely needed rather than belt and
 * braces — on a boot attach, `switchIpcMode` raises its `attached` status while
 * the window is still being created, so a push-only hook would show no chip at
 * all on a window that is attached, until something else went wrong. And it is
 * the one case where a push cannot help, because the push already happened.
 *
 * The hydration never overwrites a real push. It only fills in a link the store
 * does not have yet, so a drop that arrives while `app:info` is in flight wins
 * over the stale "attached" that read was always going to return.
 */
export function useRemoteLinkStream(): void {
  const setRemoteLink = useSetRemoteLink();

  useEffect(() => {
    // No bridge is the browser demo, which attaches to nothing.
    const bridge = window.hive;
    if (!bridge) return;

    let pushed = false;
    const unsubscribe = bridge.remote.onLinkStatus((status) => {
      pushed = true;
      setRemoteLink(status);
    });

    void readAppInfo()
      .then((info) => {
        const serverName = info?.attachedServerName ?? null;
        /*
          Nothing to install for a window with no attachment: `null` is already
          the store's initial value and the chip's "render nothing" case, and
          synthesising a `disconnected` here would claim a link was lost that
          this window never had.
        */
        if (pushed || serverName === null) return;
        setRemoteLink({
          state: 'attached',
          serverName,
          attempt: 0,
          nextAttemptAt: null,
          reason: null,
          /*
            0, matching what `armReattach` emits for a first attach. The epoch
            counts reattaches, and a window that has only just opened has
            nothing to re-establish.
          */
          epoch: 0,
        });
      })
      .catch(() => {
        // A failed read is a chip that appears on the next transition, which is
        // strictly better than a render that throws.
      });

    return unsubscribe;
  }, [setRemoteLink]);
}
