/**
 * What Claude Code's hooks tell the app about a session (HIVE-62).
 *
 * Types and constants only — both processes import this.
 *
 * ## Why hooks and not the terminal
 *
 * `sessions/activity.ts` derives status from pty traffic, which can separate
 * "producing output" from "quiet" and nothing else. The state the whole
 * attention model is built on — `waiting`, blocked on the user — is invisible
 * there, because a TUI that has asked a question and a TUI that is thinking both
 * produce no output.
 *
 * Claude's terminal *title* looks like it closes that gap and does not. The
 * title carries an activity glyph (`✳` settled, braille frames working), but it
 * returns to `✳` while the session sits on an unanswered question — measured,
 * not assumed:
 *
 * ```
 * 14.9s  OSC 0 -> "⠂ sess-clean"   ← working
 * 17.7s  OSC 0 -> "✳ sess-clean"   ← "settled", while blocked on a question
 * 23.7s  OSC 9 -> "Claude needs your permission"
 * ```
 *
 * OSC 9 does carry a real signal, but it is prose, it lagged the question by six
 * seconds, and it is gated by the user's notification preferences. Hooks are the
 * only source that says what happened, when it happened, and for which session.
 */

/**
 * The hook events the app subscribes to.
 *
 * Deliberately a small subset. Claude Code emits far more, and every extra event
 * is another POST per session per turn on a channel whose only job is to keep a
 * status dot honest.
 *
 * ## `SessionEnd`, and why it reports `done` rather than `terminated`
 *
 * It looks like the obvious source for "this session is over" and it is not.
 * Claude Code fires `SessionEnd` with a `reason` of
 * `clear | logout | prompt_input_exit | other`, and only some of those mean the
 * process ended — `/clear` fires it on a session that is alive and sitting at
 * its prompt.
 *
 * Subscribing it and mapping it to `terminated` regardless, which is what this
 * shipped as first, made `/clear` lock the user out of a working session:
 * `isTerminated` closes the tab to new visits and disables its input, and
 * because a hook event outranks the activity inference nothing could correct it.
 * The event was then dropped entirely, on the reasoning that reading `reason`
 * would still leave a hook asserting a process death it cannot observe.
 *
 * That reasoning weighed two options and both were wrong, because the third had
 * no target: `done` had no producer, so "map it to something that is *not* a
 * death" was not available. It is now. `reason: 'clear'` means the
 * **conversation** ended while the process kept running — a boundary a hook can
 * see and a pty cannot — and that is exactly `done`.
 *
 * Measured, not assumed (real claude 2.1.225, real pty, outside the app):
 *
 * ```
 * /clear -> SessionEnd   reason "clear"              pty alive
 *           SessionStart source "clear"              new session_id
 * /exit  -> SessionEnd   reason "prompt_input_exit"  pty exits, code 0
 * ```
 *
 * Every other reason is still ignored here, and `terminated` still comes from
 * the pty. So the division holds and gets sharper: hooks report what the agent
 * is *doing* and whether its conversation ended; the pty reports whether the
 * process is still *there*.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'Elicitation',
  /**
   * The bookkeeping pair (HIVE-83).
   *
   * `PreToolUse` carries the `tool_use_id` that `PermissionRequest` does not,
   * and its `PostToolUse` carries the same one — which is the only way to tell
   * the blocked tool's completion from a sibling's in a parallel batch.
   *
   * The cost is honest: this is the second high-frequency hook subscribed, and
   * `PreToolUse` is a *blocking* hook — Claude waits for it before running the
   * tool. Both are loopback POSTs the receiver answers 204 to.
   */
  'PreToolUse',
  'PostToolUse',
  /**
   * How a stopped main agent is told apart from a finished session (HIVE-83).
   *
   * Both carry `agent_id`. Only agents seen starting are ever removed: Claude
   * Code emits `SubagentStop` for internal helper agents that never announced a
   * start.
   */
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * `SessionStart` is subscribed and does not arrive. Measured, not assumed.
 *
 * Claude Code 2.1.227, real pty, both handlers on the same event:
 *
 * ```
 * SessionStart  command hook  -> ran
 * SessionStart  http hook     -> never reached the receiver
 * ```
 *
 * Every other subscribed event delivers over `http` normally, so this is
 * specific to `SessionStart` — plausibly a hook dispatched before the http
 * transport is up. It is left subscribed rather than removed: the entry costs
 * one key in a file the app writes once per launch, and a future release that
 * starts delivering it would mark a session {@link HOOK_STATUS}-driven from the
 * moment it opens, which is strictly better than the current floor.
 *
 * The consequence today is the thing worth knowing: a session is **not**
 * hook-driven until its first `UserPromptSubmit`, so until the user types,
 * status comes from `activity.ts`'s pty inference.
 */

