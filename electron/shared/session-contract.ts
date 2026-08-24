import type {
  HookNotificationType,
  IdleDetail,
  ObservedStatus,
  StatusHookEvent,
} from './hook-contract';

/**
 * The session lifecycle contract (story 096).
 *
 * Separate from `ipc-contract.ts` for the same reason that file is separate
 * from `pty-host-protocol.ts`: these describe *sessions*, which are a main-side
 * concept built on top of PTYs, and the two should be free to change
 * independently. A pty knows nothing about projects, bootstraps or attention.
 *
 * Types and constants only — both processes import it.
 */

/**
 * What main can honestly derive about a session from its pty.
 *
 * Deliberately **not** the full `SessionStatus`, and the two omissions are for
 * opposite reasons.
 *
 * `waiting` — blocked on the user — is missing because it is not derivable here:
 * a TUI that has asked a question and a TUI that is thinking both produce no
 * output. Distinguishing them by scraping rendered text would be a heuristic
 * that fails silently, and the app's whole attention model is built on this
 * field.
 *
 * `done` is missing because it is not this module's to *derive* (story 108).
 * Main sees a process exit and nothing more, which is `terminated`; whether the
 * *work* was finished is a judgement no pty can make. Reporting an exit as
 * `done`, which is what shipped before, quietly asserted that judgement on every
 * `/exit`.
 *
 * HIVE-93 gave the judgement a speaker without giving it to this module, or to
 * the status channel at all: `/done` declares it and `SessionFinishedEvent`
 * carries it, on its own channel beside `session:cleared`. A deliberate `/exit`
 * is still `terminated`, because both endings write the *same bytes* into the
 * same pty — the app's own `/exit\r` and the user's are indistinguishable here
 * — and the only thing that tells them apart is whether a declaration arrived
 * first. Which is exactly story 108's point, now with a mechanism.
 *
 * The type is what enforces both. A status main could never honestly produce
 * cannot be produced by a later edit either.
 */
export type DerivedStatus = 'working' | 'idle' | 'terminated';


/**
 * Main telling the renderer what a real session is doing.
 *
 * Carries {@link ObservedStatus}, which is wider than {@link DerivedStatus} by
 * one member (HIVE-62). The narrower type still governs `activity.ts`, whose
 * reasoning about what a *pty* can show is unchanged; `waiting` reaches this
 * event only from a Claude Code hook, which is a different observer with a
 * vantage point a pty does not have.
 *
 * No `done` member, and none is coming: a finish is announced on
 * {@link SessionFinishedEvent}'s own channel, because the renderer's response to
 * it is structural rather than a field assignment.
 */
export interface SessionStatusEvent {
  /** The *entity* id — the renderer never sees a pty session id. */
  entityId: string;
  status: ObservedStatus;
  /**
   * The hook that produced this status, when one did (HIVE-75).
   *
   * The renderer ignores it; the notification hub is the only reader. It is
   * here rather than on a channel of its own because `waiting` is reachable
   * from **two** hooks that mean different things to the user —
   * `PermissionRequest` wants a yes, `Elicitation` wants a sentence — and the
   * status deliberately collapses them. Without this field the inbox could only
   * offer one row for both, which is a row that is wrong half the time.
   *
   * Optional, and absent for every pty-derived status, because `activity.ts`
   * has no hook to name. Absent is the honest answer there, not a default.
   */
  event?: StatusHookEvent;
  /**
   * Which kind of interruption, when `event` is `Notification`.
   *
   * The third hook that can produce `waiting`, and the one that needed a second
   * field: `Notification` fires both for a permission prompt — six seconds
   * behind the `PermissionRequest` that already announced it — and for
   * "Claude is waiting for your input", sixty seconds after a turn ended with
   * nobody typing. One raises a row, the other must not raise a second, and the
   * status alone cannot tell them apart.
   */
  notificationType?: HookNotificationType;
  /**
   * What is still running while the main agent is not (HIVE-83).
   *
   * Only ever set alongside `idle`. Orthogonal to the status rather than a
   * sixth member of it, so `SessionStatus` keeps its five values and the dot
   * keeps its five colours.
   */
  idleDetail?: IdleDetail;
  /**
   * The tool named by the event that produced this status, when there was one
   * (HIVE-83).
   *
   * The receiver forwards it on every `PreToolUse` and `PostToolUse` too, not
   * only `PermissionRequest` — it is whatever `tool_name` the hook payload
   * carried. The renderer ignores it, same as `event` — the notification hub
   * is the only reader, and only cares about the `PermissionRequest` case: it
   * is what lets the hub tell `AskUserQuestion` (a real question) apart from
   * any other tool waiting on a yes, now that both raise the same
   * `session.blocked` kind and the row's copy is what carries the difference.
   */
  toolName?: string;
}

