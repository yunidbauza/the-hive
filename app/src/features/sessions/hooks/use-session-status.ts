import { useEffect } from 'react';

import {
  useClearSession,
  useRenameSession,
  useSetSessionStatus,
} from '@stores/hive-store';

/**
 * Keep real sessions' status and name in sync with their processes (story 096,
 * HIVE-61, HIVE-62).
 *
 * Main pushes both here; this is the whole renderer half. Note what does **not**
 * come through: the transcript. That goes straight to xterm through the
 * transport and never touches a store, which is what keeps a build log from
 * re-rendering the shell.
 *
 * ## `waiting` now arrives
 *
 * It did not, and could not, while status was derived from pty output — a TUI
 * that has asked a question and a TUI that is thinking both produce nothing, and
 * the attention model is too important to build on a heuristic that fails
 * silently. HIVE-62 replaced the guess with a report: Claude Code's
 * `PermissionRequest` and `Elicitation` hooks say so directly, and the type main
 * sends now contains `waiting` because a hook is a different observer than a
 * pty. Sessions with no hooks — the user disabled them, the receiver could not
 * bind — still run on the old inference and still never enter `waiting`.
 *
 * ## The name
 *
 * A session's display name comes from the *agent*, not from the app: Claude
 * writes it into the terminal title and rewrites it on `/rename`. So a user who
 * renames a session inside Claude renames its row in the fleet view, which is
 * the only place the two identities were ever visibly different.
 *
 * Mounted once, at the composition root. A per-session subscription would mean
 * thirteen listeners for two broadcast channels.
 */
export function useSessionStatus(): void {
  const setSessionStatus = useSetSessionStatus();
  const renameSession = useRenameSession();
  const clearSession = useClearSession();

  useEffect(() => {
    // No bridge is the browser demo, where every transcript is a recording and
    // no process exists to have a status.
    const bridge = window.hive;
    if (!bridge) return;

    const disposeStatus = bridge.session.onStatus(({ entityId, status }) => {
      setSessionStatus(entityId, status);
    });
    const disposeName = bridge.session.onName(({ entityId, name }) => {
      renameSession(entityId, name);
    });

    /**
     * `/clear` — the conversation ended and the terminal did not.
     *
     * The only structural event on this channel: the others assign a field,
     * this one retires a row and opens its successor. It still belongs here
     * rather than in its own hook, because it arrives on the same bridge from
     * the same observer and a second mount would mean a second listener for
     * one broadcast.
     */
    const disposeCleared = bridge.session.onCleared(({ entityId }) => {
      clearSession(entityId);
    });

    return () => {
      disposeStatus();
      disposeName();
      disposeCleared();
    };
  }, [setSessionStatus, renameSession, clearSession]);
}