/**
 * The `SessionEnd` reason that means "the conversation ended, the process did
 * not". The only one this app acts on.
 */
export const CLEAR_REASON = 'clear';

/**
 * Events that say what the agent is *doing*.
 *
 * `SessionEnd` is excluded because it is a **lifecycle** event, not a status:
 * it reports a boundary between two conversations, and there is no honest
 * `ObservedStatus` to map it to. Expressed as a type rather than a comment so
 * {@link HOOK_STATUS} cannot be given a bogus entry for it.
 */
export type StatusHookEvent = Exclude<HookEvent, 'SessionEnd'>;

/** What is still running while the main agent is not (HIVE-83). */
export type IdleDetail = 'agents' | 'script';

/**
 * Status as observed from outside the pty.
 *
 * Wider than `DerivedStatus` by exactly one member. `waiting` is absent there
 * because it cannot be derived *from a pty*; that reasoning is still correct and
 * that type is still the right one for `activity.ts`. It becomes observable here
 * because a hook is a different observer with a different vantage point.
 *
 * `done` is absent here too, and stays absent now that `/done` can produce it
 * (HIVE-93). The reason is unchanged and is the point of the type: no hook
 * observes `done`. It is *declared* — by the user typing `/done`, or by a skill
 * handing off to it — and a declaration is not an observation. Keeping it out
 * of this union is what stops {@link HOOK_STATUS} from being given an entry
 * that would quietly let some Claude Code event mean "the work is finished".
 *
 * What carries it instead is `SessionFinishedEvent` in `session-contract.ts`,
 * on a channel of its own — the one place main speaks about a session having
 * been *told* something rather than having seen it. The status channel never
 * carries `done` at all.
 */
export type ObservedStatus = 'working' | 'waiting' | 'idle' | 'terminated';

/**
 * What each event means for the fleet view.
 *
 * `PermissionRequest` and `Elicitation` are the two ways Claude blocks on a
 * human — a tool needing approval, and an MCP server asking for input. They are
 * different mechanisms and the same fact about the session, so they map to the
 * same status rather than being distinguished for their own sake.
 *
 * `Stop` is `idle`, not `done`: the turn ended, which says nothing about whether
 * the work did. `/clear` is what says that, and it arrives as `SessionEnd` —
 * which is why this record is keyed on {@link StatusHookEvent} and cannot hold
 * an entry for it.
 */
export const HOOK_STATUS: Record<StatusHookEvent, ObservedStatus> = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  PermissionRequest: 'waiting',
  Elicitation: 'waiting',
  /**
   * Not a status on its own — see {@link NOTIFICATION_TYPE_STATUS}.
   *
   * `Notification` is the only subscribed event whose meaning depends on a
   * second field, and the entry here is the *floor*: a type this build does not
   * recognise still means Claude raised something at the user, and `waiting` is
   * the honest reading of that. The receiver refuses to publish an unrecognised
   * type anyway, so this value is reached only if that guard is ever relaxed.
   *
   * This floor is unchanged by `NOTIFICATION_TYPE_STATUS` splitting `idle_prompt`
   * from `permission_prompt`: an unrecognised type has no per-type reading to
   * fall back to, so `waiting` — Claude raised *something*, unread — is still
   * the honest default for it.
   */
  Notification: 'waiting',
  /**
   * `PreToolUse` and `PostToolUse` are both `working` as a *fallback only*.
   *
   * Since HIVE-83 the status the renderer sees is derived by
   * `hooks/tracker.ts` from what the session is, not looked up here. These
   * entries survive so the record stays total and so a consumer that has no
   * tracker still gets a defensible answer.
   */
  PreToolUse: 'working',
  PostToolUse: 'working',
  /** Bookkeeping only — the tracker decides what a live subagent means. */
  SubagentStart: 'working',
  SubagentStop: 'working',
  Stop: 'idle',
};

