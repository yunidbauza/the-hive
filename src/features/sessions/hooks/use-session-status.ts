import { useEffect } from 'react';

import { readJiraIssue } from '@/lib/jira';

import {
  useClearSession,
  useRenameSession,
  useSetSessionBranch,
  useSetSessionMetrics,
  useSetSessionStatus,
  useSetSessionTicket,
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
 * ## The branch, and the ticket (HIVE-78)
 *
 * Two more channels, and they are the first here that are **observed rather
 * than reported**. Nothing tells main what branch a session is on, so it looks
 * — `git rev-parse` in the directory each hook payload names — and pushes the
 * answer only when it changed. That replaces `spawnSession`'s old
 * `` `feat/${id}` ``, which named a branch nothing had created.
 *
 * The ticket channel is the odd one out in this file: it is the only listener
 * that does **not** immediately write to the store. Main sends a key-*shaped*
 * string it found in a prompt, and `HTTP-404` is key-shaped. So the key is put
 * to Jira first, and only an issue that actually exists renames anything.
 *
 * Mounted once, at the composition root. A per-session subscription would mean
 * thirteen listeners for five broadcast channels.
 */
export function useSessionStatus(): void {
  const setSessionStatus = useSetSessionStatus();
  const renameSession = useRenameSession();
  const clearSession = useClearSession();
  const setSessionBranch = useSetSessionBranch();
  const setSessionTicket = useSetSessionTicket();
  const setSessionMetrics = useSetSessionMetrics();

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

    const disposeBranch = bridge.session.onBranch(({ entityId, branch, cwd }) => {
      setSessionBranch(entityId, branch, cwd);
    });

    /**
     * Usage, straight through (HIVE-79).
     *
     * The plainest listener in this file, and deliberately: the payload is
     * already the store's shape, every field is optional in both, and the store
     * merges rather than replaces so a partial report cannot erase a number it
     * simply did not carry. Nothing is confirmed or defaulted on the way — see
     * `metrics-contract.ts` for why a missing rate limit must stay missing.
     */
    const disposeMetrics = bridge.session.onMetrics(({ entityId, metrics }) => {
      setSessionMetrics(entityId, metrics);
    });

    /**
     * Cancelled on unmount, so a late Jira answer cannot write to a store the
     * app has finished with — and, more usefully, cannot rename a session in a
     * test that has already torn down.
     */
    let live = true;

    const disposeTicketIntent = bridge.session.onTicketIntent(
      ({ entityId, key }) => {
        void (async () => {
          /**
           * **Confirmed before it is acted on.**
           *
           * Main matched a shape, and a shape is not an issue: `HTTP-404` and
           * `UTF-8`-adjacent strings pass it perfectly. Asking Jira is the only
           * check that actually distinguishes them, and it is cheap — one read,
           * once, on a prompt that contained work intent.
           *
           * Anything other than a confirmed issue does nothing at all. A `null`
           * is the bridge failing, an `ok: false` is Jira refusing or not
           * finding it, and neither is grounds for renaming a session — a wrong
           * guess here is silently misfiled work, which the user has no obvious
           * way to notice.
           */
          const result = await readJiraIssue({ key });
          if (!live || result === null || !result.ok) return;
          setSessionTicket(entityId, result.value.key);
        })();
      },
    );

    return () => {
      live = false;
      disposeStatus();
      disposeName();
      disposeCleared();
      disposeBranch();
      disposeTicketIntent();
      disposeMetrics();
    };
  }, [
    setSessionStatus,
    renameSession,
    clearSession,
    setSessionBranch,
    setSessionTicket,
    setSessionMetrics,
  ]);
}
