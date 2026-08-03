import { useEffect } from 'react';

import { useSetSessionStatus } from '@stores/hive-store';

/**
 * Keep real sessions' status in sync with their processes (story 096).
 *
 * Main derives `working | idle | done` from pty output and pushes it here; this
 * is the whole renderer half. Note what does **not** come through: the
 * transcript. That goes straight to xterm through the transport and never
 * touches a store, which is what keeps a build log from re-rendering the shell.
 *
 * `waiting` never arrives, and cannot — the type main sends does not contain it.
 * A TUI that has asked a question and a TUI that is thinking both produce no
 * output, so a pty cannot tell them apart, and the app's attention model is too
 * important to build on a heuristic that fails silently. Fixture sessions still
 * show `waiting`; no real one enters it. The gap is real and is named in the
 * story as the next epic's work — a Claude Code notification hook.
 *
 * Mounted once, at the composition root. A per-session subscription would mean
 * thirteen listeners for one broadcast channel.
 */
export function useSessionStatus(): void {
  const setSessionStatus = useSetSessionStatus();

  useEffect(() => {
    // No bridge is the browser demo, where every transcript is a recording and
    // no process exists to have a status.
    const bridge = window.hive;
    if (!bridge) return;

    return bridge.session.onStatus(({ entityId, status }) => {
      setSessionStatus(entityId, status);
    });
  }, [setSessionStatus]);
}
