import { useEffect } from 'react';

import { useRemoteLink, useUnreadCount } from '@stores/hive-store';

/**
 * Tell main how many unread rows this window's inbox is showing (HIVE-159).
 *
 * While attached, no hub runs in this process, so nothing in main knows the
 * count: it is computed on the server, and until this hook the server wrote it
 * onto the *server's* dock. The renderer already derives it from the rows it
 * receives, so it reports that number, and main writes it onto this machine's
 * dock (`notifications:badge`, `PROCESS_LOCAL`).
 *
 * In local mode the report is ignored — the hub counts its own buffer and
 * writes the badge itself — so this hook does not need to know which mode it
 * is in. Main does, structurally: the two modes bind different handlers.
 *
 * **Why the link is a dependency, not only the count.** Attaching tears down
 * the local hub, and the teardown clears the badge it wrote. If the server's
 * inbox happens to hold the same number of unread rows, the count never moves
 * and nothing would say it again.
 *
 * **Why the reattach epoch is not.** A reattach rebinds only the proxy, never
 * the handlers (`router.ts`, `armReattach`), so nothing clears the badge and
 * the last report still stands; the reattach snapshot's rows then move the
 * count if the server's inbox moved. The epoch is for effects that own state
 * the server keeps per surface (`tests/hooks/reattach-epoch.test.ts`), and a
 * dock badge is not one.
 *
 * Mounted once at the composition root, beside `useNotificationStream`, which
 * is what fills the rows this counts.
 */
export function useDockBadge(): void {
  const unread = useUnreadCount();
  const linked = useRemoteLink() !== null;

  useEffect(() => {
    // No bridge is the browser demo, which has no dock to badge.
    /*
      The rejection is swallowed: the dock is decoration, and a report lost
      to a window torn down mid-call is replaced by the next one.
    */
    void window.hive?.notifications.badge(unread).catch(() => undefined);
  }, [unread, linked]);
}
