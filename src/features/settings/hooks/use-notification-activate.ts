import { useEffect } from 'react';

import { currentRowFor, useOpenEntity } from '@stores/hive-store';

/**
 * Open the session a clicked notification was about (story 106).
 *
 * The renderer half of a two-part answer: main raises and focuses the window,
 * because only main can, and this opens the tab, because only the renderer
 * knows what opening a session means.
 *
 * Without it a notification is a dead end — it tells you `nova-web` finished
 * and then leaves you to find `nova-web` yourself, which is most of the work it
 * was supposed to save.
 *
 * Mounted once, at the composition root, like `useSessionStatus`. A per-session
 * subscription would mean thirteen listeners on one broadcast channel.
 */
export function useNotificationActivate(): void {
  const openEntity = useOpenEntity();

  useEffect(() => {
    // No bridge is the browser demo, where there is no OS to notify.
    const bridge = window.hive;
    if (!bridge) return;

    /**
     * Through the domain gate, not straight to the tab (story 108).
     *
     * This path is the most likely one to name a session that has since ended —
     * "Session ended" is itself one of the notifications main raises, and the
     * user may click it minutes later. Opening the tab anyway would put them
     * inside a dead terminal; the gate sends them to the fleet view instead.
     */
    /**
     * `entityId` from main is a **terminal** id, so resolve it to the row that
     * owns the terminal now.
     *
     * After a `/clear` the raw id names the retired session, which the gate
     * above correctly refuses — so a notification about work happening *right
     * now* would bounce the user to the orchestrator. The terminal is the same
     * one; only the row changed.
     */
    return bridge.notifications.onActivate(({ entityId }) => {
      openEntity(currentRowFor(entityId));
    });
  }, [openEntity]);
}
