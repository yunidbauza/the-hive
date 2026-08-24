import type { SessionEffort, SessionModel } from './session-contract';

/**
 * What survives a quit (HIVE-87).
 *
 * The Hive's fleet list lived only in `hive-store`, which boots empty by design,
 * and in `sessions/registry.ts`, which is a `Map` cleared on quit. Closing the
 * app therefore erased every record that any session had ever run — while
 * `claude` itself, reopened in a plain terminal, still lists every past
 * conversation, because it writes each one to disk.
 *
 * This is the file format that closes that gap. Main writes it; the renderer
 * reads it once at boot over `session:history`.
 */

/** The ledger's filename, under `app.getPath('userData')`. */
export const SESSION_HISTORY_FILE = 'sessions.json';

/**
 * How many **ended** records the ledger keeps.
 *
 * The same bet `DONE_CAP` makes in the store, and deliberately the same number:
 * enough to answer "what was I doing yesterday?", few enough that restored rows
 * never bury the live ones in a table whose job is showing what is running.
 *
 * Live records are not counted against it. A fleet of thirteen is thirteen
 * records however full the history is — capping live sessions would mean
 * forgetting a process that still exists, which is a different and much worse
 * bug than forgetting one that does not.
 */
export const HISTORY_CAP = 20;

/**
 * One session, as it survives a restart.
 *
 * Row metadata only. Four fields that look like they belong here do not:
 *
 * - `lines` — the transcript is Claude Code's own file
 *   (`~/.claude/projects/<escaped-cwd>/<uuid>.jsonl`). Copying it here would
 *   grow the ledger without bound to duplicate something already on disk.
 * - `pr` and `cost` — both are dead fields on `Session`. `pr` is only ever
 *   assigned `null`, and `cost` only ever the literals `'$0.02'` and `'$0.00'`;
 *   nothing has ever updated either, and `SessionMetrics` carries no cost at
 *   all. Persisting them would persist placeholders as though they were
 *   measurements. A restored row re-associates with its PR through `branch`,
 *   which is a fact somebody actually observed.
 * - `terminalId` — the pty it names is gone. Worse, a restored successor
 *   pointing at a predecessor that retention has pruned would break
 *   `terminalIdFor` silently, so restored rows stand alone.
 * - `namePinned` — it exists to defend an app-chosen name against Claude's
 *   title stream. An ended row has no title stream to defend against.
 */
export interface SessionRecord {
  /**
   * The entity id, and the only stable key across a restart.
   *
   * Deliberately **not** the registry's `<entityId>.g<N>`, which is minted anew
   * on every restart precisely so stale output from a killed process is
   * droppable (`electron/main/sessions/registry.ts`), and **not** Claude's
   * `--session-id` uuid, which is a different identifier space that happens to
   * share the word "session".
   */
  id: string;
  name?: string;
  /** The project id, as `SpawnRequest.projectId` gave it. */
  project: string;
  ticket?: string;
  /** As observed by `publishBranch`. Absent means nobody ever looked. */
  branch?: string;
  cwd?: string;
  task: string;
  model?: SessionModel;
  effort?: SessionEffort;
  /**
   * The **last known** status, and never an app-close.
   *
   * Typed as `string` rather than `SessionStatus` on purpose: this is a value
   * read back off disk, possibly written by an older build, and the union is a
   * claim the file format cannot make. The renderer validates it at hydrate and
   * drops a record whose status it does not recognise.
   *
   * Nothing records "the app was quit around this session", because nothing can
   * reliably observe it: `runShutdown` starts every hook concurrently rather
   * than in order, so a flush races the pty teardown, and a crash or a SIGKILL
   * writes nothing at all. The renderer infers it instead — a record claiming
   * to be `working` plainly is not — and files it as `done` with
   * `endedBy: 'app-closed'` (HIVE-93). Until that story the inference had a
   * status of its own, `closed`; it does not any more, and this file is
   * unchanged by that, which is the point of keeping the field a `string`.
   */
  status: string;
  /**
   * The uuid pinned as `claude --session-id`.
   *
   * The one field here that buys something the app cannot recompute. It makes
   * the transcript path deterministic, which is what a future
   * `claude --resume` needs — and it cannot be assigned retroactively to a
   * session that has already started, so a record written without one never
   * gets one.
   */
  sessionUuid?: string;
  /**
   * Set when this record's session ended by declaring itself finished
   * (HIVE-93).
   *
   * A one-member union rather than a mirror of the renderer's `endedBy`,
   * because the other two endings cannot be written here and saying so in the
   * type is cheaper than saying so in a comment nobody reads:
   *
   * - **`cleared`** would stamp an ending on a record that carries on. Main
   *   knows only the *terminal*, so after a `/clear` this same record goes on
   *   describing the successor.
   * - **`app-closed`** cannot be observed at all — see the note on `status`.
   *   The renderer infers it at hydrate from a record still claiming to be live.
   *
   * Without it a restored `done` row cannot be told from a cleared one, and was
   * described as "was cleared — its terminal continues as a new session" — the
   * one sentence false for every record that can hold this status, shown beside
   * a Resume button, so the tooltip and the control contradicted each other.
   */
  endedBy?: 'finished';
  createdAt: number;
  /** When the session ended, if it has. What retention sorts on. */
  endedAt?: number;
}

/**
 * What `session:history` actually answers with (HIVE-88).
 *
 * A record, plus one fact the file cannot hold because it is only true of a
 * moment: whether main has a process behind this id **right now**. The ledger
 * records every session begun this run as well as last run's, and a renderer
 * can start while main keeps running — close the window on macOS and reopen it
 * from the dock, reload it, survive a crash — so the list it reads back holds
 * rows that are not history at all. Without the mark, every one of those was
 * restored as `closed` under PREVIOUS RUN, its own hooks then wrote `working`
 * into it, and one agent occupied two rows.
 *
 * Absent means not live, so a list written by an older main reads as all
 * history — which is what it was when only a fresh launch could read it.
 */
export interface SessionHistoryEntry extends SessionRecord {
  live?: true;
  /**
   * This row's conversation can be reopened with `claude --resume` (HIVE-93).
   *
   * The second fact the file cannot hold, and for the same reason `live` cannot:
   * it is only true of a moment. `ledger.resumable()` answers `undefined` for an
   * id **this run started**, because that id's uuid names a conversation that is
   * already open — resuming it would be a second `claude` against one transcript.
   *
   * Sent as a boolean rather than the uuid it derives from, deliberately.
   * Claude's `sessionUuid` has never reached the renderer and should not start:
   * the renderer's job is to decide whether to *offer* Resume, and main owns
   * which conversation that resumes. Passing the uuid would put a second copy of
   * that decision on the other side of the bridge.
   *
   * Absent means not resumable, which is the honest default for a list written
   * by an older main.
   */
  resumable?: true;
}

/**
 * The renderer telling main the issue key a session is being worked for.
 *
 * The one field of a record main cannot author. A session's Jira key is settled
 * in the renderer, after `readJiraIssue` confirms the key names a real issue —
 * a check main deliberately does not make, because main matches a *shape* and
 * `HTTP-404` matches that shape perfectly. Acting on an unconfirmed match would
 * be silently misfiled work, which is the one error the user has no obvious way
 * to notice.
 *
 * Both fields are display strings rather than paths: they are rendered and
 * stored, never resolved, so `assertText` is the right guard for both.
 */
export interface SessionNoteRequest {
  entityId: string;
  ticket: string;
}
