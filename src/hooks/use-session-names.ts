import { useEffect, useRef } from 'react';

import { useSessionNameReports } from '@stores/hive-store';

/**
 * Tell main what the rail calls each session (HIVE-110).
 *
 * The renderer half of a notification's name, and the mirror of
 * `use-foreground-session`: main owns the notification hub and cannot derive
 * the fact the hub needs. `CH.sessionName` travels the other way and carries
 * the **raw OSC title**; the name on screen is that title through
 * `hiveNameFromTitle` plus rules that exist only in the store — the
 * pinned-ticket prefix, HIVE-109's `-2` collision numbering, the stale-title
 * guard, `/clear` successor targeting. Main reading the title was a second
 * source of truth that disagreed with the first, and the visible cost was a
 * desktop toast naming a session something the rail has never shown.
 *
 * Main's only consumer is the **toast**, which must say something at the
 * instant it is presented. The inbox row needs nothing from here: it carries
 * the terminal id and resolves the name from this same store on every render —
 * see `useDisplayName`.
 *
 * ## Deltas, against what was actually sent
 *
 * The selector already collapses everything that is not a rename, so the effect
 * runs rarely. The ref narrows it further to the session that changed, which is
 * what keeps a fleet of thirteen from sending thirteen messages because one of
 * them was titled. Keyed by terminal, like the payload and like main's map.
 *
 * The first run reports **every** session it can see, and that is the point
 * rather than an accident: main's map is per-process and starts empty, so a
 * session restored from the session history — named before this process
 * existed — is otherwise a name main will never learn. That is the case that
 * produced `sess-11` in a toast about a session the rail was calling
 * something else.
 *
 * Mounted once, at the composition root, like `useSessionStatus`,
 * `useForegroundSession` and `useNotificationStream`. The report is a property
 * of the fleet, not of any component, and there is one fleet.
 */
export function useSessionNames(): void {
  const reports = useSessionNameReports();
  /*
    What main has already been told. A ref rather than state: nothing renders
    from it, and writing it during the effect must not schedule another one.
  */
  const sent = useRef(new Map<string, string>());

  useEffect(() => {
    // No bridge is the browser demo, where there is no main process to tell.
    const bridge = window.hive;
    if (!bridge) return;

    for (const { terminalId, name } of reports) {
      if (sent.current.get(terminalId) === name) continue;
      sent.current.set(terminalId, name);
      bridge.ui.reportSessionName(terminalId, name);
    }
  }, [reports]);
}
