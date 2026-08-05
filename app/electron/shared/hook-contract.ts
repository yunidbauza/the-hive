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
 * ## Why `SessionEnd` is absent, and `terminated` comes from the pty
 *
 * It looks like the obvious source for "this session is over" and it is the
 * wrong one. Claude Code fires `SessionEnd` with a `reason` of
 * `clear | logout | prompt_input_exit | other`, and only some of those mean the
 * process ended — `/clear` fires it on a session that is alive and sitting at
 * its prompt.
 *
 * Subscribing it and mapping it to `terminated` regardless, which is what this
 * shipped as first, made `/clear` lock the user out of a working session:
 * `isTerminated` closes the tab to new visits and disables its input, and
 * because a hook event outranks the activity inference nothing could correct
 * it.
 *
 * Reading `reason` would fix that case and still leave a hook asserting a
 * process death it cannot observe. Main *can* observe it — the pty exits, and
 * `activity.ts` reports `terminated` for every session including hook-driven
 * ones. So the division stands: hooks report what the agent is *doing*, the pty
 * reports whether it is still *there*.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'Elicitation',
  'Stop',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Status as observed from outside the pty.
 *
 * Wider than `DerivedStatus` by exactly one member. `waiting` is absent there
 * because it cannot be derived *from a pty*; that reasoning is still correct and
 * that type is still the right one for `activity.ts`. It becomes observable here
 * because a hook is a different observer with a different vantage point.
 *
 * `done` is still absent, and still for story 108's reason: it is a judgement
 * about the *work*, and no hook makes it either. `SessionEnd` is a process
 * ending, which is `terminated`.
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
 * the work did.
 */
export const HOOK_STATUS: Record<HookEvent, ObservedStatus> = {
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
  event: HookEvent;
  status: ObservedStatus;
}