/**
 * What a session may be named on the command line (HIVE-61).
 *
 * `claude --name <name>` is interpolated into a string a login shell parses, and
 * unlike `--model` and `--effort` a name has **no closed list** behind it — the
 * argument `bootstrap.ts` uses to justify not quoting those two does not reach
 * this one. So the vocabulary is restricted here instead, to characters no shell
 * assigns meaning to: no space, quote, backtick, `$`, `;`, `&`, `|`, `<`, `>`,
 * `(`, `)`, `\` or newline survives this pattern.
 *
 * That is deliberately narrower than the names Claude Code itself accepts. A
 * session *renamed inside Claude* to "fix the login bug" is read back through
 * the terminal title, never written to a command line, and is not filtered by
 * this — see {@link SessionNameEvent}. This pattern governs only what the Hive
 * is willing to **send**, which is its own generated ids.
 */
export const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * The longest name worth sending.
 *
 * Claude renders the name into a terminal title and its prompt box; past this
 * it is truncated for display anyway, and a long argument on the bootstrap line
 * only makes the command harder to read when a session fails to start.
 */
export const SESSION_NAME_MAX = 64;

/**
 * The longest name the app will *display*.
 *
 * Separate from {@link SESSION_NAME_MAX}, which governs what may be **sent**.
 * A name read back off a terminal title is not filtered — that is deliberate,
 * so a sentence typed into `/rename` survives — but it is not unbounded either:
 * the title reader's own limit is 2048 characters, which bounds memory rather
 * than what belongs in a session rail. Anything longer is ignored rather than
 * truncated, because a name cut mid-word is a worse label than the id.
 */
export const SESSION_NAME_DISPLAY_MAX = 120;

/** Whether a name may be sent as `--name` on the bootstrap command line. */
export const isSendableSessionName = (name: string): boolean =>
  name.length > 0 && name.length <= SESSION_NAME_MAX && SESSION_NAME_PATTERN.test(name);

/**
 * Main telling the renderer what a session now calls itself (HIVE-61).
 *
 * The name arrives from the *agent*, not from the app: Claude Code writes its
 * display name into the pty as an OSC 0 terminal-title sequence, and re-writes
 * it whenever `/rename` changes it. So this event is the answer to "what does
 * this session think it is?", which is not something the Hive can know from the
 * id it generated.
 *
 * Separate from {@link SessionStatusEvent} rather than a field on it: a rename
 * and a status change are independent, arrive at completely different rates,
 * and a combined event would force every status tick to carry a name it did not
 * observe.
 */
export interface SessionNameEvent {
  entityId: string;
  /** Already stripped of the leading activity glyph. Never empty. */
  name: string;
}

/**
 * Where a session's agent is actually working, and what branch is checked out
 * there (HIVE-78).
 *
 * ## Why this exists at all
 *
 * `spawnSession` used to assign `` `feat/${id}` `` and nothing ever created that
 * branch. The meta bar and the fleet table read `feat/sess-01` off a session
 * sitting on `main`, and kept reading it after the agent moved into a worktree.
 * It was not a stale value — it was never true. `docs/branch-sync-note.md`
 * records the full diagnosis; this event is the fix it asked for.
 *
 * ## Why `cwd` rides along rather than travelling separately
 *
 * The two are observed **in the same instant from the same hook payload**, and a
 * branch without the directory it was read in is not checkable by anything
 * downstream. That is the opposite of the `status`/`name` split, where the
 * argument for separate channels is that the two are independent and arrive at
 * wildly different rates. These are one observation.
 *
 * The renderer needs both: `branch` for the three places that render it, `cwd`
 * for the explorer, which re-roots at the session's real working directory once
 * it is a worktree rather than the mapped project root.
 *
 * ## Why `branch` may be null
 *
 * A cwd that is not inside a git work tree — a session opened on a plain
 * directory, or one whose repository has been moved out from under it — has no
 * branch, and neither does a detached HEAD. `null` says that; it renders as an
 * em dash. Inventing a name here is the exact defect this event was added to
 * remove.
 */
export interface SessionBranchEvent {
  entityId: string;
  /** The checked-out branch, or `null` for no work tree and for detached HEAD. */
  branch: string | null;
  /** The absolute directory the branch was read in. */
  cwd: string;
}