/**
 * What Claude Code calls the thing it is interrupting the user about.
 *
 * Measured against 2.1.227 in a real pty, and the two observed values are the
 * two that matter:
 *
 * ```
 * turn ends            -> Stop
 * +60s, no input       -> Notification  idle_prompt        "Claude is waiting for your input"
 * tool needs approval  -> PermissionRequest
 * +6s                  -> Notification  permission_prompt  "Claude needs your permission"
 * ```
 *
 * **`idle_prompt` is the event this whole subscription exists for.** It is the
 * only signal Claude emits for the most common way a session blocks on a human —
 * the turn ended and nobody typed — which `Stop` cannot express, because `Stop`
 * fires on every turn including the ones the user is sitting and watching. The
 * sixty seconds are Claude's own debounce, and they are exactly the difference
 * between "waiting" and "you walked away".
 */
export const NOTIFICATION_TYPES = ['idle_prompt', 'permission_prompt'] as const;

export type HookNotificationType = (typeof NOTIFICATION_TYPES)[number];

export const isHookNotificationType = (
  value: unknown,
): value is HookNotificationType =>
  typeof value === 'string' &&
  (NOTIFICATION_TYPES as readonly string[]).includes(value);

/**
 * What each recognised type means for the **status**, which is no longer the
 * same question as what it means for the **inbox**.
 *
 * `permission_prompt` is a session blocked on a human: a tool is waiting for a
 * yes and nothing proceeds until it gets one. `waiting` is the honest reading.
 *
 * `idle_prompt` is **not** that, and calling it `waiting` is what made the dot
 * lie. It fires sixty seconds after `Stop`, when the turn is already over and
 * the agent is sitting at an empty prompt — nothing is blocked, and there is no
 * question outstanding. `Stop` set `idle` a minute earlier and `idle` is what
 * the session still is.
 *
 * The signal is not lost by this: it moves to where it belongs. The inbox row
 * is raised off the hook *event* in `notifications/index.ts`, independently of
 * the status, so "you walked away and your agent wants you" still reaches the
 * user — it just stops painting the fleet view amber for a session nobody is
 * waiting on.
 */
export const NOTIFICATION_TYPE_STATUS: Record<
  HookNotificationType,
  ObservedStatus
> = {
  idle_prompt: 'idle',
  permission_prompt: 'waiting',
};


/**
 * The header carrying the Hive's own session id.
 *
 * Correlation does **not** go through the hook payload's `session_id`. That
 * field is Claude's uuid, and mapping it back would mean maintaining a second
 * table that has to be right at exactly the moment a session is starting. The
 * app already controls the environment each pty is spawned in, so it puts its
 * own id there and the hook echoes it — the mapping is the identity function.
 */
export const HOOK_HEADER_SESSION = 'x-hive-session';

/** The header carrying the caller's own session-bound token (HIVE-112). */
export const HOOK_HEADER_TOKEN = 'x-hive-token';

/** The environment variable each session's pty carries its Hive id in. */
export const HOOK_ENV_SESSION = 'HIVE_SESSION_ID';

/**
 * The environment variable carrying a session's own token into the hook.
 *
 * A derivation of the receiver's launch secret and this one session's id
 * (HIVE-112) — not the launch secret itself, which never leaves the receiver.
 */
export const HOOK_ENV_TOKEN = 'HIVE_HOOK_TOKEN';

/**
 * The environment variable carrying the receiver's base URL (HIVE-112).
 *
 * The third of the three the MCP host needs, and the one the hooks never
 * wanted: a hook is handed its URL baked into the generated settings file, but
 * the MCP host is started by `claude`, from a config file written before the
 * receiver had bound. So it is told at spawn instead, the way its identity is.
 */
export const HOOK_ENV_RECEIVER_URL = 'HIVE_RECEIVER_URL';

/** The path the receiver serves. */
export const HOOK_PATH = '/hook';

