import { useEffect } from 'react';

import { useOpenTab } from '@stores/ui-store';

/**
 * Open the session a clicked notification was about (story 106).
 *
 * The renderer half of a two-part answer: main raises and focuses the window,
 * because only main can, and this opens the tab, because only the renderer
 * knows what opening a session means.
 *
 * Without it a notification is a dead end — it tells you `apfm-web` finished
 * and then leaves you to find `apfm-web` yourself, which is most of the work it
 * was supposed to save.
 *
 * Mounted once, at the composition root, like `useSessionStatus`. A per-session
 * subscription would mean thirteen listeners on one broadcast channel.
 */
export function useNotificationActivate(): void {
  const openTab = useOpenTab();

  useEffect(() => {
    // No bridge is the browser demo, where there is no OS to notify.
    const bridge = window.hive;
    if (!bridge) return;

    return bridge.notifications.onActivate(({ entityId }) => {
      openTab(entityId);
    });
  }, [openTab]);
}
