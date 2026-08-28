import { useEffect } from 'react';

import { readJiraIssue } from '@/lib/jira';

import { READY_SETTLE_MS } from '@features/sessions/hooks/use-session-boot';
import {
  useClearSession,
  useFinishSession,
  useRenameSession,
  useMarkSessionReady,
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
  const finishSession = useFinishSession();
  const setSessionBranch = useSetSessionBranch();
  const markSessionReady = useMarkSessionReady();
  const setSessionTicket = useSetSessionTicket();
  const setSessionMetrics = useSetSessionMetrics();

  useEffect(() => {
    // No bridge is the browser demo, where every transcript is a recording and
    // no process exists to have a status.
    const bridge = window.hive;
    if (!bridge) return;

    const disposeStatus = bridge.session.onStatus(
      ({ entityId, status, idleDetail }) => {
        setSessionStatus(entityId, status, idleDetail);
      },
    );
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

    /**
     * `/done` — the session finished on purpose and its terminal is gone.
     *
     * The second structural event, and the mirror of the one above: `/clear`
     * retires a row and mints a successor on the same pty; this ends a row and
     * mints nothing. Both are here for the same reason — one bridge, one
     * observer, and a second mount would mean a second listener for one
     * broadcast.
     */
    const disposeFinished = bridge.session.onFinished(
      ({ entityId, resumable }) => {
        finishSession(entityId, resumable);
      },
    );

    /**
     * Claude is up — uncover the terminal, a beat later (HIVE-101).
     *
     * The event carries only an entity id, because the fact *is* the message.
     *
     * It can arrive more than once — `/clear` starts a new Claude session in
     * the same pty — and the store's action is idempotent for exactly that. It
     * can also never arrive, which is why nothing about the cover depends on
     * this listener alone; see `useSessionBoot`.
     *
     * ## Why the timer
     *
     * The hook fires when Claude's *process* gets somewhere, not when its TUI
     * has painted, so lifting on arrival flashed the boot output for a frame
     * before Claude's screen replaced it. {@link READY_SETTLE_MS} covers that
     * gap; its doc has the reasoning, including why the keystroke and pointer
     * escapes pointedly do not wait.
     *
     * Tracked and cleared on teardown rather than fired and forgotten: this
     * hook is mounted once at the composition root, so an untracked timer would
     * outlive an unmount and write to the store afterwards. Keyed by entity so
     * a repeat signal for the same session — the `/clear` case above — replaces
     * its own pending lift instead of queueing a second one.
     */
    const settling = new Map<string, ReturnType<typeof setTimeout>>();

    const disposeReady = bridge.session.onReady(({ entityId }) => {
      const pending = settling.get(entityId);
      if (pending !== undefined) clearTimeout(pending);
      settling.set(
        entityId,
        setTimeout(() => {
          settling.delete(entityId);
          markSessionReady(entityId);
        }, READY_SETTLE_MS),
      );
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
      ({ entityId, keys, source }) => {
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
          for (const key of keys) {
            const result = await readJiraIssue({ key });
            if (!live) return;
            /*
              A `null` is the bridge failing and an `ok: false` is Jira refusing
              or not finding it. Neither is grounds for associating anything —
              but neither is grounds for giving up on the *other* candidates
              either, which is why this continues rather than returns.
            */
            if (result === null || !result.ok) continue;

            /*
              And that tells main, so the link survives a quit (HIVE-87) — the
              action makes the note itself now (HIVE-107), because the name it
              pins has to go with the key and this side never sees it. This is
              still the only moment main *can* be told: it matched the shape but
              deliberately does not decide whether the key is real, and the
              confirmation that it is exists only here, one line above.
            */
            /**
             * A branch-inferred key associates the session and stops there.
             *
             * The rename is the app answering something the user *said*, and a
             * branch is not something they said — it is something main read off
             * a checkout they may have made days ago. Renaming on it would take
             * a row the user has been reading all afternoon, under a title
             * Claude chose for the conversation actually in it (HIVE-108), and
             * overwrite it because of a `git checkout`. The card does not need
             * that: `facetsForTicket` matches on `ticket` alone, so the session
             * appears under its ticket either way.
             */
            setSessionTicket(entityId, result.value.key, { source });
            return;
          }
        })();
      },
    );

    return () => {
      live = false;
      disposeStatus();
      disposeName();
      disposeCleared();
      disposeFinished();
      disposeReady();
      for (const timer of settling.values()) clearTimeout(timer);
      settling.clear();
      disposeBranch();
      disposeTicketIntent();
      disposeMetrics();
    };
  }, [
    setSessionStatus,
    renameSession,
    clearSession,
    finishSession,
    setSessionBranch,
    markSessionReady,
    setSessionTicket,
    setSessionMetrics,
  ]);
}