/**
 * The path `/done` posts to (HIVE-93).
 *
 * Its own route rather than an event on {@link HOOK_PATH}, for the reason
 * `METRICS_PATH` is separate: nothing about this is a hook. No Claude Code
 * event produces it, it carries no payload to parse, and the receiver's answer
 * to it is a *lifecycle* action rather than a status tick. Sharing the hook
 * route would mean inventing an event name Claude Code never sends.
 */
export const DONE_PATH = '/done';

/**
 * The exact command `/done`'s body runs, and the exact rule its frontmatter
 * grants (HIVE-93).
 *
 * **One builder, two callers, on purpose** — and both of them are
 * `skills/done-skill.ts`: `active()` spells the command out in the body, and
 * `frontmatter()` wraps the same string in `allowed-tools`. (An earlier version
 * put the grant in the app-generated settings file instead; that file merges
 * above the user's own scope, so the permission was invisible and unrevokable
 * to them, and it is gone.)
 *
 * If the two ever drifted the symptom would be a permission prompt in the middle
 * of the app's own built-in — a failure the user cannot diagnose and did nothing
 * to cause. Deriving both from one function makes the drift impossible rather
 * than unlikely. The grant is the **whole** command, never a prefix: `curl`
 * takes `-K`, `-o`, `-D` and `--upload-file`, none of which need a shell
 * operator, so a trailing `:*` would be a silent grant of arbitrary file writes.
 *
 * Lives here, in a module that may hold no runtime, because it is neither
 * runtime nor either caller's business: it is the shape of a request on the
 * wire, which is what this file is for. No Node APIs, no imports, pure string.
 *
 * `-sS` rather than the status line's `-s`: this one has no stdout to protect —
 * nothing renders its output — so a failure should say so in the transcript
 * instead of vanishing. `--fail` makes a 4xx a non-zero exit for the same
 * reason, so a session whose token went stale reports it rather than appearing
 * to succeed and never closing.
 */
export const doneCommand = (url: string): string =>
  `curl -sS --fail -m 5 -X POST ${url}` +
  ` -H "${HOOK_HEADER_SESSION}: $${HOOK_ENV_SESSION}"` +
  ` -H "${HOOK_HEADER_TOKEN}: $${HOOK_ENV_TOKEN}"`;

/**
 * The path a session posts to the moment Claude is actually up (HIVE-101).
 *
 * Its own route for {@link DONE_PATH}'s reason: nothing about it is a status
 * tick. It carries no payload, names no Claude Code event the app models, and
 * the receiver's answer to it is a *lifecycle* fact — the shell has finished
 * whatever it was doing and the thing the user came for is on screen.
 */
export const READY_PATH = '/ready';

/**
 * The command the `SessionStart` hook runs to report that Claude is up.
 *
 * ## Why a `command` hook and not an `http` one
 *
 * Because the http one does not arrive. That is recorded above against Claude
 * Code 2.1.227 and was re-measured for this story against a real binary in a
 * real pty, with all three candidates wired to one server:
 *
 * ```
 * SessionStart  command hook  -> +2050ms
 * SessionStart  http hook     -> never arrived
 * status line   (first call)  -> +2163ms
 * ```
 *
 * So the command hook is both the only one that works and the earliest signal
 * available — it beats the status line by about a tenth of a second, and both
 * land around two seconds, which is when Claude's UI exists.
 *
 * ## Why it must print nothing, ever
 *
 * **A `SessionStart` hook's stdout is added to Claude's context.** Anything this
 * command writes becomes part of the conversation the user is about to have, so
 * `-s -o /dev/null` is not tidiness, it is correctness — and `2>/dev/null`
 * covers the case where curl complains about a receiver that has gone away.
 *
 * `|| true` for the matching reason on the other side: a non-zero exit from a
 * hook surfaces in the session as a failure the user did not cause and cannot
 * act on. A ready signal that fails to send is a slightly longer loading view,
 * which the timeout already covers. It is not an error worth showing anyone.
 *
 * No `--fail`, for the same reason `/done` has one: there, a stale token should
 * be loud because the session will otherwise never close. Here it should be
 * silent, because the overlay lifts on a timeout regardless.
 */
