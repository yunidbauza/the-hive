import { useEffect } from 'react';

import { loadProjectConfig, readAppInfo } from '@lib/project-config';
import { useApplyAttachSnapshot, useSetRemoteLink } from '@stores/hive-store';

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
  const applyAttachSnapshot = useApplyAttachSnapshot();

  useEffect(() => {
    // No bridge is the browser demo, which attaches to nothing.
    const bridge = window.hive;
    if (!bridge) return;

    let pushed = false;
    const unsubscribe = bridge.remote.onLinkStatus((status) => {
      /*
        `null` is a real answer, not an absent one: it is what main pushes when
        this window goes local, and installing it is what stops the last
        `attached` status standing after a deliberate detach.
      */
      pushed = true;
      setRemoteLink(status);
      /*
        A reattach carries the fleet the server has *now* (HIVE-150). Everything
        it pushed while the socket was down is gone: a session that ended still
        renders as running, notifications never reached the inbox, ledger
        entries and PR sweeps vanished. `applyAttachSnapshot` is the same set of
        idempotent hydrations a first attach runs through
        `SetRemoteResult.changed`, so re-applying it costs nothing and closes
        the third category the epoch and `resumeFrom` do not cover.
      */
      if (status?.snapshot !== undefined) {
        applyAttachSnapshot(status.snapshot);
        /*
          The config is the one part the snapshot's handler table does not carry
          — `config:get` has no entry, deliberately, because the config module
          owns that read. Re-read it here so a project the server added or
          removed during the outage is not invisible until the next write.
        */
        void loadProjectConfig();
      }
    });

    void readAppInfo()
      .then((info) => {
        /*
          The status **verbatim**, never synthesised from
          `AppInfo.attachedServerName`.

          That field answers "is a socket held", and it stays non-null through a
          drop and through a terminal disconnect — `attached` is cleared only by
          an explicit mode switch. Building an `attached` status out of it, as
          this did, painted a healthy brand chip over a link that was down on
          any window opened or reloaded mid-outage; while reconnecting the next
          backoff emit corrected it, but after a terminal disconnect no further
          transition ever arrives and the lie was permanent.

          `null` needs nothing installed — it is already the store's initial
          value and the chip's render-nothing case.
        */
        if (pushed || info?.remoteLink == null) return;
        setRemoteLink(info.remoteLink);
      })
      .catch(() => {
        // A failed read is a chip that appears on the next transition, which is
        // strictly better than a render that throws.
      });

    return unsubscribe;
  }, [applyAttachSnapshot, setRemoteLink]);
}
