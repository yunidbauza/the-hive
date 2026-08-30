/**
 * The IPC contract — the single source of truth for channel names and payload
 * shapes (story 082).
 *
 * This module is the ONE thing both processes may import, which is what makes
 * the contract a compile-time artifact instead of a convention: a renamed
 * channel or a changed payload is a type error on both sides rather than a
 * runtime silence.
 *
 * It is therefore **types and constants only**. No runtime imports, no Node
 * APIs, no DOM APIs — anything else here would drag main-process code into the
 * renderer bundle, which the ESLint zones exist to prevent.
 *
 * The PTY channels are declared here but **not implemented in this story**.
 * Story 093 owns their handlers and their flow control. This story ships the
 * bridge, its security properties, and `app:info` as the one working channel
 * that proves the whole path.
 */

import type {
  AgentLinesPush,
  AgentNameRequest,
  AgentRenameRequest,
  AgentRunRequest,
  AgentRunResult,
  AgentsSnapshot,
  AgentStatusPush,
  AgentWriteRequest,
  AgentWriteResult,
} from './agent-contract';
import type {
  AddProjectRequest,
  CloneDoneEvent,
  CloneRequest,
  CloneStartResult,
  CommandDiagnostic,
  ConfigSnapshot,
  DiagnoseCommandRequest,
  DiagnoseEnvRequest,
  EnvDiagnostic,
  PathProbe,
  RemoveProjectRequest,
  RenameProjectRequest,
  ReorderProjectsRequest,
  AddJiraCommentRequest,
  ApplyJiraTransitionRequest,
  JiraConversationRequest,
  JiraIssueRequest,
  JiraSearchRequest,
  JiraTransitionsRequest,
  RepointProjectRequest,
  SetJiraRequest,
  SetJiraTokenRequest,
  SetNotificationsRequest,
  SetProjectKeyRequest,
  SetProjectRuntimeRequest,
  SetRuntimeRequest,
} from './config-contract';
import type {
  DirEntry,
  FileContent,
  FsChangedEvent,
  FsRefusal,
  FsResult,
  ReadDirRequest,
  ReadFileRequest,
  RootInfo,
  RootRequest,
  SearchRequest,
  SearchResults,
  WatchRequest,
  WriteFileRequest,
  WriteFileResult,
} from './fs-contract';
import type { GhResult, PrRecord, PrsSnapshot } from './github-contract';
import type {
  JiraComment,
  JiraIdentity,
  JiraIssue,
  JiraLink,
  JiraResult,
  JiraSearchResult,
  JiraStatus,
  JiraTransition,
} from './jira-contract';
import type {
  LedgerAnswerRequest,
  LedgerEntry,
  LedgerPostRequest,
  LedgerReadQuery,
  LedgerResult,
  LedgerSnapshot,
} from './ledger-contract';
import type { SessionMetricsEvent } from './metrics-contract';
import type {
  HiveNotification,
  NotificationAction,
} from './notification-contract';
import type {
  SessionEffort,
  SessionModel,
  SessionBranchEvent,
  SessionClearedEvent,
  SessionFinishedEvent,
  SessionReadyEvent,
  SessionNameEvent,
  SessionStatusEvent,
  SessionTicketIntentEvent,
} from './session-contract';
import type {
  SessionHistoryEntry,
  SessionNoteRequest,
  SessionPrRequest,
} from './session-history-contract';
import type {
  SkillFile,
  SkillNameRequest,
  SkillRenameRequest,
  SkillWriteRequest,
  SkillsSnapshot,
} from './skills-contract';
import type { PickedTheme, SaveThemeRequest } from './theme-contract';
import type { UpdateStatus } from './update-contract';

