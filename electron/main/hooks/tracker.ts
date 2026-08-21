import type {
  HookNotificationType,
  IdleDetail,
  ObservedStatus,
  StatusHookEvent,
} from '@shared/hook-contract';

/**
 * The stand-in for a block whose tool could not be identified.
 *
 * `PermissionRequest` carries no `tool_use_id` and `Elicitation` carries no tool
 * identity at all, so a block that cannot be paired is still recorded — losing
 * it would be worse than holding it a little too long, which is the failure the
 * old `stillRelevant` workaround was compensating for.
 */
export const UNPAIRED = 'unpaired';

export interface TrackerInput {
  entityId: string;
  event: StatusHookEvent;
  toolUseId?: string;
  toolName?: string;
  agentId?: string;
  runInBackground?: boolean;
  notificationType?: HookNotificationType;
}

export interface DerivedState {
  status: ObservedStatus;
  detail?: IdleDetail;
}

interface Session {
  turnActive: boolean;
  /** Insertion-ordered, which is what makes "most recent match" cheap. */
  outstanding: Map<string, { toolName: string; agentId?: string }>;
  blocked: Set<string>;
  /**
   * The tool name a `blocked` entry is *about*, when it is known — keyed the
   * same way as `blocked` (a real id, or the `UNPAIRED` sentinel). Lets an
   * id-less `PostToolUse` (§5.3) clear a block by name instead of blindly
   * clearing the sentinel, without a second data structure for every entry:
   * a real id's name is also recoverable from `outstanding`, but `UNPAIRED`
   * has nowhere else to keep one.
   *
   * `Elicitation` deliberately leaves no name behind (it has none to give),
   * which is what stops an unrelated truncated `PostToolUse` from clearing an
   * Elicitation's block it merely happens to share the sentinel with.
   */
  blockedNames: Map<string, string>;
  agents: Set<string>;
  bgShells: Set<string>;
  /**
   * Whether a `PostToolUse` has landed since the last `PermissionRequest`
   * (§4.4 / review Fix 2). Guards the `permission_prompt` echo: if the
   * request was already answered, the six-second-later echo must not
   * re-assert a block the session has moved past. Reset by `PreToolUse` too
   * (HIVE-83 regression fix, see that case for why) and by
   * `UserPromptSubmit`.
   *
   * Measured against real Claude Code 2.1.238: approving a permission ~3s
   * after the request produced no `permission_prompt` at all —
   * `PreToolUse → PermissionRequest → PostToolUse → Stop`, echo absent —
   * because Claude Code suppresses the echo once the permission is answered.
   * The race this guards is a sub-second one (echo already in flight when the
   * answer lands), not the common path.
   */
  postToolUseSincePermissionRequest: boolean;
}

export interface StatusTracker {
  apply(input: TrackerInput): DerivedState;
  /** `/clear` and `SessionStart`: same pty, new conversation. */
  reset(entityId: string): void;
  /** The process is gone; drop the record entirely. */
  forget(entityId: string): void;
}

function empty(): Session {
  return {
    turnActive: false,
    outstanding: new Map(),
    blocked: new Set(),
    blockedNames: new Map(),
    agents: new Set(),
    bgShells: new Set(),
    postToolUseSincePermissionRequest: false,
  };
}

/**
 * `blocked` outranks `turnActive` deliberately.
 *
 * Measured: `Stop` can arrive *before* a subagent's `PermissionRequest` — the
 * main agent finishes its turn and a subagent then blocks on a human. Clearing
 * the block on `Stop` would lose exactly that case.
 */
function derive(s: Session): DerivedState {
  if (s.blocked.size > 0) return { status: 'waiting' };
  if (s.turnActive) return { status: 'working' };
  if (s.agents.size > 0) return { status: 'idle', detail: 'agents' };
  if (s.bgShells.size > 0) return { status: 'idle', detail: 'script' };
  return { status: 'idle' };
}

/**
 * Resolve a `PermissionRequest` to the tool it is about.
 *
 * The matching `PreToolUse` fires roughly sixty milliseconds earlier and is
 * therefore the newest outstanding entry with this name — so the map is walked
 * backwards. `agentId` participates because a subagent's block and the main
 * agent's must not resolve to each other.
 */
function resolve(s: Session, toolName?: string, agentId?: string): string {
  if (toolName === undefined) return UNPAIRED;
  const entries = [...s.outstanding.entries()];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const [id, held] = entries[i];
    if (held.toolName === toolName && held.agentId === agentId && !s.blocked.has(id))
      return id;
  }
  return UNPAIRED;
}