export const readyCommand = (url: string): string =>
  `curl -s -m 3 -o /dev/null -X POST ${url}` +
  ` -H "${HOOK_HEADER_SESSION}: $${HOOK_ENV_SESSION}"` +
  ` -H "${HOOK_HEADER_TOKEN}: $${HOOK_ENV_TOKEN}" 2>/dev/null || true`;

/**
 * The largest body the receiver will read.
 *
 * Hook payloads carry `tool_input`, which for an Edit is a whole file. The app
 * reads none of it — only the event name matters — so the cap is small and a
 * body that exceeds it is answered rather than buffered.
 */
export const HOOK_MAX_BODY_BYTES = 64 * 1024;

/** What the receiver hands the rest of main once a POST validates. */
export interface HookStatusEvent {
  entityId: string;
  event: StatusHookEvent;
  status: ObservedStatus;
  /**
   * Which kind of interruption, for a `Notification` event only.
   *
   * On the event rather than folded into `event` because the two answer
   * different questions and only one of them is a status: `event` says *which
   * hook spoke*, which is what makes `waiting` distinguishable at all, and this
   * says *what it said*. Flattening them into a widened `StatusHookEvent` would
   * put synthetic members into a union whose whole value is that it names real
   * Claude Code events.
   *
   * Absent for every other event, which is the same discipline `cwd` follows:
   * absence is the honest answer, not a default.
   */
  notificationType?: HookNotificationType;
  /**
   * The directory the agent is working in, as the payload reported it (HIVE-78).
   *
   * **This is the field that makes an honest branch possible**, and it arrives
   * free. `docs/branch-sync-note.md` listed "the session's live working
   * directory" as the first of two things main did not have, and proposed
   * inspecting the shell process with `lsof -a -p <pid> -d cwd` to get it. That
   * is unnecessary: every Claude Code hook payload already carries `cwd`, and it
   * is the *agent's* cwd rather than the shell's — which is the more accurate of
   * the two anyway, since a session that moves into a worktree moves the agent,
   * not necessarily the login shell.
   *
   * Optional because it is read off a payload this app does not control. A
   * missing `cwd` means no branch is resolved on that event, which is the same
   * outcome as a session with no hooks at all.
   */
  cwd?: string;
  /**
   * Tool identity, carried since HIVE-83.
   *
   * All optional because not every event has them and because a body over
   * `HOOK_MAX_BODY_BYTES` truncates `tool_use_id` off the end — `tool_input`
   * precedes it on the wire. `tool_name` precedes `tool_input` in turn, so it
   * always survives truncation; `tool_use_id` never does. Both `PreToolUse`
   * and `PostToolUse` lose `tool_use_id` the same way, so the tracker's
   * bookkeeping stays consistent and only pairing degrades — `tool_name`
   * recovers by itself, per `receiver.ts`'s truncated-prefix parse.
   */
  toolUseId?: string;
  toolName?: string;
  /** Present on every event originating inside a subagent, absent on the main agent's. */
  agentId?: string;
  /** `tool_input.run_in_background` on a `Bash` call. */
  runInBackground?: boolean;
  /**
   * The background **shells** Claude Code reports still running, by id
   * (HIVE-90).
   *
   * `Stop` and `SubagentStop` carry a `background_tasks` array — the live list,
   * authored by Claude Code itself rather than inferred from the tool events
   * that opened each shell. Measured against 2.1.245, a shell started with
   * `run_in_background` and left running:
   *
   * ```
   * Stop  background_tasks: [
   *   { id: 'bcy0lrc5b', type: 'shell', status: 'running',
   *     description: '…', command: 'sleep 40; echo finished-bg' }
   * ]
   * ```
   *
   * and the same shell once it has exited — whether it outlived the turn or
   * finished inside it — `background_tasks: []`. That second case is the whole
   * of HIVE-90: the inference in `tracker.ts` had no way to see it, because
   * Claude Code emits no hook when a backgrounded process dies.
   *
   * **Shells, not tasks**, and the difference is load-bearing: the same array
   * also carries `type: 'subagent'` entries, which this app tracks from
   * `SubagentStart` / `SubagentStop` instead and more freshly. `receiver.ts`'s
   * `liveBackgroundShellIds` is where that filter lives and why.
   *
   * ## Empty and absent are different, deliberately
   *
   * `[]` is an **observation**: the session was asked and reported nothing
   * running. `undefined` is **silence** — either an event that does not carry
   * the key at all, or a `Stop` body over {@link HOOK_MAX_BODY_BYTES}, since
   * `last_assistant_message` precedes `background_tasks` on the wire and a long
   * final message truncates the list away. Collapsing the two would turn a
   * body the app could not read into "nothing is running", which is the
   * announce-too-early defect this field exists to remove. `tracker.ts` trusts
   * an observation and falls back to its inference on silence.
   *
   * Ids only: the rest of each entry is a description and a command line the
   * app has no reading for, and forwarding a user's command text through the
   * status channel is not something this needs to do to count what is running.
   */
  backgroundShells?: string[];
}