export const CH = {
  configGet: 'config:get',
  configReload: 'config:reload',
  /** Story 101's three mutating channels. All `invoke` — each needs a result. */
  configChooseDirectory: 'config:choose-directory',
  configAddProject: 'config:add-project',
  configRemoveProject: 'config:remove-project',
  /**
   * Story 103's three mutating channels. All `invoke` — each returns the fresh
   * snapshot, so the renderer never follows a write with a reload.
   */
  configRenameProject: 'config:rename-project',
  configRepointProject: 'config:repoint-project',
  configReorderProjects: 'config:reorder-projects',
  /**
   * HIVE-94's key editor. `invoke` like every other mutating config verb, and
   * for the same reason: it returns the fresh snapshot, and it can be *refused*
   * — a key already taken by another project — which a send could not report.
   */
  configSetProjectKey: 'config:set-project-key',
  /**
   * Story 102's clone verbs.
   *
   * `start` and `cancel` are `invoke` — start needs its pre-flight verdict, and
   * cancel is awaited so the view can disable its own button. `done` is a push:
   * a clone concludes long after the call that started it returned.
   *
   * See `CloneRequest` for why none of them takes a destination path.
   */
  /**
   * Story 104's runtime channels.
   *
   * Two mutating verbs returning `ConfigSnapshot` like every other, plus one
   * read-only diagnostic that writes nothing and so does not go through the
   * write path at all.
   */
  configSetRuntime: 'config:set-runtime',
  configSetProjectRuntime: 'config:set-project-runtime',
  configDiagnoseCommand: 'config:diagnose-command',
  /**
   * Story 108's env diagnostic. Read-only, alongside `configDiagnoseCommand`
   * rather than folded into it: the two answer different questions (where a
   * command was looked for vs. whether a variable survived the shell's rc
   * file) and a project can be diagnosed for either independently.
   */
  configDiagnoseEnv: 'config:diagnose-env',
  /**
   * Story 106's channels.
   *
   * One mutating verb returning `ConfigSnapshot` like every other; one
   * read-only status that takes **no payload at all**, which is its security
   * design rather than an omission — with nothing arriving from the renderer
   * there is no argv to inject into; and one main → renderer event naming the
   * session a clicked notification was about.
   */
  configSetNotifications: 'config:set-notifications',
  /**
   * Story 107's two verbs. Both `invoke`, and both take **no payload at all**.
   *
   * That is the whole security design rather than an omission, and it is the
   * same one story 106's `integrations:status` uses: with nothing arriving from
   * the renderer there is no payload guard to write and nothing to inject into.
   * Main resolves the target from its own `configPath()` in both cases, so a
   * compromised renderer cannot aim either verb at a file main did not choose.
   * The epic's rule is that no verb takes a destination path; taking no
   * argument at all is strictly stronger.
   *
   * `reveal` returns nothing — showing a file in the OS file manager has no
   * verdict to report. `reset` returns the fresh snapshot, like every other
   * mutating verb.
   */
  configReveal: 'config:reveal',
  configReset: 'config:reset',
  integrationsStatus: 'integrations:status',
  /**
   * What the login-shell import did — and nothing about `gh`.
   *
   * Its own verb for the same reason {@link CH.notificationsSupported} is one:
   * {@link CH.integrationsStatus} already carries this field, and that handler
   * **executes `gh`** through `spawnSync`. Settings → Runtime needs the
   * environment and not the binary, so reading it off the integrations verb
   * would spend two synchronous subprocesses — and block main for as long as
   * they take — to hand back a value that was already resolved at boot.
   *
   * `loginEnvStatus()` is a memoised promise started during startup, so this
   * handler is effectively a variable read. No payload, like its neighbours,
   * which is what makes the surface safe rather than merely small.
   */
  integrationsLoginEnv: 'integrations:login-env',
  /**
   * The Jira connection settings (HIVE-67).
   *
   * A `config:` channel rather than a `jira:` one because it writes the config
   * file and returns the fresh snapshot, exactly like every other settings
   * verb. Only the *credential* needs a namespace of its own, because it is the
   * one part that does not live in that file.
   */
  configSetJira: 'config:set-jira',
  /**
   * The Jira credential and the connection test (HIVE-67).
   *
   * Four verbs, and the count is the security design: the renderer may write a
   * token and clear one, and there is **no verb that returns one**. A user who
   * wants to read their token looks at Atlassian, which is correct.
   */
  jiraStatus: 'jira:status',
  jiraSetToken: 'jira:set-token',
  jiraClearToken: 'jira:clear-token',
  jiraTest: 'jira:test',
  /**
   * The Jira read verbs (HIVE-68).
   *
   * Both take a payload, which is what makes them the first Jira channels with
   * anything to guard: a JQL string and an issue key both arrive from the
   * renderer. `jiraSearch`'s query goes into one URL-encoded parameter and is
   * never parsed; `jiraIssue`'s key is matched against a pattern before it
   * reaches a URL path, because that one is interpolated.
   */
  jiraSearch: 'jira:search',
  jiraIssue: 'jira:issue',
  /**
   * Transitions (HIVE-70) — the epic's first **write** to Jira.
   *
   * Two channels rather than one, because reading what is possible and doing
   * one of those things are separate decisions with separate failure modes, and
   * a card has to render the first before it can offer the second.
   */
  jiraTransitions: 'jira:transitions',
  jiraApplyTransition: 'jira:apply-transition',
  /**
   * The conversation and the links (HIVE-71).
   *
   * `jiraAddComment` is the epic's second write, and the only one that carries
   * free text: markdown, converted to ADF and validated in main before
   * anything is sent.
   */
  jiraComments: 'jira:comments',
  jiraLinks: 'jira:links',
  jiraAddComment: 'jira:add-comment',
  /**
   * The pull requests the configured repositories hold.
   *
   * **Takes no payload at all**, which is the security design and not an
   * omission — the same one `integrations:status` uses. This handler executes a
   * binary, and what makes that safe is that nothing from the renderer reaches
   * the argv: the repositories come from the config file, and the GraphQL
   * document is a constant shape whose only inputs are bound variables. A
   * renderer cannot name a repository, a host, or a flag.
   */
  githubPrs: 'github:prs',
  /**
   * Search pull requests — the PRs panel's search row.
   *
   * **The first `github:` channel that takes a payload**, so the paragraph above
   * needs qualifying rather than repeating. Two values reach main: a search
   * term and, optionally, a project id.
   *
   * Neither reaches the argv as a name of anything. The id is looked up in the
   * config main wrote and validated — an id naming no project narrows to
   * nothing and is refused, never widened — and the term travels as a bound
   * GraphQL variable inside a search expression whose `repo:` scope main
   * composed itself. `safeSearchTerm` strips the one character that could add a
   * qualifier there, because a term is data in that little language only by
   * convention.
   *
   * So the invariant is unchanged and the wording is not: a renderer still
   * cannot name a repository, a host, or a flag. What it can now do is say
   * *which of the user's own projects* to look in, and what to look for.
   */
  githubSearchPrs: 'github:search-prs',
  notificationsActivate: 'notifications:activate', // main → renderer
  /**
   * A notification was raised (HIVE-75). main → renderer.
   *
   * Push rather than poll, because the renderer cannot know when a session
   * blocks and a one-second poll would be a timer running for the lifetime of
   * the app to learn nothing almost every time.
   */
  notificationsNew: 'notifications:new', // main → renderer
  /**
   * The buffer, newest first.
   *
   * Hydration exists because the hub outlives the window. Without it a reload —
   * or a devtools refresh — would empty an inbox whose contents main still
   * holds, and drop the unread badge to zero while four sessions sat blocked.
   */
  notificationsList: 'notifications:list',
  /** Mark one read, or all of them when the id is null. */
  notificationsMarkRead: 'notifications:mark-read',
  /**
   * Drop one notification from the hub for good (HIVE-93).
   *
   * Distinct from `mark-read`, which leaves the row in the list. A card the user
   * has *acted on* has served its whole purpose — it navigated them somewhere —
   * and leaving it behind makes the inbox a log to be pruned by hand rather than
   * a queue that drains.
   *
   * It has to reach main because `notifications:list` is what a mounting
   * renderer hydrates from: dropping the row locally would bring it straight
   * back on the next reload, with the hub still holding it.
   *
   * Takes one id and never `null`. "Dismiss everything" is
   * {@link CH.notificationsClear}, a **separate verb** — see the note there for
   * why widening this one would have been the wrong shape.
   */
  notificationsDismiss: 'notifications:dismiss',
  /**
   * Empty the inbox. Renderer → main. Takes no payload.
   *
   * ## Why not `dismiss(null)`
   *
   * `markRead` takes `id | null` and the obvious move was to match it. The
   * guard on `dismiss` argues against it in as many words: `null` is rejected
   * there precisely so that **a caller who loses an argument cannot empty the
   * inbox**, and `parseDismissRequest` exists to hold that line. Widening it
   * would delete the guarantee to save a channel.
   *
   * A verb with no payload keeps it. There is no argument to lose, "clear
   * everything" cannot be reached by accident from a malformed dismissal, and
   * the two gestures stay distinguishable in a log.
   *
   * The distinction is not pedantic: dismissal follows an action on one row,
   * and clearing is the user saying they are done with all of them at once.
   * They are different intentions, and the second one is destructive.
   */
  notificationsClear: 'notifications:clear',
  /**
   * Read-state changed in the hub (HIVE-75). main → renderer.
   *
   * Needed because main can mark a notification read on its own: clicking the
   * **desktop toast** is the user attending to it, and the renderer has no way
   * to observe that. Without this the inbox row stays filled and the unread
   * badge keeps counting a notification the user has already dealt with, until
   * the next window reload silently corrects it.
   */
  notificationsRead: 'notifications:read', // main → renderer
  /**
   * A notification left the buffer, main → renderer (HIVE-81).
   *
   * The mirror of {@link CH.notificationsRead}, and needed for the same reason:
   * main can dismiss on its own. Clicking a **desktop toast** is the user
   * dealing with a notification from another application entirely — they saw
   * it, they acted on it, it opened the session for them — and without this the
   * row sat in the inbox until the next reload quietly removed it.
   *
   * A renderer-initiated dismissal echoes back here, which is harmless:
   * removing a row that is already gone is a no-op, and the renderer does not
   * write it back.
   */
  notificationsDismissed: 'notifications:dismissed',
  /**
   * Whether the OS is actually accepting desktop notifications.
   *
   * Its own verb rather than a field read off {@link CH.integrationsStatus},
   * which already carries both facts — because that handler **executes `gh`**.
   * The Notifications pane has to re-ask while it is open (the refusal is only
   * knowable after a delivery has been attempted and turned down), and asking
   * the integrations handler on a timer would spawn a subprocess every few
   * seconds to learn something that lives in a variable.
   *
   * So the pane that needs polling gets the cheap answer, and the pane that
   * needs `gh` goes on paying for `gh` exactly once when it opens.
   */
  notificationsDelivery: 'notifications:delivery',
  /**
   * Do what a clicked notification says to do.
   *
   * The renderer used to handle a clicked row itself, which worked for exactly
   * one action type — `session`, the only one it can carry out. Everything else
   * a notification can point at is main's: a `url` goes through the external
   * link allowlist, and an update action reaches the updater. Rather than teach
   * the renderer a second way to do each of those, the row hands the action
   * back and main routes it through the *same* code path a clicked desktop
   * toast takes. One router, two entry points — so a toast and a row can never
   * drift into doing different things about the same notification.
   *
   * Safe to expose: the action is validated against the union in
   * `notification-contract.ts` before anything acts on it, and the only member
   * carrying free text is `url`, which `isSafeExternalUrl` already gates.
   */
  notificationsAct: 'notifications:act',
  /**
   * The ledger's four channels (HIVE-111).
   *
   * The renderer is the overmind's only mouth: `ledgerPost` and `ledgerAnswer`
   * carry no `from`, because main supplies {@link OVERMIND} and would overwrite
   * anything sent. A session's own writes arrive on the receiver routes
   * instead, where the `x-hive-session` header names the writer.
   *
   * Read the log — hydration on mount, and any filtered view.
   */
  ledgerList: 'ledger:list',
  /** The overmind writes. `from` is forced to OVERMIND in main. */
  ledgerPost: 'ledger:post',
  /** Close a thread, by canonical id or by short ref. */
  ledgerAnswer: 'ledger:answer',
  /** Push: one entry landed, from any party. main → renderer. */
  ledgerChanged: 'ledger:changed',
  /** What the app knows about a newer version of itself. */
  updatesStatus: 'updates:status',
  /**
   * Look now, from the Settings pane.
   *
   * The same verb the menu item drives, so the pane cannot develop its own idea
   * of what checking means.
   */
  updatesCheck: 'updates:check',
  configCloneStart: 'config:clone-start',
  configCloneCancel: 'config:clone-cancel',
  configCloneDone: 'config:clone-done', // main → renderer
  ptySpawn: 'pty:spawn',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  /**
   * The ack half of the flow-control loop (story 093).
   *
   * Renderer → main, `send` rather than `invoke`: an ack is a report, not a
   * question, and awaiting one would put the main process in the path of the
   * very backpressure it is measuring.
   */
  ptyAck: 'pty:ack',
  ptyData: 'pty:data', // main → renderer, stream
  ptyExit: 'pty:exit', // main → renderer
  /**
   * A session that stopped existing without its process exiting (story 094).
   *
   * Distinct from {@link CH.ptyExit} because the two mean different things to
   * the user and must read differently in the transcript. An exit is the
   * process finishing — there is a code, and it is information. A *lost*
   * session is the host dying underneath a process that may well still have
   * been working: there is no code, nothing was concluded, and the only honest
   * thing to say is that the terminal no longer knows.
   *
   * Story 093 logged these in main and forwarded nothing, because no renderer
   * channel existed. This is that channel.
   */
  ptyLost: 'pty:lost', // main → renderer
  /** Kill, wait for the exit, spawn fresh, bootstrap again (story 096). */
  ptyRestart: 'pty:restart',
  /**
   * What a real session is doing, derived in main (story 096).
   *
   * Derived in main and not the renderer because the input is a firehose: a
   * per-chunk store write would re-render the shell continuously, which is
   * exactly what the store split exists to prevent. One `working`, then one
   * `idle` two seconds after the output stops.
   */
  sessionStatus: 'session:status', // main → renderer
  /**
   * What a session now calls itself (HIVE-61).
   *
   * Separate from `session:status` because the two are independent: a rename is
   * rare and user-driven, a status change is frequent and machine-driven, and
   * folding them together would make every status tick carry a name main did
   * not observe on that tick.
   */
  sessionName: 'session:name', // main → renderer
  /**
   * A session's conversation ended by `/clear`, and its terminal kept running.
   *
   * Separate from `session:status` because the renderer's response is
   * structural, not a field assignment: the row becomes `done` and a successor
   * opens on the same terminal. Sending it as a status would also have to
   * invent a `done` member of `ObservedStatus`, which is the conflation that
   * once made `/clear` lock users out of live sessions.
   */
  sessionCleared: 'session:cleared', // main → renderer
  /**
   * A session declared itself finished with `/done`, and its pty is gone
   * (HIVE-93).
   *
   * Its own channel beside `session:cleared`, and for the same reason: the
   * renderer's response is **structural**. The row ends, no successor is minted
   * — the difference from `/clear` — the centre stage falls back to the
   * orchestrator if this was the tab in front of the user, and the row keeps
   * its conversation so Resume can offer it.
   *
   * Sending it as a status would be the conflation this codebase has already
   * paid for twice: `ObservedStatus` deliberately holds nothing a hook cannot
   * *observe*, and "the work is finished" is a declaration rather than an
   * observation. The status channel would also arrive as `terminated` from
   * `activity.ts` a moment later and overwrite it.
   */
  sessionFinished: 'session:finished', // main → renderer
  /**
   * Where a session is really working, and what is checked out there (HIVE-78).
   *
   * Its own channel for the reason `session:name` has one — a branch changes
   * rarely and only when a human or an agent decides it, while status ticks
   * several times a turn. Folding it into `session:status` would make every tick
   * carry a directory main did not look at on that tick.
   *
   * Unlike the other two it is **observed rather than reported**: nothing tells
   * main the branch, so main reads it with `git rev-parse` in the cwd each hook
   * payload names. See `sessions/git.ts` for why that is cheap enough to do on a
   * hook boundary and nowhere near cheap enough to poll.
   */
  sessionBranch: 'session:branch', // main → renderer
  /**
   * Claude finished starting and the shell's noise is over (HIVE-101).
   *
   * Its own channel rather than a status, for `session:finished`'s reason: this
   * is not something `ObservedStatus` can carry. A booting session is `working`
   * by every pty measure — output is pouring out of it — and that is exactly
   * the reading that made the first seconds of every session look like work.
   *
   * The renderer covers the terminal until this arrives, and lifts the cover on
   * a timeout or a keystroke if it never does. See {@link SessionReadyEvent}.
   */
  sessionReady: 'session:ready', // main → renderer
  /**
   * A prompt named a ticket the user intends to work on (HIVE-78).
   *
   * Carries the key and nothing else — never the prompt it was found in. See
   * {@link SessionTicketIntentEvent}.
   */
  sessionTicketIntent: 'session:ticket-intent', // main → renderer
  /**
   * What a session reports about its own usage (HIVE-79).
   *
   * Its own channel for the reason `session:branch` has one, and more strongly:
   * these numbers arrive from Claude Code's **status line**, on a cadence set by
   * that mechanism rather than by anything the Hive does. Folding them into
   * `session:status` would make every status tick carry a context percentage
   * observed at some other moment.
   *
   * See `metrics-contract.ts` for why the status line is the only source that
   * carries rate limits at all.
   */
  sessionMetrics: 'session:metrics', // main → renderer
  /**
   * The fleet as it was when the app last closed (HIVE-87).
   *
   * **Renderer → main, and the first of its kind in this namespace.** Every
   * other `session:*` entry is a push main makes when it observes something;
   * these two are verbs the page calls. The direction comments above are worth
   * reading as a group for that reason — the namespace is no longer
   * listeners-only, and `BRIDGE_SESSION_KEYS` says so too.
   *
   * Read once, at boot. There is no subscription and no refresh: the file only
   * changes because *this* app wrote to it, so anything it could tell the
   * renderer later, the renderer already knows.
   */
  sessionHistory: 'session:history', // renderer → main, invoke
  /**
   * The one fact about a session that main cannot work out for itself.
   *
   * A session's Jira key is decided in the renderer, after `readJiraIssue`
   * confirms the key names a real issue — a check main deliberately cannot make,
   * because main matches a *shape* and `HTTP-404` passes that shape perfectly.
   * So the renderer tells main, and main writes it down.
   *
   * Same shape of claim as `SpawnRequest.name`: the renderer has a better
   * answer than main can compute, and hands it over rather than main guessing.
   */
  sessionNote: 'session:note', // renderer → main, invoke
  /**
   * The **second** fact about a session that main cannot work out for itself.
   *
   * Which pull request a session produced is an answer only the renderer has:
   * main does not sweep GitHub. A channel of its own rather than a field on
   * `session:note`, for the reason `session:branch` is not a field on
   * `session:status` — one is a user's decision, settled once; this is a
   * by-product of a poller, re-evaluated every minute.
   */
  sessionPr: 'session:pr', // renderer → main, invoke
  /**
   * The project filesystem — the explorer and the editor.
   *
   * Six verbs and one event. None of them takes a path: each names a
   * `projectId` and a project-relative path, and main resolves it against the
   * directory *it* validated when it loaded the config. See `fs-contract.ts`
   * for why that is the whole security design rather than one layer of it.
   *
   * `fsWatch` replaces the single watcher rather than adding one, which is what
   * makes `fsUnwatch` take no payload: there is only ever one thing to stop.
   */
  fsReadDir: 'fs:read-dir',
  /**
   * Which root a read for this project and session resolves under.
   *
   * The one `fs:` verb that **answers** with a path. It takes none — the rule
   * above is intact — and it discloses nothing the renderer does not already
   * hold; what it adds is main's verdict on whether the session's working
   * directory was accepted as a second root. See `fs-contract.ts` → `RootInfo`
   * for the three things that were guessing without it.
   */
  fsRoot: 'fs:root',
  fsReadFile: 'fs:read-file',
  fsWriteFile: 'fs:write-file',
  /**
   * Find a file by name, or a string inside one.
   *
   * The one verb here that *recurses*, and the reason it has to exist in main
   * at all is in `fs-contract.ts`: the tree is lazy, so a renderer-side filter
   * can only see folders someone already opened and would answer "no matches"
   * for a file one collapsed directory away.
   */
  fsSearch: 'fs:search',
  fsWatch: 'fs:watch',
  fsUnwatch: 'fs:unwatch',
  fsChanged: 'fs:changed', // main → renderer
  /**
   * Custom skills (HIVE-96, HIVE-99). Five verbs, and not one of them takes a
   * path.
   *
   * Stricter than the `fs` block above, which has to admit a project-relative
   * path because the explorer navigates a tree. A skill request names a
   * **skill**, and main already knows the one directory skills live in — see
   * `skills-contract.ts` for why that makes traversal unrepresentable rather
   * than merely filtered. `skills:rename` names two of them and still no path.
   *
   * No event channel. A write is request/response and answers with the fresh
   * snapshot, the way the config's mutating verbs do; the Settings pane is the
   * only writer, so there is no second party to notify.
   */
  skillsList: 'skills:list',
  skillsRead: 'skills:read',
  skillsWrite: 'skills:write',
  skillsRemove: 'skills:remove',
  skillsRename: 'skills:rename',
  /**
   * Agent definitions — the same five verbs as `skills`, and one more thing
   * (HIVE-114).
   *
   * The bound is identical: every verb names an **agent**, never a path, and
   * main already knows the one directory agents live in, so traversal is
   * unrepresentable rather than filtered. `agent-contract.ts` carries the
   * grammar those names are checked against.
   *
   * Unlike skills, this block **has** an event channel. Skills have none
   * because the Settings pane is their only writer; an `AGENT.md` is a file
   * the user is invited to write by hand, and the story requires a folder
   * deleted in Finder to leave the list without a restart. That makes main a
   * second writer, and a second writer is exactly what an event channel is
   * for.
   */
  agentsList: 'agents:list',
  agentsRead: 'agents:read',
  agentsWrite: 'agents:write',
  agentsRemove: 'agents:remove',
  agentsRename: 'agents:rename',
  /** The folder changed — on disk or through this pane. Carries no payload. */
  agentsChanged: 'agents:changed',
  /**
   * Wake an agent now, and stop one that is running (HIVE-115).
   *
   * The first two verbs in this group that make the machine *do* something
   * rather than read or write a file, which is why `BRIDGE_AGENTS_KEYS` argues
   * for each one. `run` is bounded the same way the five before it are: it
   * names an agent, never a command line, and main builds the argv from a
   * definition it read itself. Nothing the renderer sends reaches a shell —
   * there is no shell.
   *
   * `kill` exists because a run that has stopped making progress is otherwise
   * unstoppable short of quitting the app: one run per agent at a time means a
   * stuck run blocks every future wake of that agent.
   */
  agentsRun: 'agents:run',
  agentsKill: 'agents:kill',
  /** A run started, ended, or changed the agent's status. */
  agentsStatus: 'agents:status',
  /** A batch of run-log lines. */
  agentsLines: 'agents:lines',
  appInfo: 'app:info',
  /**
   * HIVE-80's two verbs. Neither takes a destination path — the dialog chooses
   * it — so the epic's "no verb takes a destination path" rule still holds by
   * construction.
   */
  themePick: 'theme:pick',
  themeSave: 'theme:save',
  /**
   * Which session's terminal is on the centre stage, renderer → main (HIVE-81).
   *
   * The one fact main cannot derive and the renderer cannot act on. Main owns
   * window focus and owns the notification hub; the renderer owns `activeTab`
   * and `resolveView`. Suppressing a notification about the session the user is
   * already watching needs both halves in one place, and this is the half that
   * has to travel.
   *
   * `send`, not `invoke`: it fires on every tab switch and overlay toggle and
   * has no answer worth waiting for. Ordering on a single channel is already
   * guaranteed, which is what actually matters — a stale id is the one failure
   * mode that would matter, and it cannot happen.
   *
   * Carries a **terminal** id, never a row id. `NotificationAction.session`
   * carries a terminal id too, so main compares like with like and needs no
   * domain knowledge; the renderer maps with `terminalIdFor`. Comparing a row
   * id here would silently never match after a `/clear` — a gate that is a
   * no-op and passes a naive test.
   */
  uiForeground: 'ui:foreground',
  /**
   * What a session is *called*, renderer → main (HIVE-110).
   *
   * The mirror of {@link CH.uiForeground}, and it travels for the same reason:
   * main owns the notification hub and cannot derive the fact the hub needs.
   * `CH.sessionName` goes the other way and carries the **raw OSC title**;
   * the name the rail shows is that title through `hiveNameFromTitle` plus
   * rules that only the store has — the pinned-ticket prefix, HIVE-109's `-2`
   * collision numbering, the stale-title guard, and `/clear` successor
   * targeting. Main reading the raw title was a second source of truth that
   * disagreed with the first.
   *
   * Main's only consumer is the **desktop toast**, which needs a string at the
   * moment it is presented. The inbox row derives the name itself and needs
   * nothing from this channel; see `HiveNotification.subject`.
   *
   * `send`, not `invoke`: it fires when a session renames itself and has no
   * answer worth waiting for. Ordering on a single channel is guaranteed, which
   * is the only property that matters here.
   *
   * Carries a **terminal** id, exactly as `CH.uiForeground` does and for the
   * identical reason — that is the id every notification action already
   * carries, so main compares like with like and needs no domain knowledge.
   */
  uiSessionName: 'ui:session-name',
} as const;

