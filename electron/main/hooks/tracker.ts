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
  agents: Set<string>;
  bgShells: Set<string>;
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
    agents: new Set(),
    bgShells: new Set(),
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
          s.bgShells.clear();
          return derive(s);

        case 'PreToolUse':
          if (input.toolUseId !== undefined && input.toolName !== undefined) {
            s.outstanding.set(input.toolUseId, {
              toolName: input.toolName,
              ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
            });
          }
          return derive(s);

        case 'PostToolUse': {
          if (input.toolUseId !== undefined) {
            s.outstanding.delete(input.toolUseId);
            s.blocked.delete(input.toolUseId);
            if (input.runInBackground === true) s.bgShells.add(input.toolUseId);
          } else {
            /**
             * A body over `HOOK_MAX_BODY_BYTES` truncates `tool_use_id` off the
             * end. Both sides truncate symmetrically, so nothing was recorded
             * either — but a block held under `UNPAIRED` still needs releasing.
             */
            s.blocked.delete(UNPAIRED);
          }
          return derive(s);
        }

        case 'PermissionRequest':
        case 'Elicitation':
          s.blocked.add(
            input.event === 'Elicitation'
              ? UNPAIRED
              : resolve(s, input.toolName, input.agentId),
          );
          return derive(s);

        case 'Notification':
          /**
           * `permission_prompt` echoes a `PermissionRequest` six seconds later.
           * It re-asserts a block only when none is held — recovering a missed
           * request without double-counting one already tracked.
           */
          if (input.notificationType === 'permission_prompt' && s.blocked.size === 0)
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
