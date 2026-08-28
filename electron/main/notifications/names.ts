/**
 * What each session is called, as the rail calls it (HIVE-110).
 *
 * ## Why this is a module of its own
 *
 * It used to be a `Map` inside `createNotifier`, populated from the raw OSC
 * titles on `CH.sessionName`, and used to compose the row's title at raise
 * time. Both halves of that were wrong:
 *
 * - The **raw title** is not the name. The rail's name is that title through
 *   `hiveNameFromTitle` plus rules that live in the store — the pinned-ticket
 *   prefix, HIVE-109's `-2` collision numbering, the stale-title guard,
 *   `/clear` successor targeting. Main reading the title and calling it the
 *   name was a second source of truth that disagreed with the first.
 * - Composing at **raise time** froze a name that arrives later. Since
 *   HIVE-108 a session opens unnamed and titles itself some turns in, so every
 *   row raised before that said `sess-11` for ever.
 *
 * The row no longer needs a name from main at all — it carries
 * `HiveNotification.subject` and the renderer resolves the current name itself.
 * What is left needing one is the **desktop toast**, which is presented once
 * and must say something at that instant. So this holds exactly one fact, from
 * exactly one reporter: `CH.uiSessionName`, the renderer telling main what the
 * rail shows.
 *
 * ## Never pruned
 *
 * An entry is two short strings and the map is bounded by the number of
 * sessions this process has ever spawned — the same argument the notifier's map
 * carried, and still true. Forgetting a name on exit would only risk a toast
 * about a session's last moments naming it by id.
 */

/** Terminal id → the name the rail shows for it. */
export interface SessionNames {
  /** Record what the renderer reports. An empty name is ignored. */
  set(terminalId: string, name: string): void;
  /** The name, or the terminal id when nothing has reported one. */
  get(terminalId: string): string;
}

export function createSessionNames(): SessionNames {
  const names = new Map<string, string>();

  return {
    set(terminalId, name) {
      /*
        An empty name is not a rename, it is the absence of one — and storing it
        would replace a good name with a blank in every toast that follows. The
        renderer never sends one; this is the guard that means main does not
        have to trust that.
      */
      if (name === '') return;
      names.set(terminalId, name);
    },
    /*
      The id is the fallback because it is what the rail itself shows for a
      session that has not been named yet (HIVE-108). A row and a toast about an
      unnamed session say `sess-11`, which is exactly what the user is looking
      at on screen.
    */
    get: (terminalId) => names.get(terminalId) ?? terminalId,
  };
}
