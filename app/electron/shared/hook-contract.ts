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
  'Stop',
  'SessionEnd',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

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

/**
 * Status as observed from outside the pty.
 *
 * Wider than `DerivedStatus` by exactly one member. `waiting` is absent there
 * because it cannot be derived *from a pty*; that reasoning is still correct and
 * that type is still the right one for `activity.ts`. It becomes observable here
 * because a hook is a different observer with a different vantage point.
 *
 * `done` is absent here too, and for a reason that survives `SessionEnd` being
 * subscribed: it is not a *status* a hook observes moment to moment, it is what
 * a session becomes at a boundary. It travels its own channel — see
 * `SessionClearedEvent` — rather than riding this union.
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
  Stop: 'idle',
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

/** The header carrying the per-launch shared secret. */
export const HOOK_HEADER_TOKEN = 'x-hive-token';

/** The environment variable each session's pty carries its Hive id in. */
export const HOOK_ENV_SESSION = 'HIVE_SESSION_ID';

/** The environment variable carrying the per-launch token into the hook. */
export const HOOK_ENV_TOKEN = 'HIVE_HOOK_TOKEN';

/** The path the receiver serves. */
export const HOOK_PATH = '/hook';

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
}