/**
 * The user told their agent, in prose, which ticket they are working on
 * (HIVE-78).
 *
 * Emitted from a `UserPromptSubmit` hook whose prompt names an issue key with
 * work intent around it — "work on ABC-123", "start ABC-123", or a prompt that
 * is essentially just the key. `hooks/ticket-intent.ts` owns that judgement.
 *
 * ## The prompt itself never travels
 *
 * **Only the key crosses this channel.** The user's prompt is read inside the
 * receiver, matched, and dropped; nothing logs it and nothing sends it. That is
 * a deliberate limit on what a status-reporting side channel is allowed to carry
 * — the receiver exists to keep a status dot honest, and a design in which it
 * quietly forwarded everything typed into every session would be a different and
 * much larger thing.
 *
 * ## Why main does not decide whether the key is real
 *
 * A key-shaped string is not an issue. `HTTP-404` matches the shape perfectly.
 * Confirming it means asking Jira, and the renderer is where the Jira bridge and
 * the already-loaded ticket list live — so main reports *a candidate* and the
 * renderer confirms it before anything is renamed or associated.
 */
export interface SessionTicketIntentEvent {
  entityId: string;
  /** A key-shaped candidate. Unconfirmed — the renderer checks it against Jira. */
  key: string;
}

/**
 * The conversation in this session's terminal ended, and a new one began in it.
 *
 * Emitted only for `SessionEnd{reason:'clear'}` — `//clear` in Claude Code.
 * Every other reason means the process is going away, which the pty observes and
 * reports as `terminated`.
 *
 * Its own event rather than a `SessionStatusEvent` carrying `done`, for the same
 * reason `SessionNameEvent` is separate: this is not a status tick. It is a
 * *boundary*, and the renderer's response is structural — retire the row and
 * open a successor on the same terminal — rather than a field assignment.
 *
 * Carries only the entity. The terminal is still running and still bound to the
 * same pty; what the renderer needs to know is which row just became history,
 * and it mints the successor itself because ids are its to allocate.
 */
export interface SessionClearedEvent {
  entityId: string;
}

/**
 * A session finished on purpose and its terminal is gone (HIVE-93).
 *
 * The sibling of {@link SessionClearedEvent}, and the pair is worth reading
 * together because they are the two *deliberate* endings and they differ in
 * every consequence:
 *
 * ```
 * /clear   row retired, successor minted, pty alive,  uuid dropped  -> no Resume
 * /done    row ends,    no successor,     pty gone,   uuid kept     -> Resume
 * ```
 *
 * Carries only the entity, like its sibling. Everything else the renderer needs
 * it already knows or owns: which row this is, whether that row is the tab in
 * front of the user, and how to draw an ended one.
 *
 * Emitted **instead of** a `terminated` status, not alongside one. The pty exit
 * that follows `/exit` is real and `activity.ts` observes it, but reporting it
 * would overwrite the ending the user actually asked for with the mechanism
 * that delivered it.
 */
export interface SessionFinishedEvent {
  entityId: string;
  /**
   * Whether this conversation can be reopened — **main's answer, not a guess**.
   *
   * `/done` normally keeps its uuid where `/clear` drops it, which is what
   * makes a finished session resumable. But "normally" is not "always": a
   * terminal that was cleared and then finished has had its uuid withdrawn and
   * cannot get another, because the only hook carrying the successor's id never
   * reaches the receiver. Inferring resumability from the fact of a finish
   * would offer Resume on exactly that row and start a **brand-new**
   * conversation under the promise of continuing the old one.
   *
   * So the ledger is asked, here, where it can be. See `Session.resumable` in
   * `src/types/entity.ts`, whose own contract says this must not be derived.
   */
  resumable: boolean;
}

/**
 * The model and thinking effort a session may be started with (story 109).
 *
 * **Closed sets, and they live here rather than in `src/types/entity.ts`
 * because they are now wire values.** These two strings are the only thing the
 * renderer contributes to a command line the main process assembles and writes
 * into a shell — so the boundary that validates them has to be able to name
 * every acceptable value, and `electron/shared/**` is the only module both
 * processes can read. `src/types/entity.ts` aliases these rather than declaring
 * its own copy: a picker offering a model the guard rejects is a session that
 * fails to start for a reason nobody can see from either side.
 *
 * The values are **passed to `claude` verbatim** — `--model opus`,
 * `--effort high` — which is why they are spelled exactly as the CLI spells
 * them. That is a real coupling and it is deliberate: a translation table would
 * be a second place to get this wrong, and the vocabularies already agree.
 *
 * `claude --effort` also accepts `xhigh`, which the picker does not offer. The
 * omission is the picker's to fix if it ever wants it; a value main would
 * accept but nothing can send costs nothing.
 */
export const SESSION_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export type SessionModel = (typeof SESSION_MODELS)[number];

export const SESSION_EFFORTS = ['low', 'medium', 'high', 'max'] as const;
export type SessionEffort = (typeof SESSION_EFFORTS)[number];