export type Channel = (typeof CH)[keyof typeof CH];

/**
 * The channels main may push to the renderer.
 *
 * A closed set, deliberately. An alternative design — one channel per session
 * (`pty:data:<id>`) — is rejected because it makes the channel set *dynamic*,
 * which is precisely what an allowlist cannot be.
 */
export const EVENT_CHANNELS = [
  CH.ptyData,
  CH.ptyExit,
  CH.ptyLost,
  CH.sessionStatus,
  CH.sessionName,
  CH.sessionCleared,
  CH.sessionFinished,
  CH.sessionReady,
  CH.sessionBranch,
  CH.sessionTicketIntent,
  CH.sessionMetrics,
  CH.configCloneDone,
  CH.notificationsActivate,
  CH.fsChanged,
  CH.ledgerChanged,
  CH.agentsChanged,
  CH.agentsStatus,
  CH.agentsLines,
] as const;
export type EventChannel = (typeof EVENT_CHANNELS)[number];

export interface SpawnRequest {
  sessionId: string;
  projectId: string;
  cols: number;
  rows: number;
  /**
   * The first thing to say to this session, once its TUI is up (story 097).
   *
   * Optional because most spawns have nothing to say — a session opened from
   * the picker starts at a prompt and waits for its user. It is delivered by
   * main's bootstrap rather than by the renderer, which has no signal for "the
   * TUI is ready" and by design cannot have one: `session:status` carries
   * `working | idle | done` and nothing finer.
   */
  task?: string;
  /**
   * What to start `claude` *as* (story 109).
   *
   * Both optional, and absent means "say nothing" rather than "use the
   * default": a spawn that names neither produces the bare command it always
   * did, and `claude` applies whatever the user's own configuration says. That
   * matters for the sessions nobody picked a model for — a fixture opened for
   * the first time, a `spawn` typed into the console — where inventing a flag
   * would silently override a setting the user made outside this app.
   *
   * Unlike {@link SpawnRequest.task} these **are** forwarded on a restart. A
   * task is an instruction the previous generation may already have acted on;
   * a model is a property of the session itself, and restarting a session as a
   * different model than the one its row advertises is not a restart.
   */
  model?: SessionModel;
  effort?: SessionEffort;
  /**
   * What to call the session, when the renderer has a better answer than its
   * id (HIVE-78).
   *
   * Today that is one case: a session started from a ticket card, named after
   * its issue key. Absent everywhere else, and absent means "use the id" —
   * which is what every spawn did before this field existed.
   */
  name?: string;
  /**
   * Pick the conversation up where a previous run left it (HIVE-88).
   *
   * Set by the renderer for exactly one spawn: a row restored under PREVIOUS
   * RUN that the user opens. Main then starts `claude --resume` with the uuid
   * its session history kept for that id, and the row carries on as the
   * session it was rather than as a blank one wearing its name.
   *
   * The renderer says so **explicitly**; main never infers it from "the
   * session history knows this id". A fresh spawn can take an id last run
   * used — the session history's own `begin` exists for that case — and
   * inferring would hand that new session a conversation it was never part
   * of.
   */
  resume?: boolean;
}