/**
 * The same POST, arriving under an **agent's** name rather than a session's
 * (HIVE-115).
 *
 * A distinct type rather than a widened {@link HookStatusEvent}, because the
 * two travel on different callbacks and only one of them may reach a status
 * push or the session history — see `ReceiverOptions.onAgentEvent`.
 *
 * **The name documents; it does not enforce.** `sessionUuid` is optional, so
 * the two interfaces are mutually assignable and the compiler will not stop a
 * consumer written for one from being handed the other. What actually keeps an
 * agent's event off the session path is *positional*: `receiver.ts` parts the
 * two id spaces before it reads a field of the payload, and the branch that
 * builds this shape can only reach `onAgentEvent`. This type's job is to give
 * the uuid somewhere to live that is not the session's shape, and to say at a
 * glance which register a signature is about.
 *
 * It extends the session shape rather than replacing it because everything on
 * that shape is still true here: an agent's headless turn raises the same
 * events, in the same vocabulary, with the same `cwd` and tool identity. Only
 * {@link HookAgentEvent.sessionUuid} is new, and only agents have a use for it.
 */
export interface HookAgentEvent extends HookStatusEvent {
  /**
   * Claude's own uuid for the conversation this hook fired in — the payload's
   * `session_id`.
   *
   * {@link HOOK_HEADER_SESSION} explains why a *session* never correlates on
   * this field: the app puts its own id in the environment and the hook echoes
   * it, so the mapping is the identity function and a second table would be one
   * more thing to keep right. An agent needs both, and for a reason a session
   * does not have: a wake is one process per turn, and the id in the header is
   * the agent's **name**, which every run it ever makes shares. A `Stop`
   * delivered late — after the run it belonged to exited and the next one
   * started under the same name — would otherwise arm a stall watchdog against
   * a different, healthy run. The uuid is what tells the two apart, because the
   * waker minted it for `--session-id` (or is resuming it) and therefore knows
   * which run it names.
   *
   * Optional because it is read off a payload this app does not control. Absent
   * means the correlation cannot be made and the consumer decides what to do
   * with that; it is never inferred.
   */
  sessionUuid?: string;
}

/**
 * A prompt in which the user named a ticket they intend to work on (HIVE-78).
 *
 * Separate from {@link HookStatusEvent} because it is a different kind of fact
 * arriving from the same POST: `UserPromptSubmit` always moves the status to
 * `working`, and only *sometimes* carries an intent. Folding the key into the
 * status event would put an optional field on every tick of the most frequent
 * event on the channel, and would tie a rename to a status change that has
 * nothing to do with it.
 *
 * The key here is **unconfirmed** — see `SessionTicketIntentEvent` for why
 * confirming it is the renderer's job.
 */
export interface HookTicketIntentEvent {
  entityId: string;
  key: string;
  source: TicketIntentSource;
}

/**
 * Where a ticket candidate came from, and therefore how much it may change.
 *
 * `prompt` is the user saying it in their own words; `branch` is main reading it
 * off the branch the session is standing on. Both associate the session — the
 * WORK card matches on the ticket and never on the name — but only the spoken
 * one renames the row, because only it is a decision the user made just now and
 * would recognise in a new name. See `SetSessionTicketOptions` in the store.
 *
 * Carried explicitly rather than inferred from which listener fired, because
 * both arrive on the one channel and the renderer's rename decision must not
 * depend on remembering that.
 */
export type TicketIntentSource = 'prompt' | 'branch';