/**
 * Which way round a session's own UI is painted.
 *
 * A wire value for the same reason `SessionModel` is one: the renderer owns the
 * app's theme — it lives in `appearance-store`, in `localStorage`, where main
 * cannot see it — and main owns the settings file `claude` reads at startup. So
 * the theme has to cross, and the boundary that validates it has to be able to
 * name every acceptable value.
 *
 * Deliberately **not** the app's own theme type. `appearance-store` is free to
 * grow a third option, a system-follows mode, or a named palette; this list is
 * the two things Claude Code's `theme` setting is being told, and the mapping
 * between them belongs to whoever spawns, not to this contract. It is passed
 * to `claude` verbatim through its settings file, so the spellings are its.
 */
export const SESSION_THEMES = ['dark', 'light'] as const;
export type SessionTheme = (typeof SESSION_THEMES)[number];

/** Silence for this long means idle. */
export const ACTIVITY_IDLE_MS = 2_000;

/**
 * How long to wait after the shell's first output before writing the bootstrap.
 *
 * A prompt is not the end of a shell's startup — profile scripts print, then
 * the prompt draws, then readline installs its handlers. Writing into that
 * window lands characters in a buffer the shell may discard, leaving a session
 * sitting at a bare prompt having silently swallowed the command.
 */
export const BOOTSTRAP_DEBOUNCE_MS = 150;

/**
 * How long to wait for *any* output before writing the bootstrap regardless.
 *
 * A genuinely silent startup is unusual but real — a bare `sh` with no profile
 * and `PS1` unset prints nothing at all. Waiting forever would leave the session
 * permanently empty, so the bootstrap goes in anyway and the fact is recorded.
 */
export const BOOTSTRAP_FALLBACK_MS = 5_000;

/**
 * How long to wait between writing a stage's text and writing its `\r` (HIVE-63).
 *
 * The bug this fixes: a stage used to go in as a **single** write,
 * `` `${command}\r` ``, and Claude Code's TUI applies paste detection to input
 * that arrives in one fast chunk. Above a size threshold the whole write is
 * treated as a paste, and the trailing carriage return is inserted as a literal
 * newline inside the input box instead of submitting it. The session then sits
 * there looking idle, holding a task nobody can see it was given.
 *
 * Stage one never hit it — `claude --model … && exit` is short and fixed. Stage
 * two writes the **task**, which is arbitrary-length user text, so the defect
 * only ever appeared on the stage where it is hardest to notice.
 *
 * The boundary was measured against `claude` 2.1.222 by bisection, submitting a
 * single write and watching the title glyph for the spinner that means the turn
 * started: **submits at ≤62 characters, swallowed at ≥65** — a 64-byte chunk
 * heuristic. The number is recorded because it explains the bug, not because
 * anything depends on it: the fix splits *every* stage's write rather than
 * branching on a length, since a threshold read off one release is exactly the
 * kind of constant that goes stale without anyone noticing.
 *
 * Splitting the write is what fixes it: the text arrives as a paste (which is
 * fine — that is what it is), and the `\r` arrives separately as a keystroke,
 * which is unambiguously "submit". The delay only has to outlast the TUI's own
 * paste-coalescing window, not any model work, which is why it is short.
 */
export const SUBMIT_DELAY_MS = 300;

/** How long every session's process group gets to exit on quit. */
export const QUIT_GRACE_MS = 3_000;

/**
 * Why a session could not start.
 *
 * A closed set, each member naming something the *user* can act on. A generic
 * "could not start a session" would be honest and useless: "the project is not
 * mapped" and "the pty host is down" are different problems with different
 * fixes, and only one of them is the user's to solve.
 *
 * The union spans both processes; the **wording** does not, and cannot. Three of
 * these are decided in main and worded by {@link spawnRefusal}. `not-desktop` is
 * decided in the renderer — it is the one precondition main cannot evaluate,
 * because in the browser build there is no main — and it is worded there, in
 * `src/features/sessions/session-control.ts`. This module stays importable
 * type-only from `src/**`, which is the rule that makes the contract a
 * compile-time artifact instead of a runtime edge between the processes.
 */
export type SpawnRefusal =
  | { reason: 'not-desktop' }
  | { reason: 'unmapped'; projectId: string; configPath: string }
  | { reason: 'at-capacity'; limit: number }
  | { reason: 'host-unavailable' };

/** The refusals main decides, and the exact wording each reaches the user with. */
export type MainSpawnRefusal = Exclude<SpawnRefusal, { reason: 'not-desktop' }>;

export function spawnRefusal(refusal: MainSpawnRefusal): string {
  switch (refusal.reason) {
    case 'unmapped':
      /**
       * Names the project *and* the file to edit. "Not mapped" alone sends the
       * user looking for a setting that does not exist; the path is the whole
       * actionable part.
       */
      return `${refusal.projectId} is not mapped — add it to ${refusal.configPath}`;
    case 'at-capacity':
      return `session limit reached (${refusal.limit})`;
    case 'host-unavailable':
      return 'pty host unavailable — see the activity feed';
  }
}