export function createStatusTracker(): StatusTracker {
  const sessions = new Map<string, Session>();

  function at(entityId: string): Session {
    const found = sessions.get(entityId);
    if (found !== undefined) return found;
    const made = empty();
    sessions.set(entityId, made);
    return made;
  }

  return {
    apply(input) {
      const s = at(input.entityId);

      switch (input.event) {
        case 'SessionStart':
          sessions.set(input.entityId, empty());
          return derive(sessions.get(input.entityId) as Session);

        case 'UserPromptSubmit':
          /**
           * Also the only observable end of a background shell: Claude Code
           * emits no hook when a backgrounded process dies, and re-invokes the
           * agent when it collects the result. Clearing here means the state is
           * never sticky, at the cost of briefly under-reporting a second job.
           */
          s.turnActive = true;
          s.blocked.clear();
          s.blockedNames.clear();
          s.bgShells.clear();
          s.postToolUseSincePermissionRequest = false;
          return derive(s);

        case 'PreToolUse':
          /**
           * Also re-arms the `permission_prompt` echo guard (§4.4 / review
           * Fix 2, HIVE-83 regression fix). Measured against real Claude Code
           * 2.1.238: a `PermissionRequest` is always preceded by its own
           * `PreToolUse` about 60 ms earlier — so "a `PreToolUse` has arrived
           * since the last resolution" is exactly the condition under which a
           * *new* block is possible. Without this, the flag set by an
           * unrelated tool's `PostToolUse` stayed true for the rest of the
           * session: a later tool's `PermissionRequest` POST could be
           * dropped, and the guard would then silently swallow the echo that
           * was supposed to recover it, leaving a genuinely blocked session
           * reporting `working`. An echo with no intervening `PreToolUse` can
           * only belong to a request that is already resolved, and stays
           * suppressed.
           */
          s.postToolUseSincePermissionRequest = false;

          if (input.toolUseId !== undefined && input.toolName !== undefined) {
            s.outstanding.set(input.toolUseId, {
              toolName: input.toolName,
              ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
            });
          }
          return derive(s);

        case 'PostToolUse': {
          s.postToolUseSincePermissionRequest = true;

          if (input.toolUseId !== undefined) {
            s.outstanding.delete(input.toolUseId);
            s.blocked.delete(input.toolUseId);
            s.blockedNames.delete(input.toolUseId);
            if (input.runInBackground === true) s.bgShells.add(input.toolUseId);
          } else if (input.toolName !== undefined) {
            /**
             * A body over `HOOK_MAX_BODY_BYTES` truncates `tool_use_id` off the
             * end (`tool_name` precedes it on the wire and always survives).
             * §5.3: clear a blocked entry by name only when exactly one
             * matches — otherwise this is indistinguishable from a *different*
             * tool finishing, and would wrongly release, say, a live
             * `Elicitation` block that happens to share the `UNPAIRED`
             * sentinel. Ambiguous or unknown (an `Elicitation`'s block has no
             * name — see `blockedNames`) means "otherwise ignored".
             */
            const matches = [...s.blocked].filter(
              (key) => s.blockedNames.get(key) === input.toolName,
            );
            if (matches.length === 1) {
              s.blocked.delete(matches[0]);
              s.blockedNames.delete(matches[0]);
            }
          }
          return derive(s);
        }

        case 'PermissionRequest': {
          const key = resolve(s, input.toolName, input.agentId);
          s.blocked.add(key);
          if (input.toolName !== undefined) s.blockedNames.set(key, input.toolName);
          s.postToolUseSincePermissionRequest = false;
          return derive(s);
        }

        case 'Elicitation':
          s.blocked.add(UNPAIRED);
          // No tool identity to give (§4.4) — see `blockedNames`.
          s.blockedNames.delete(UNPAIRED);
          return derive(s);

        case 'Notification':
          /**
           * `permission_prompt` echoes a `PermissionRequest` six seconds later.
           * It re-asserts a block only when none is held *and* the request has
           * not already been answered — recovering a missed request without
           * double-counting one already tracked, and without re-blocking a
           * session that has since moved on (review Fix 2; see
           * `postToolUseSincePermissionRequest`'s doc for what was measured).
           */
          if (
            input.notificationType === 'permission_prompt' &&
            s.blocked.size === 0 &&
            !s.postToolUseSincePermissionRequest
          )
            s.blocked.add(UNPAIRED);
          if (input.notificationType === 'idle_prompt') s.turnActive = false;
          return derive(s);

        case 'SubagentStart':
          if (input.agentId !== undefined) s.agents.add(input.agentId);
          return derive(s);

        case 'SubagentStop':
          /**
           * Only agents seen starting are removed. Claude Code emits
           * `SubagentStop` for internal helper agents with an empty
           * `agent_type` and no matching `SubagentStart`; a plain counter would
           * go negative on them.
           */
          if (input.agentId !== undefined) s.agents.delete(input.agentId);
          return derive(s);

        case 'Stop':
          s.turnActive = false;
          return derive(s);

        default:
          return derive(s);
      }
    },

    reset(entityId) {
      sessions.set(entityId, empty());
    },

    forget(entityId) {
      sessions.delete(entityId);
    },
  };
}