export interface WriteRequest {
  sessionId: string;
  data: string;
}

export interface ResizeRequest {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface DataEvent {
  sessionId: string;
  chunk: string;
  /**
   * Monotonic per session (story 093).
   *
   * The renderer asserts monotonicity and, on a gap, writes a notice into the
   * transcript rather than silently rendering a corrupted stream. A terminal
   * that quietly drops a batch shows output that never existed in that order,
   * and the user debugs the wrong thing.
   *
   * The notice itself lives in `src/lib/terminal/pty-transport.ts`, not here.
   * Story 093 declared it in this file as a literal SGR string because no
   * renderer-side consumer existed yet; now that one does, the text is built
   * from `TERM` like every other colour the terminal shows — which is the rule
   * this file was quietly the one exception to.
   */
  seq: number;
}

/**
 * The renderer reporting that it has *parsed* everything up to `seq`.
 *
 * The critical detail of the whole design: this is sent from xterm's
 * `write` callback, **not** on receipt. `xterm.write` is asynchronous and its
 * callback fires once the chunk is in the buffer. Acking on arrival measures
 * the IPC channel and learns nothing about whether the terminal is keeping up,
 * which is the entire question.
 */
export interface AckRequest {
  sessionId: string;
  seq: number;
}

export interface ExitEvent {
  sessionId: string;
  exitCode: number;
  /**
   * The signal that killed the process, as a **number** — `15`, not
   * `'SIGTERM'`.
   *
   * `node-pty` reports the raw signal number and it is carried through
   * unchanged, because main is not the layer that should be picking names for
   * things. The renderer maps it for display (`src/lib/terminal/signals.ts`).
   *
   * **`0` means no signal**, and it is what an ordinary exit reports — the
   * field is far more often zero than absent. A consumer that treats only
   * `undefined` as "not signalled" will describe every clean exit as a
   * termination.
   */
  signal?: number;
}

/**
 * A session whose host died (story 094).
 *
 * `reason` is a closed union rather than a free-text string: it is rendered
 * into a terminal, and a message the renderer cannot exhaustively switch on is
 * a message that eventually reaches the user as raw main-process prose.
 */
export interface SessionLostEvent {
  sessionId: string;
  reason: 'host-crashed';
}

/**
 * Where a GitHub token would come from, if anything asked for one (story 106).
 *
 * Reported, never stored. The PR panel is fixture-backed today — nothing in
 * this app fetches from GitHub — so a token persisted here would be a
 * credential no code reads, sitting in a plaintext file the product actively
 * encourages hand-editing. What is useful *now* is the answer to "which source
 * would be used", which is the thing users get wrong and the same answer the
 * future real-PR story needs.
 */
export type GhTokenSource = 'keyring' | 'env' | 'none';

/** What this machine's `gh` install looks like from here (story 106). */
export interface GhStatus {
  /** An executable `gh` was found on the `PATH` a session would search. */
  installed: boolean;
  /** Absolute path to it, or `null`. This exact path is what gets executed. */
  resolved: string | null;
  /** The `PATH` that was consulted — for a GUI app this is launchd's. */
  path: string;
  /** Every directory looked in, so "not found" can explain itself. */
  probes: PathProbe[];
  /** As reported by `gh --version`, or `null` if it could not be read. */
  version: string | null;
  /** `gh` reports a logged-in account. */
  authenticated: boolean;
  /** The login `gh` reports, or `null`. Never a token, never raw output. */
  account: string | null;
  tokenSource: GhTokenSource;
  /** Which variable supplied it, when `tokenSource` is `env`. */
  envVar: 'GH_TOKEN' | 'GITHUB_TOKEN' | null;
  /**
   * `gh` ran and failed in a way that is not an answer — a timeout, or output
   * that could not be read. Not-installed and not-logged-in are **ordinary
   * answers**, not errors: a settings pane that reports a failure because a
   * tool is missing tells the user the app is broken when the tool is what is
   * missing.
   */
  error: string | null;
}

/**
 * Where the `PATH` this app searches actually came from (HIVE-84).
 *
 * Reported for the reason story 104 reports the `PATH` itself: the difference
 * between launchd's environment and the login shell's is invisible, and a user
 * who cannot see which one is in force cannot tell a broken import from a
 * missing binary. Naming the source turns both into something actionable.
 *
 * **Names, never values.** `varsImported` carries variable *names* only — the
 * same rule `GhStatus` follows for `envVar`, and for the same reason: two of
 * the three importable variables are credentials.
 */
export interface LoginEnvStatus {
  /** Whether the import was attempted at all — `importLoginEnv` in the config. */
  enabled: boolean;
  /** Whether it succeeded and the environment was actually replaced. */
  imported: boolean;
  /** The shell that was run, or `null` when the import was disabled. */
  shell: string | null;
  /** How many `PATH` entries were inherited from the launching process. */
  inheritedEntries: number;
  /**
   * How many the app searches now. Equal to `inheritedEntries` when the import
   * did not happen — the pane renders the pair, so a no-op has to be visible
   * as one rather than as a suspiciously round number.
   */
  effectiveEntries: number;
  /**
   * Which allowlisted variables the login shell supplied that this process did
   * not already have. Names only, in {@link LOGIN_ENV_IMPORT_KEYS} order.
   */
  varsImported: string[];
  /**
   * Why the import did not happen, in one sentence. A failed probe is a failed
   * *observation*, never a configuration error — the inherited environment is
   * kept and the app carries on, exactly as `diagnoseEnv` treats its own
   * failures.
   */
  error: string | null;
}

/**
 * Answer to {@link CH.integrationsStatus}.
 *
 * All three facts in one round trip because the section needs them together on
 * open, and separate verbs would paint the pane in stages.
 */
export interface IntegrationsStatus {
  gh: GhStatus;
  /**
   * Where the `PATH` `gh` was looked for on came from. Adjacent to `gh` rather
   * than in its own verb because it is the *explanation* of the `gh` result —
   * the two are read as one sentence or not at all.
   */
  loginEnv: LoginEnvStatus;
  /**
   * `Notification.isSupported()`. False on a Linux box with no notification
   * daemon, where the switches must be replaced by an explanation rather than
   * left as controls that quietly do nothing.
   */
  notificationsSupported: boolean;
}

/** A clicked notification, naming the session it was about (story 106). */
export interface NotificationActivateEvent {
  /** The *entity* id, matching {@link SessionStatusEvent}. */
  entityId: string;
}

/** Answer to {@link CH.appInfo} — proves the bridge round-trips. */
export interface AppInfo {
  /** The app version, from `package.json` via Electron. */
  version: string;
  /** Electron's runtime versions, for the About box and bug reports. */
  electron: string;
  chrome: string;
  node: string;
  /** `process.platform`, so the renderer can reason about chrome differences. */
  platform: string;
  /**
   * Electron's log directory (story 107).
   *
   * Reported, **not written to**. This app writes no log file — main logs to
   * stdout with a `[hive]` prefix — and the Advanced pane says exactly that
   * next to this path. It lives here rather than behind a verb of its own
   * because `AppInfo` already exists "for the About box and bug reports", and
   * this is the same kind of fact as {@link AppInfo.electron}.
   *
   * A real log file — a sink, rotation, a decision about what every
   * `console.error` in main becomes — is a logging feature that a diagnostics
   * pane would then report on, and it is deliberately out of story 107. A
   * "Reveal logs" button that opened an empty directory while implying the app
   * had written to it would answer the user's question wrongly rather than not
   * answering it, so no such button ships and this stays text.
   */
  logPath: string;
  /**
   * Per-session flow-control counters (story 093).
   *
   * Flow-control bugs are otherwise diagnosed by staring at a slow terminal
   * and guessing. Absent when no session has ever run.
   */
  pty?: PtyDiagnostics[];
}

/** What the diagnostics counter set records for one session. */
export interface PtyDiagnostics {
  sessionId: string;
  /** Bytes received from the pty host. */
  bytesIn: number;
  /** Bytes the renderer has confirmed it parsed. */
  bytesAcked: number;
  /** Bytes sent but not yet acked — the number the water marks compare. */
  unacked: number;
  /** How many times the pty was paused for being too far ahead. */
  pauses: number;
  /** IPC messages sent. `bytesIn / batches` is the coalescing ratio. */
  batches: number;
  /** Messages dropped for an unknown or exited session. */
  dropped: number;
  paused: boolean;
}

/**
 * The shape `contextBridge` exposes as `window.hive`.
 *
 * Declared here so the preload implementation, the renderer's ambient type
 * (`src/types/hive-bridge.d.ts`, story 083) and the bridge's own surface test
 * all agree by construction. Widening the bridge means editing this type,
 * which is exactly the deliberate act the design is trying to force.
 */
export interface HiveBridge {
  appInfo(): Promise<AppInfo>;
  /**
   * The workspace config (stories 090, 101).
   *
   * No longer read-only. Story 090's comment here said there was no `set`
   * "because a settings UI that writes this file is out of scope and a bridge
   * verb that can write to disk is not something to add speculatively". Story
   * 101 is that settings UI: the reasoning was sound and the condition
   * changed, so the comment is rewritten rather than deleted.
   *
   * What bounds the widening, and what a reviewer should check any future verb
   * here against:
   *
   * - The bridge can write to **exactly one file** — the config. No verb
   *   accepts a destination path, and none ever should.
   * - Every path arriving from the renderer is **re-validated in main from
   *   scratch** — expanded, made absolute, `realpath`'d, confirmed to be a
   *   directory — exactly as a path arriving from the file is.
   * - `chooseDirectory` is a UX step, not a capability grant. A renderer that
   *   skips the dialog and posts a path directly gets identical treatment,
   *   because main's validation is the actual gate either way.
   *
   * Every mutating verb returns the fresh snapshot, so the renderer never has
   * to follow a write with a reload and can never render a stale list.
   */
  config: {
    get(): Promise<ConfigSnapshot>;
    reload(): Promise<ConfigSnapshot>;
    /** Native directory dialog, owned by main. Resolves null when cancelled. */
    chooseDirectory(): Promise<string | null>;
    addProject(request: AddProjectRequest): Promise<ConfigSnapshot>;
    removeProject(request: RemoveProjectRequest): Promise<ConfigSnapshot>;
    /** Change a project's display name (story 103). The id is never touched. */
    renameProject(request: RenameProjectRequest): Promise<ConfigSnapshot>;
    /**
     * Change a project's typing alias (HIVE-94). The id is never touched.
     *
     * Refused, with the reason in `snapshot.errors`, when another project in
     * the file already holds the key — checked against the bytes on disk rather
     * than against the caller's snapshot.
     */
    setProjectKey(request: SetProjectKeyRequest): Promise<ConfigSnapshot>;
    /**
     * Point a project at a folder that moved (story 103).
     *
     * The path comes from {@link HiveBridge.config.chooseDirectory}, and main
     * re-validates it from scratch — the dialog is a UX step, not a capability
     * grant.
     */
    repointProject(request: RepointProjectRequest): Promise<ConfigSnapshot>;
    /**
     * Rewrite the whole project order (story 103).
     *
     * Refused unless the ids are a permutation of the file on disk, so an
     * ordering built before a hand edit cannot drop or resurrect a project.
     */
    reorderProjects(request: ReorderProjectsRequest): Promise<ConfigSnapshot>;
    /**
     * Change the top-level shell or agent command (story 104).
     *
     * Only the fields named are touched, so saving one cannot restate the
     * other. Neither can be cleared — there is no lower level to inherit from.
     */
    setRuntime(request: SetRuntimeRequest): Promise<ConfigSnapshot>;
    /**
     * Change one project's overrides (story 104).
     *
     * `null` removes an override so the project inherits the top level again;
     * an absent field is left untouched. Storing `""` instead of removing would
     * spawn a shell named `""`.
     */
    setProjectRuntime(request: SetProjectRuntimeRequest): Promise<ConfigSnapshot>;
    /**
     * Explain where the agent command was looked for (story 104).
     *
     * Read-only. Answers the question the epic actually poses — why `claude`
     * "is installed" and still not found — by reporting the `PATH` a session
     * would really search, which for a GUI app is launchd's, not the login
     * shell's.
     */
    diagnoseCommand(request: DiagnoseCommandRequest): Promise<CommandDiagnostic>;
    /**
     * Explain which configured environment variables survived the shell's
     * rc file (story 108).
     *
     * Read-only, and scoped by project through the same `effectiveRuntime`
     * `diagnoseCommand` uses, so the shell probed is the shell that
     * project's sessions would actually spawn. Only the variables the user
     * configured are reported — never the shell's whole environment.
     */
    diagnoseEnv(request: DiagnoseEnvRequest): Promise<EnvDiagnostic>;
    /**
     * Change which events raise an OS notification (story 106).
     *
     * Only the classes named are touched. Off is a value, not an absence, so
     * there is no clearing case: a preference has no lower level to inherit
     * from.
     */
    setNotifications(request: SetNotificationsRequest): Promise<ConfigSnapshot>;
    /**
     * Change the Jira site and account email (HIVE-67).
     *
     * `null` clears a field; an absent field is untouched. The API token is
     * deliberately **not** here — it is a secret, and it goes through
     * {@link HiveBridge.jira.setToken} into `safeStorage`. Keeping the two on
     * separate verbs is what stops a credential from ever having a path into a
     * file the product invites the user to hand-edit.
     */
    setJira(request: SetJiraRequest): Promise<ConfigSnapshot>;
    /**
     * Show the config file in the OS file manager (story 107).
     *
     * Takes no argument: main reveals its own `configPath()`. *Reveal* rather
     * than *open* — it selects the file in a folder window instead of launching
     * whatever application has claimed `.json`, which on a developer's machine
     * is as likely to be a browser as an editor.
     */
    revealConfig(): Promise<void>;
    /**
     * Put the config file back to the first-run template (story 107).
     *
     * The one write that does not preserve unknown keys or the user's comments,
     * which is what "reset" means. Takes no argument; the confirmation is the
     * renderer's, and main refuses if there is no file to read rather than
     * recreating one.
     */
    resetConfig(): Promise<ConfigSnapshot>;
    /**
     * Start a clone (story 102).
     *
     * Resolves once `git` is running, **not** once it has finished — the
     * terminal streams in between, and completion arrives on
     * {@link HiveBridge.config.onCloneDone}.
     */
    startClone(request: CloneRequest): Promise<CloneStartResult>;
    /** Kill a running clone and remove the directory it had created. */
    cancelClone(): Promise<void>;
    /** Returns its own unsubscribe. Callers MUST invoke it on unmount. */
    onCloneDone(callback: (event: CloneDoneEvent) => void): () => void;
  };
  pty: {
    spawn(request: SpawnRequest): Promise<void>;
    write(request: WriteRequest): void;
    resize(request: ResizeRequest): void;
    kill(sessionId: string): Promise<void>;
    /** Report progress so main can apply backpressure. See {@link AckRequest}. */
    ack(request: AckRequest): void;
    /** Returns its own unsubscribe. Callers MUST invoke it on unmount. */
    onData(callback: (event: DataEvent) => void): () => void;
    onExit(callback: (event: ExitEvent) => void): () => void;
    /** The host died under this session (story 094). See {@link SessionLostEvent}. */
    onLost(callback: (event: SessionLostEvent) => void): () => void;
    /**
     * Kill this session and start a fresh one (story 096).
     *
     * A capability, not a listener — and deliberately explicit. Nothing
     * auto-respawns: the transport keeps its "already requested" flag set even
     * after an exit, so a remount can never restart a finished agent. This verb
     * is the only way back, and it is a thing the user chose to do.
     */
    restart(request: SpawnRequest): Promise<void>;
  };
  /**
   * The project filesystem — the explorer and the editor.
   *
   * **The widest capability in this bridge, and the most narrowly bounded.**
   * Everything above it either writes one file main chose (`config`), talks to
   * one remote host (`jira`), or drives a process the user started (`pty`).
   * This reads and writes arbitrary files — but only inside a directory the
   * user mapped, and only via an id, never a path.
   *
   * What a reviewer should check any future verb here against:
   *
   * - It takes a `projectId` and a **relative** path, or it does not ship. The
   *   moment one accepts an absolute path, the containment argument is over.
   * - Main resolves and `realpath`s before touching anything, and re-checks
   *   containment on the *resolved* path — a symlink inside the project is the
   *   attack the string check alone misses.
   * - A project whose `status` is not `'ok'` is not readable. The config's
   *   verdict is the gate; there is no second opinion here.
   *
   * `writeFile` is present regardless of the editor's read-only preference.
   * That preference lives in `localStorage`, which is writable by exactly the
   * thing a capability check would be defending against — so it gates the UI
   * and containment gates the disk.
   */
  fs: {
    readDir(request: ReadDirRequest): Promise<FsResult<DirEntry[]>>;
    /** Which root this pairing resolves under. See {@link RootInfo}. */
    root(request: RootRequest): Promise<FsResult<RootInfo>>;
    /**
     * Read a file, or say why not.
     *
     * `FsRefusal` is a success at the transport level and a decline at the
     * product level — too large, or binary. It is separate from `FsResult`'s
     * error arm because "there is nothing worth showing you" and "this failed"
     * read differently and the panel renders them differently.
     */
    readFile(
      request: ReadFileRequest,
    ): Promise<FsResult<FileContent | FsRefusal>>;
    /** Write, unless the file moved on. See {@link WriteFileResult}. */
    writeFile(request: WriteFileRequest): Promise<WriteFileResult>;
    /**
     * Walk the project for a name or a string. Bounded in five directions —
     * depth, files, matches, lines per file and wall clock — and it says so:
     * {@link SearchResults.capped} is what the panel renders as "500+".
     */
    search(request: SearchRequest): Promise<FsResult<SearchResults>>;
    /**
     * Watch one project. Replaces the previous watcher rather than adding one.
     *
     * Singular by design: the explorer shows one project at a time, and a
     * watcher set that grows with navigation is a file-descriptor leak with a
     * long fuse.
     */
    watch(request: WatchRequest): Promise<void>;
    unwatch(): Promise<void>;
    /** Returns its own unsubscribe. Callers MUST invoke it on unmount. */
    onChanged(callback: (event: FsChangedEvent) => void): () => void;
  };
  /**
   * The custom skills The Hive injects into the sessions it starts (HIVE-96).
   *
   * Five verbs, none of which names a path. `fs` above must accept a
   * project-relative path and defend containment on the resolved result; here
   * a request names a skill, and `SKILL_NAME_PATTERN` cannot express a
   * separator or a dot segment — so main's `join` is total and there is no
   * second check to forget. `rename` names two skills, which is still no path.
   *
   * Every mutating verb answers with the fresh snapshot rather than `void`, so
   * the pane never has to follow a mutation with a read, and the two can never
   * disagree about what is on disk.
   */
  skills: {
    list(): Promise<SkillsSnapshot>;
    read(request: SkillNameRequest): Promise<SkillFile>;
    /** Write, regenerate the plugin, and answer with the fresh snapshot. */
    write(request: SkillWriteRequest): Promise<SkillsSnapshot>;
    remove(request: SkillNameRequest): Promise<SkillsSnapshot>;
    /**
     * Move a skill's folder (HIVE-99).
     *
     * The verb the renderer could not synthesise: writing the new name and
     * deleting the old one leaves a window in which both exist, and doing it
     * the other way leaves one in which neither does. Main does it in one
     * `rename(2)`, and refuses a `to` that is already taken rather than
     * replacing it.
     */
    rename(request: SkillRenameRequest): Promise<SkillsSnapshot>;
  };
  /**
   * External tooling this app can see but does not own (story 106).
   *
   * Read-only, and `status()` takes no arguments at all. That is the whole
   * security story for a verb that executes a binary: with nothing arriving
   * from the renderer, there is no argv to inject into and nothing to guard.
   */
  integrations: {
    status(): Promise<IntegrationsStatus>;
    /**
     * The environment half alone — see {@link CH.integrationsLoginEnv}. Cheap
     * where `status()` is not, because it never reaches for `gh`.
     */
    loginEnv(): Promise<LoginEnvStatus>;
  };
  /**
   * GitHub, read-only.
   *
   * One verb, no arguments, and both facts are the security design. What a web
   * page can now do that it could not before: learn which pull requests the
   * account behind this machine's `gh` has open in the *configured* project
   * repositories. What it still cannot do: name a repository, name a host,
   * reach a repository the config does not list, or obtain a token — there is
   * no verb for any of it, and the argv `gh` receives contains nothing that
   * arrived over IPC.
   */
  github: {
    prs(): Promise<GhResult<PrsSnapshot>>;
    /**
     * PRs matching `term`, whoever wrote them.
     *
     * `projectId` narrows to one mapped project; omitting it means all of them.
     * There is no third, wider option — see {@link CH.githubSearchPrs}.
     */
    searchPrs(term: string, projectId?: string): Promise<GhResult<PrRecord[]>>;
  };
  /**
   * Jira (HIVE-67).
   *
   * Read the credential *state*, write a token, clear one, and test the
   * connection. **There is no verb that returns a token**, and adding one would
   * be a deliberate widening of what a web page can extract from this machine
   * rather than an incremental convenience.
   *
   * `test` is the only verb here that causes a network request, and it takes no
   * argument: the host comes from the config. That bounds *this* verb, not the
   * renderer — `config.setJira` is how the settings pane sets the site, so the
   * renderer can still change which host the next `test` reaches. It is not a
   * new capability (the same bridge already grants a login shell through
   * `pty.write`), and it is the feature: a user has to be able to type their
   * own site.
   */
  jira: {
    status(): Promise<JiraStatus>;
    setToken(request: SetJiraTokenRequest): Promise<JiraStatus>;
    clearToken(): Promise<JiraStatus>;
    test(): Promise<JiraResult<JiraIdentity>>;
    /**
     * Run a JQL query (HIVE-68).
     *
     * `jql` is optional; absent means the default query. The result carries
     * only mapped, named fields — never a raw Jira payload — and `capped` says
     * when the 200-issue limit stopped paging while Jira still had more.
     */
    search(request: JiraSearchRequest): Promise<JiraResult<JiraSearchResult>>;
    /** Read one issue by key (HIVE-68). The key is pattern-matched in main. */
    issue(request: JiraIssueRequest): Promise<JiraResult<JiraIssue>>;
    /**
     * What this issue can become right now (HIVE-70).
     *
     * Read per issue. Transition ids are per-workflow, so one read's ids mean
     * nothing on another issue and caching them across issues would offer
     * buttons that cannot work.
     */
    transitions(
      request: JiraTransitionsRequest,
    ): Promise<JiraResult<JiraTransition[]>>;
    /**
     * Apply one (HIVE-70) — **the first verb in this bridge that changes
     * anything outside this machine.**
     *
     * What bounds it: the issue key and the transition id are both
     * pattern-matched in main, the id must have come from a `transitions` read
     * for the same issue to be valid at all, and the request is attempted
     * exactly once — never retried, because a transition that may already have
     * applied must not be applied twice.
     *
     * Answers with the re-read issue, so the card cannot show an optimistic
     * guess.
     */
    applyTransition(
      request: ApplyJiraTransitionRequest,
    ): Promise<JiraResult<JiraIssue>>;
    /** An issue's conversation, oldest first (HIVE-71). Rendered, not raw ADF. */
    comments(
      request: JiraConversationRequest,
    ): Promise<JiraResult<JiraComment[]>>;
    /** Remote links and Jira-to-Jira links, merged, with direction (HIVE-71). */
    links(request: JiraConversationRequest): Promise<JiraResult<JiraLink[]>>;
    /**
     * Post a comment written as markdown (HIVE-71).
     *
     * The renderer sends the text; main converts it to ADF and **validates it
     * locally before anything is sent**, because a document Jira rejects comes
     * back as a 400 that does not say which node was wrong.
     */
    addComment(
      request: AddJiraCommentRequest,
    ): Promise<JiraResult<JiraComment>>;
  };
  /** OS notifications raised by main (story 106). */
  notifications: {
    /**
     * A notification was clicked. Returns its own unsubscribe.
     *
     * Main focuses the window itself; this says *which session* the user was
     * answering, because only the renderer knows how to open one.
     */
    onActivate(callback: (event: NotificationActivateEvent) => void): () => void;
    /** A notification was raised (HIVE-75). Push, because the renderer cannot know. */
    onNew(callback: (notification: HiveNotification) => void): () => void;
    /** The hub's buffer, newest first. Hydration on mount, since it outlives the window. */
    list(): Promise<HiveNotification[]>;
    /** Mark one read, or every one when `id` is null. */
    markRead(id: string | null): Promise<void>;
    /**
     * Drop one notification from the hub for good (HIVE-93).
     *
     * What an *acted-on* card does, as opposed to `markRead`, which leaves the
     * row in the list. It goes to main because `list()` is the hydration source:
     * a locally-dropped row returns on the next reload.
     */
    dismiss(id: string): Promise<void>;
    /**
     * Empty the inbox — the Clear all row.
     *
     * No argument, deliberately: see {@link CH.notificationsClear}. The echo
     * arrives on `onDismissed` with a `null` id.
     */
    clear(): Promise<void>;
    /** The hub marked something read — including from a desktop toast click. */
    onRead(callback: (event: NotificationReadEvent) => void): () => void;
    /**
     * A notification left the buffer — including from a desktop toast click
     * (HIVE-81). See {@link CH.notificationsDismissed}.
     */
    onDismissed(callback: (event: NotificationDismissedEvent) => void): () => void;
    /**
     * Whether the OS is accepting desktop notifications, and why not.
     *
     * Cheap by construction — two property reads, no subprocess — because it is
     * the one thing in the settings pane that has to be re-asked on a timer.
     */
    delivery(): Promise<NotificationDeliveryStatus>;
    /**
     * Carry out a notification's action.
     *
     * The renderer still handles `session` itself — only it knows what opening
     * one means — and hands everything else here. See {@link CH.notificationsAct}.
     */
    act(action: NotificationAction): Promise<void>;
  };
  /**
   * The ledger (HIVE-111).
   *
   * The renderer is the **overmind's** mouth and nothing else's: `post` and
   * `answer` carry no `from`, because main supplies {@link OVERMIND} and would
   * overwrite anything sent. A session's own writes arrive on the receiver
   * routes instead, where the header names the writer.
   */
  ledger: {
    list: (query?: LedgerReadQuery) => Promise<LedgerSnapshot>;
    post: (request: Omit<LedgerPostRequest, 'from'>) => Promise<LedgerResult>;
    answer: (request: LedgerAnswerRequest) => Promise<LedgerResult>;
    onChanged: (callback: (entry: LedgerEntry) => void) => () => void;
  };
  /**
   * Agent definitions on disk (HIVE-114).
   *
   * `write` answers with a {@link AgentWriteResult} rather than the fresh
   * snapshot the skills verbs return, because a refusal here has *structure* —
   * a list of problems, each naming the field it belongs to — and the editor
   * renders each one beside the control it names. A snapshot could only say
   * that nothing changed.
   */
  agents: {
    list(): Promise<AgentsSnapshot>;
    /** The raw file, or `null` when there is no such agent. */
    read(request: AgentNameRequest): Promise<string | null>;
    write(request: AgentWriteRequest): Promise<AgentWriteResult>;
    remove(request: AgentNameRequest): Promise<void>;
    rename(request: AgentRenameRequest): Promise<AgentWriteResult>;
    /** The folder changed; re-`list` to see how. */
    onChanged(callback: () => void): () => void;
    /**
     * Wake this agent now (HIVE-115).
     *
     * Answers with a value either way — see {@link AgentRunResult} for why a
     * refusal is not a rejection.
     */
    run(request: AgentRunRequest): Promise<AgentRunResult>;
    /**
     * Stop the run in progress. `false` when there was none, which is not an
     * error: the run may have ended between the row rendering and the click.
     */
    kill(request: AgentNameRequest): Promise<boolean>;
    /** A run started, ended, or changed this agent's status. */
    onStatus(callback: (push: AgentStatusPush) => void): () => void;
    /** Run-log lines, as the process writes them. */
    onLines(callback: (push: AgentLinesPush) => void): () => void;
  };
  /**
   * The app's newer self.
   *
   * A namespace of its own rather than fields on `appInfo`, because `appInfo`
   * is a snapshot of facts that cannot change while the app runs, and this
   * changes four times in the course of one update.
   */
  updates: {
    status(): Promise<UpdateStatus>;
    /** Look now. Reports its own result in a dialog; resolves when done. */
    check(): Promise<void>;
  };
  /** Real session lifecycle, derived in main (story 096). */
  session: {
    onStatus(callback: (event: SessionStatusEvent) => void): () => void;
    /** A session reported a new display name (HIVE-61). */
    onName(callback: (event: SessionNameEvent) => void): () => void;
    /** A session's conversation ended by `/clear`; its terminal did not. */
    onCleared(callback: (event: SessionClearedEvent) => void): () => void;
    /** `/done`: the session finished and its terminal is gone (HIVE-93). */
    onFinished(callback: (event: SessionFinishedEvent) => void): () => void;
    /**
     * Claude is up and the shell's boot output is over (HIVE-101).
     *
     * May fire more than once — `/clear` starts a new Claude session in the
     * same pty — and may never fire at all, if `claude` failed to start. The
     * renderer must not wait on it alone.
     */
    onReady(callback: (event: SessionReadyEvent) => void): () => void;
    /**
     * A session's real working directory and branch, as main observed them
     * (HIVE-78). Replaces the invented `feat/<id>` the store used to assign.
     */
    onBranch(callback: (event: SessionBranchEvent) => void): () => void;
    /**
     * A prompt named a ticket. The **key only** — never the prompt, and never
     * confirmed: the renderer checks it against Jira before acting.
     */
    onTicketIntent(
      callback: (event: SessionTicketIntentEvent) => void,
    ): () => void;
    /**
     * A session reported its context and rate-limit usage (HIVE-79).
     *
     * Every field on the payload is optional and absence is meaningful — see
     * `metrics-contract.ts`. The renderer must not default a missing limit to
     * zero.
     */
    onMetrics(callback: (event: SessionMetricsEvent) => void): () => void;
    /**
     * The fleet as it was when the app last closed (HIVE-87).
     *
     * Read once at boot and merged into the store. Records are the app's own
     * notes about its own rows; `status` is whatever was last observed and is
     * never `closed` — the renderer infers that, because a record claiming to
     * be `working` plainly is not.
     */
    history(): Promise<SessionHistoryEntry[]>;
    /**
     * Tell main the issue key a session is being worked for (HIVE-87).
     *
     * The renderer's job because only the renderer can confirm the key names a
     * real issue. Fire and forget — nothing downstream waits on it, and a
     * failure costs a ticket link in the history and nothing else.
     */
    note(request: SessionNoteRequest): Promise<void>;
    /**
     * Tell main which pull request a session produced.
     *
     * The renderer's job because the renderer is what sweeps GitHub. Sent only
     * when the answer changes, so a steady fleet costs nothing per sweep. Fire
     * and forget, exactly like `note` — a failure costs a `#123` in next
     * launch's fleet table and nothing in this one.
     */
    pr(request: SessionPrRequest): Promise<void>;
  };
  /**
   * Getting a theme file on and off disk (HIVE-80).
   *
   * Two verbs, and neither takes a destination path: the dialog chooses it in
   * both directions, which is what keeps the epic's "no verb takes a
   * destination path" rule true by construction rather than by a check that
   * could be forgotten.
   */
  theme: {
    /** Native open dialog filtered to .json. Resolves null when cancelled. */
    pick(): Promise<PickedTheme | null>;
    /** Native save dialog, then writes. Resolves the path, or null when cancelled. */
    save(request: SaveThemeRequest): Promise<string | null>;
  };
  /**
   * What the renderer is showing (HIVE-81).
   *
   * Its own namespace rather than a verb on `session`, which is documented and
   * asserted as listeners-only. This is the opposite direction, and folding it
   * in would quietly retire a security property `security.spec.ts` argues at
   * length.
   */
  ui: {
    /** Report the terminal on the centre stage, or `null` for none. */
    reportForeground(terminalId: string | null): void;
    /**
     * Report what a session is called, so a desktop toast can say it
     * (HIVE-110). A terminal id, and the name the rail shows for it.
     */
    reportSessionName(terminalId: string, name: string): void;
  };
}

/**
 * At most one IPC message per session per this many milliseconds.
 *
 * Under a frame at 120 Hz, so no perceptible latency is added to interactive
 * typing — the echo of a keystroke still lands in the frame it would have.
 */
export const BATCH_INTERVAL_MS = 8;

/** Flush immediately past this, so a firehose cannot build a huge string. */
export const BATCH_FLUSH_BYTES = 64 * 1024;

/** Unacked bytes above which the pty is paused. */
export const HIGH_WATER_BYTES = 512 * 1024;

/** Unacked bytes below which it is resumed. */
export const LOW_WATER_BYTES = 128 * 1024;

/**
 * At most one resize per session per this many milliseconds.
 *
 * A window drag fires `ResizeObserver` continuously, and every resize is a
 * `SIGWINCH` to a process that redraws on each one.
 */
export const RESIZE_THROTTLE_MS = 50;

/**
 * The exact top-level key set of `window.hive`. The surface test asserts it.
 *
 * Story 106 adds two namespaces, and the alarm firing was the point. What a web
 * page can now do that it could not before: ask what this machine's `gh` looks
 * like (`integrations.status`, no arguments, read-only, no token value ever
 * returned), and hear that a notification was clicked
 * (`notifications.onActivate`, main → renderer only). Neither widens what the
 * renderer can *change*; the one new mutating verb is `config.setNotifications`,
 * which goes through the same guarded write path as every other.
 *
 * HIVE-67 adds `jira`, and it is the first namespace that touches a secret, so
 * the same alarm is worth ringing again. What a web page can now do that it
 * could not before: learn *whether* a Jira credential exists and which source
 * it comes from, store one, clear one, and cause exactly one authenticated
 * request to the configured site. What it still cannot do: read a token back —
 * there is no verb for it — or choose the host, which comes from the config and
 * never from a payload.
 *
 * HIVE-80 adds `theme`. What a web page can now do that it could not before:
 * ask the user, through a native dialog, to pick a `.json` file and read it
 * back (`theme.pick`), and ask the user, through another native dialog, where
 * to write one (`theme.save`). Neither verb takes a path from the renderer —
 * both dialogs choose it — so this does not widen the bridge into a general
 * file picker; it is bounded to the one round trip a theme import or export
 * needs.
 *
 * HIVE-81 adds `ui`, and it is the first namespace whose one verb travels
 * **out of** the renderer with nothing coming back. What a web page can now do
 * that it could not before: tell main which of its own tabs is on the centre
 * stage. It takes no path, names no other window, and reports only an id the
 * renderer already holds — main uses it only to decide whether a notification
 * it was already going to raise should be suppressed.
 *
 * HIVE-96 adds `skills`, and it is the second namespace after `fs` that writes
 * to the disk. What a web page can now do that it could not before: create,
 * rewrite and delete files under `~/.hive/skills` — and **only** there. No verb
 * takes a path; each names a skill, and `SKILL_NAME_PATTERN` admits only
 * `[a-z0-9-]+`, so the directory a request can reach is not a matter of
 * validation but of what the name is able to express. `fs`, by contrast, has to
 * accept a path and defend containment on the resolved result.
 *
 * HIVE-99 adds a fifth verb to that namespace and nothing to this list. It
 * widens what the page may *do* to those files — move one — without widening
 * where it may reach: `rename` names two skills under the same rule, and the
 * argument for it is recorded on {@link BRIDGE_SKILLS_KEYS} rather than here,
 * because it is a change to one namespace and not to the surface.
 *
 * HIVE-111 adds `ledger`. What a web page can now do that it could not before:
 * read the whole correspondence log between every session and the overmind,
 * append to it, and close an open ask — but always **as the overmind**. `post`
 * and `answer` take no `from`; main supplies {@link OVERMIND} and would
 * overwrite anything a caller sent, so this namespace cannot be used to forge
 * another party's words the way a compromised page could try.
 */
export const BRIDGE_KEYS = [
  'agents',
  'appInfo',
  'config',
  'fs',
  'github',
  'integrations',
  'jira',
  'ledger',
  'notifications',
  'pty',
  'session',
  'skills',
  'theme',
  'ui',
  'updates',
] as const;

/**
 * The exact key set of `window.hive.skills` (HIVE-96, HIVE-99).
 *
 * Five, and the count is the security story the way it is for `jira` and
 * `integrations`: two readers and three writers, all five bounded to one
 * directory by the shape of what they accept rather than by a check they
 * perform. A sixth verb here is a change to what the renderer may do to the
 * user's disk, and should be argued for in this comment before it is written.
 *
 * ## The argument for the fifth (HIVE-99)
 *
 * The four above could not express a **rename**, and the renderer's attempt at
 * one was a duplicate: a skill's folder is named from its frontmatter, so
 * editing `name:` and saving wrote a second folder and left the first — valid,
 * listed, and still injected into every new session. One user action, two live
 * commands, and the user had to discover the fork themselves.
 *
 * Synthesising it from the existing verbs cannot be made correct from here.
 * `write` then `remove` leaves a window in which both folders exist; `remove`
 * then `write` leaves one in which neither does. A crash, a refused write, or a
 * spawn landing in that window turns the rename into exactly the duplicate this
 * is meant to end, or into a skill that is simply gone. `rename(2)` has no such
 * window, and only main can call it.
 *
 * What it does **not** widen: `rename` names two skills and no path, so the
 * bound above is unchanged — `SKILL_NAME_PATTERN` on both fields, one directory
 * main chose. It cannot reach a file `remove` could not already reach, and it
 * refuses a `to` that exists rather than replacing it, so it cannot destroy a
 * skill that `remove` was not already able to destroy.
 */
export const BRIDGE_SKILLS_KEYS = [
  'list',
  'read',
  'write',
  'remove',
  'rename',
] as const;

/**
 * The exact key set of `window.hive.agents` (HIVE-114).
 *
 * Five verbs matching {@link BRIDGE_SKILLS_KEYS} one for one, and the same
 * security story: two readers and three writers, all bounded to one directory
 * by the shape of what they accept rather than by a check they perform.
 * `assertAgentName` is what makes that true, and it refuses the reserved names
 * as well as any name that could be a path.
 *
 * The sixth is `onChanged`, and it widens nothing — it is a *listener*, not a
 * verb. It carries no payload at all (the renderer re-`list`s on being poked),
 * so it cannot leak the contents of a definition the renderer could not
 * already have asked for. It exists because main became a second writer the
 * moment the folder was declared hand-editable; see `CH.agentsChanged`.
 *
 * HIVE-115 appends `run`, HIVE-117 `pause`/`resume`. Each of those is a change
 * to what the renderer may make the machine *do*, rather than to what it may
 * read or write, and should be argued for here before it is written.
 *
 * ## The argument for `run` (HIVE-115)
 *
 * This is the first key in the namespace that starts a **process**, so it is
 * the first that has to answer a question the five above never faced: what can
 * a compromised renderer make this machine execute?
 *
 * The answer is *nothing it could not already write to disk*, and the reason is
 * that the payload is {@link AgentRunRequest} — one name, through
 * `assertAgentName`, the identical guard `read` and `remove` pass. No path, no
 * argv, no flag, no environment, and no trigger string: main writes `manual`
 * itself, because a person pressing a button is the only trigger this channel
 * could honestly report. Main then reads the definition off a folder it chose,
 * resolves `claudeCommand` from *its own* config, and builds the argv as an
 * array handed straight to `spawn`. There is no shell anywhere on that path —
 * `claude-path.ts` refuses a command carrying arguments rather than splitting
 * one — so there is no quoting to get wrong and no alias to inherit.
 *
 * What `run` therefore widens is **timing, not reach**. A renderer that can
 * call it can already call `write`, and `write` is the verb that decides what
 * an agent *is*; `run` only decides when the definition the user already
 * approved gets its turn. A page that could write an agent and not run it
 * would be a page that has to wait for HIVE-121's timer to fire — the same
 * process, a few minutes later.
 *
 * ## The argument for `kill`
 *
 * Narrower than `run` by construction: it takes the same validated name and
 * can only ever reach a process **this app started and is still tracking** —
 * the tracker holds the child handle, and an unknown name answers `false`
 * rather than signalling anything. It cannot name a pid.
 *
 * It has to exist. One run per agent at a time (§5) means a run that has
 * stopped making progress blocks every future wake of that agent, and the only
 * other way out is quitting the app — which takes the other twelve sessions
 * with it.
 *
 * ## `onStatus` and `onLines` widen nothing
 *
 * Listeners, like `onChanged`, and the same test applies: can either carry
 * something `list` would not already hand over? `onStatus` carries a subset of
 * what `agents:list` returns for that agent — deliberately *less*, since
 * {@link AgentStatusPush} omits `sessionUuid`. `onLines` carries the agent's
 * own stdout, which is the one genuinely new fact, and it is the fact the
 * feature exists to show: a run nobody can read is a run nobody can trust.
 */
export const BRIDGE_AGENTS_KEYS = [
  'list',
  'read',
  'write',
  'remove',
  'rename',
  'onChanged',
  'run',
  'kill',
  'onStatus',
  'onLines',
] as const;

/** The exact key set of `window.hive.session`. */
export const BRIDGE_SESSION_KEYS = [
  'onStatus',
  'onName',
  'onCleared',
  /**
   * HIVE-93's, and a listener like its neighbours: main → renderer, carrying
   * an entity id and main's own answer to whether that conversation can be
   * resumed — nothing the page can act on beyond drawing it. It sits beside
   * `onCleared`
   * because the two are the same kind of announcement — a session boundary the
   * renderer answers structurally — and reviewing one should mean looking at
   * the other.
   */
  'onFinished',
  /**
   * HIVE-101's, and the narrowest listener on this list: main → renderer,
   * carrying an entity id and **nothing else**, because the fact that Claude
   * started is the whole message.
   *
   * Worth naming here anyway rather than waved through as "another listener".
   * What it exposes to the page is a timing fact about a session the page
   * already has the id of. What it deliberately does *not* carry is the thing
   * its source has and this bridge has never passed: the `SessionStart` hook
   * knows Claude's own session uuid, and that stays in main, where the
   * session history is the only thing that reads it.
   */
  'onReady',
  /**
   * HIVE-78's two. These were listeners, and at the time so was everything in
   * this list — HIVE-87 added the first two verbs, at the bottom.
   * `onTicketIntent` is the one to keep an eye on: its source is the user's
   * prompt, and it carries only a matched issue key out. See `security.spec.ts`
   * for the full argument.
   */
  'onBranch',
  'onTicketIntent',
  /**
   * HIVE-79's, and still a listener: main → renderer, nothing the page can
   * call. What it newly exposes to a renderer is the active session's usage
   * percentages and two reset timestamps — no prompt text, no transcript, and
   * no token value.
   */
  'onMetrics',
  /**
   * HIVE-87's two, and the "listeners only" claim above stops being true here.
   *
   * These are the first verbs in this namespace the page can call. What they
   * widen the bridge by is bounded and worth stating: `history` returns the
   * app's own record of its own rows — ids, project ids, branch names, model
   * and effort, and the uuid it pinned as `--session-id`. No prompt text, no
   * transcript, and nothing read out of `~/.claude`. `note` accepts one issue
   * key for one entity, both `assertText`-guarded, and can do nothing else.
   */
  'history',
  'note',
  /**
   * The third verb, and the same shape of claim as `note`.
   *
   * `pr` accepts one entity id and one `{number, repo, url}` for it, guarded by
   * `parseSessionPrRequest` — the id by `assertId`, the repository by
   * `assertText`, and the URL as an absolute **https** URL, because it is the
   * one field on this bridge that later becomes an `href`. It can do nothing
   * else: main refuses a note for an entity it has no record of, so a sweep
   * cannot invent fleet rows out of GitHub's answer.
   *
   * What it newly exposes to the renderer is nothing — this is renderer → main.
   * What it lets the renderer *store* is a pull request number the renderer
   * already read from GitHub with the user's own `gh` credentials.
   */
  'pr',
] as const;

/** The exact key set of `window.hive.integrations`. */
export const BRIDGE_INTEGRATIONS_KEYS = ['loginEnv', 'status'] as const;

/**
 * The exact key set of `window.hive.fs`.
 *
 * Six, and the shape of the list is the point: **five of them take a
 * `projectId` and a relative path, and none of them takes a path.** A seventh
 * verb that accepted an absolute path would break that sentence, and this list
 * is where a reviewer would see it happen.
 */
export const BRIDGE_FS_KEYS = [
  'readDir',
  /*
    A read, and the only verb here that answers with a path. It grants nothing
    — the renderer already holds the project's path and the session's cwd — and
    what it adds is main's *verdict* on which root a read resolves under, which
    the renderer was previously inferring and getting wrong.
  */
  'root',
  'readFile',
  'writeFile',
  /*
    The recursing one, and the only verb here that reads more than
    it was pointed at. It still takes no path — a `projectId`, a query and a
    mode — so the sentence above holds; what it adds is a *walk*, which is why
    every bound it obeys is declared in `fs-contract.ts` rather than chosen at
    the call site.
  */
  'search',
  'watch',
  'unwatch',
  'onChanged',
] as const;

/**
 * The exact key set of `window.hive.github`.
 *
 * Two. The rule this list enforces is unchanged: **a verb that took a
 * repository name** would turn a bounded read of the user's own configured
 * projects into a general-purpose GitHub client driven by the renderer, and
 * adding one must never be quiet.
 *
 * `searchPrs` is not that verb, which is why it is here rather than refused. It
 * names a *project* — an id main looks up in its own config — and every
 * repository the search reaches is still one the config maps. The widest it
 * goes is all of the user's projects.
 */
export const BRIDGE_GITHUB_KEYS = ['prs', 'searchPrs'] as const;

/**
 * The exact key set of `window.hive.jira` (HIVE-67).
 *
 * Four. A fifth that read the token back would be the one addition this list
 * exists to make impossible to add quietly.
 */
export const BRIDGE_JIRA_KEYS = [
  'status',
  'setToken',
  'clearToken',
  'test',
  // HIVE-68. Two reads. Both return mapped fields only, and neither can name a
  // host — the site still comes from the config, in main.
  'search',
  'issue',
  /**
   * HIVE-70. `transitions` is another read; `applyTransition` is the **first
   * verb anywhere in this bridge that writes to something outside this
   * machine**, and it is the one on this list a reviewer should look hardest
   * at. It cannot name a host, cannot name an arbitrary endpoint, and cannot be
   * retried into applying twice.
   */
  'transitions',
  'applyTransition',
  /**
   * HIVE-71. Two reads and one write. `addComment` carries the only free text
   * that reaches Jira from this app — bounded and control-character-free at the
   * guard, converted in main, and validated against ADF's rules before a
   * request is made.
   */
  'comments',
  'links',
  'addComment',
] as const;

/** The exact key set of `window.hive.notifications`. */
/**
 * What {@link CH.notificationsRead} carries. `null` means "all of them".
 *
 * `unread` because read-state moves in **both** directions now (HIVE-81). It
 * was one-way while only `markRead` published here; the foreground gate adds a
 * row that is raised already-read and later promoted, and the renderer has to
 * be told which way it went. One channel with a direction beats two channels
 * that must be kept in step.
 */
export interface NotificationReadEvent {
  id: string | null;
  unread: boolean;
}

/**
 * What {@link CH.notificationsDismissed} carries.
 *
 * `id` is `null` when the whole buffer went — {@link CH.notificationsClear}, or
 * anything else in main that empties it. Exactly the shape
 * {@link NotificationReadEvent} already uses for "all of them", and for the
 * same reason: one channel with a scope beats two channels that must be kept in
 * step, and every consumer of this event already has to handle a row it has
 * never heard of.
 *
 * The asymmetry with `parseDismissRequest` — which refuses `null` — is
 * deliberate and is not a contradiction. That guard protects main from a
 * *renderer* that lost an argument. This is main telling the renderer what it
 * has already done, where the only thing a lost argument can cost is one
 * stale row until the next hydration.
 */
export interface NotificationDismissedEvent {
  id: string | null;
}

/**
 * What {@link CH.uiForeground} carries. `null` means nothing is on stage —
 * the orchestrator tab, the picker, the settings overlay, or an editor filling
 * the stage.
 */
export interface ForegroundReport {
  terminalId: string | null;
}

/**
 * What {@link CH.uiSessionName} carries — one session, named the way the rail
 * names it (HIVE-110).
 *
 * One session per message rather than the whole fleet in a map, so a rename is
 * a message about the thing that changed. The renderer sends what it has on
 * mount and a delta thereafter; main merges and never forgets, because a name
 * is worth keeping for as long as a notification about that session might be.
 */
export interface SessionNameReport {
  /** The terminal, never the row — see {@link CH.uiSessionName}. */
  terminalId: string;
  /** Non-empty. The rail's own name for it. */
  name: string;
}

/**
 * Answer to {@link CH.notificationsDelivery} — can the OS be reached, and if
 * not, what did it say.
 *
 * The two fields answer genuinely different questions and the app spent a
 * release conflating them. `supported` is what Electron is willing to claim
 * *before* trying; `refused` is what the OS actually did. On macOS the first
 * says `true` and the second has been observed to be `UNErrorDomain error 1`
 * at the same moment, which is exactly the state a single boolean cannot
 * express and the settings pane used to render as "everything is fine".
 */
export interface NotificationDeliveryStatus {
  /** `Notification.isSupported()`. False where there is no daemon at all. */
  supported: boolean;
  /** Why the OS turned the last one down, or `null` if it never has. */
  refused: string | null;
}

export const BRIDGE_NOTIFICATIONS_KEYS = [
  'onActivate',
  'onRead',
  // HIVE-75. `list` and `markRead` are invokes rather than subscriptions: the
  // hub's buffer is the source of truth for read-state, so the renderer asks
  // for it and writes back to it rather than keeping a second copy.
  'onNew',
  'list',
  'markRead',
  // HIVE-93. Deliberately alongside `markRead` rather than folded into it: read
  // and dismissed are different facts about a notification, and only one of them
  // takes the row out of `list`.
  'dismiss',
  // The Inbox's Clear all. A separate verb from `dismiss` rather than
  // `dismiss(null)`, so the id guard that stops a lost argument from emptying
  // the inbox keeps meaning what it says — see `CH.notificationsClear`.
  'clear',
  // HIVE-81. The mirror of `onRead`: main can dismiss on its own — a clicked
  // desktop toast — and the renderer has to be told.
  'onDismissed',
  // The one verb the settings pane may ask on a timer — see
  // `CH.notificationsDelivery` for why it is not a field on integrations status.
  'delivery',
  // The router for everything a row cannot carry out itself — see
  // `CH.notificationsAct`.
  'act',
] as const;

/** The exact key set of `window.hive.ledger` (HIVE-111). */
export const BRIDGE_LEDGER_KEYS = [
  // Hydration on mount, and any filtered view. `to` is added by main, never
  // by this call — see the contract.
  'list',
  /**
   * The overmind writes; the two verbs worth watching here. Neither takes a
   * `from` — widening either signature to accept one would be the change this
   * list exists to catch, because it would let a compromised page speak as
   * any party rather than only as the overmind.
   */
  'post',
  'answer',
  // One entry landed, from any party — see `CH.ledgerChanged`.
  'onChanged',
] as const;

/** The exact key set of `window.hive.updates`. */
export const BRIDGE_UPDATES_KEYS = ['status', 'check'] as const;

/** The exact key set of `window.hive.theme` (HIVE-80). */
export const BRIDGE_THEME_KEYS = ['pick', 'save'] as const;

/** The exact key set of `window.hive.ui` (HIVE-81). */
export const BRIDGE_UI_KEYS = ['reportForeground', 'reportSessionName'] as const;

/** The exact key set of `window.hive.config`. */
export const BRIDGE_CONFIG_KEYS = [
  'get',
  'reload',
  'chooseDirectory',
  'addProject',
  'removeProject',
  // Story 103.
  'renameProject',
  'repointProject',
  'reorderProjects',
  // HIVE-94.
  'setProjectKey',
  // Story 102.
  'startClone',
  'cancelClone',
  'onCloneDone',
  // Story 104.
  'setRuntime',
  'setProjectRuntime',
  'diagnoseCommand',
  // Story 108.
  'diagnoseEnv',
  // Story 106.
  'setNotifications',
  /**
   * Story 107. Two verbs, and what makes widening the surface here acceptable
   * is that **neither takes an argument**: `revealConfig` shows main's own
   * `configPath()` in the file manager, and `resetConfig` rewrites that same
   * file through the one guarded write path. Nothing arrives from the renderer,
   * so there is nothing to guard and no way to aim either at a file main did
   * not choose.
   */
  'revealConfig',
  'resetConfig',
  /**
   * HIVE-67. The Jira site and account email — ordinary settings, written
   * through the same guarded path as every other. The token is not here; it has
   * its own namespace because it is not config.
   */
  'setJira',
] as const;

/** The exact key set of `window.hive.pty`. */
export const BRIDGE_PTY_KEYS = [
  'ack',
  'spawn',
  'write',
  'resize',
  'kill',
  'onData',
  'onExit',
  'onLost',
  'restart',
] as const;
