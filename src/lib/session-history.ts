import type {
  SessionNoteRequest,
  SessionPrRequest,
  SessionHistoryEntry,
} from '@shared/session-history-contract';

/**
 * The renderer's half of the ledger (HIVE-87).
 *
 * Deliberately thin, and deliberately free of the store: main owns the file,
 * the record shape and the retention rule, so everything here is one read at
 * boot and one note when the renderer learns something main cannot. Who puts
 * the records into the store is the composition root's business, exactly as it
 * is for `lib/github.ts` and `lib/jira.ts` — every other `lib/` reader is
 * *called by* the store rather than reaching into it, and reversing that here
 * would point the dependency arrow both ways.
 *
 * Shaped after `lib/project-config.ts` otherwise: the same bridge
 * feature-detection, and the same posture that a rejection is a broken channel
 * rather than something the user can fix.
 */

/**
 * Ask main what ran last time.
 *
 * `[]` for the browser demo and for a channel that failed — the two are
 * indistinguishable to every caller, and both mean the same thing on screen:
 * no history, which is the state every first launch is in anyway.
 */
export async function readSessionHistory(): Promise<SessionHistoryEntry[]> {
  const bridge = window.hive;
  /*
    No bridge is the browser demo (`pnpm dev`), not a failure — story 083's rule
    is to feature-detect the bridge and never the user agent.
  */
  if (!bridge) return [];

  try {
    return await bridge.session.history();
  } catch (cause) {
    /*
      Main never rejects this read: it answers from memory and falls back to an
      empty list even when the file is corrupt. A rejection is therefore the
      channel itself failing, which is not something the user can act on and not
      worth degrading the app over.
    */
    console.error('[hive] could not read the session history:', cause);
    return [];
  }
}

/**
 * Tell main which ticket a session is being worked for.
 *
 * The one field of a record main cannot author: a Jira key is only trustworthy
 * once `readJiraIssue` has confirmed it names a real issue, and that check lives
 * on this side because main deliberately matches a *shape* — which `HTTP-404`
 * matches perfectly.
 *
 * Fire and forget. A failure costs a ticket link in next launch's history and
 * nothing in this one, so it is logged rather than surfaced.
 */
export function noteSessionTicket(request: SessionNoteRequest): void {
  const bridge = window.hive;
  if (!bridge) return;

  void bridge.session.note(request).catch((cause: unknown) => {
    console.error('[hive] could not record the session ticket:', cause);
  });
}

/**
 * Tell main which pull request a session produced.
 *
 * The **second** field of a record main cannot author, and it is the renderer's
 * for a different reason from the ticket's: main does not sweep GitHub. The
 * store resolves a row's PR from the live sweep on every tick and calls this
 * only when the answer changes, so a steady fleet under a running poller sends
 * nothing at all.
 *
 * Fire and forget, exactly like {@link noteSessionTicket}. A failure costs a
 * `#123` in next launch's fleet table and nothing in this one.
 */
export function noteSessionPr(request: SessionPrRequest): void {
  const bridge = window.hive;
  if (!bridge) return;

  void bridge.session.pr(request).catch((cause: unknown) => {
    console.error('[hive] could not record the session pull request:', cause);
  });
}
