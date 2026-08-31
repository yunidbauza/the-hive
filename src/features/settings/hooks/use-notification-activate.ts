import { useEffect } from 'react';

import { currentRowFor, isAgentId, useOpenEntity } from '@stores/hive-store';
import { useRevealRailTab } from '@stores/ui-store';

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
  const revealRailTab = useRevealRailTab();

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
     *
     * Except when `entityId` names an **agent** (HIVE-118): an agent has no
     * terminal, so there is nothing here for it to resolve. Worse, resolving
     * it anyway can be actively wrong — `hydrateAgents` documents that an
     * agent's name is a legal session id, so on a live machine an agent can
     * come to share a name with some session's `terminalId`. `currentRowFor`
     * would then walk its `/clear`-following search loop, find that session,
     * and open it instead of the agent the toast was actually about. Checked
     * with `isAgentId` first and opened directly when it is one — an agent's
     * entity id already *is* the id `openEntity` wants.
     */
    return bridge.notifications.onActivate((event) => {
      /**
       * An ask is answered where it is, so the destination is the card
       * (HIVE-118).
       *
       * `revealRailTab`, never `setRailTab`: the rail has three tabs and can
       * be collapsed outright, and a click that raises the window onto a
       * hidden rail — or onto the explorer — has delivered the user to a
       * screen with no card and no signal on it. That is the whole promise an
       * ask toast makes by *not* dismissing its own row: the click is what
       * takes you to the row.
       *
       * Idempotent, so an ask clicked while the inbox is already up leaves it
       * exactly as it was rather than flipping the rail shut.
       */
      if (event.type === 'ask') {
        revealRailTab('inbox');
        return;
      }

      openEntity(
        isAgentId(event.entityId) ? event.entityId : currentRowFor(event.entityId),
      );
    });
  }, [openEntity, revealRailTab]);
}
