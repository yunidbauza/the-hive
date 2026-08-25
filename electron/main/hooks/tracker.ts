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
  /**
   * What Claude Code says is still running in the background, by id (HIVE-90).
   *
   * An observation, not an inference — see {@link Session.bgShells}. `[]` means
   * "asked, nothing running"; `undefined` means the event did not say, and the
   * inference stands.
   */
  backgroundShells?: string[];
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
  /**
   * The background shells this session is believed to still be running.
   *
   * ## Two ways in, and only one of them is trustworthy (HIVE-90)
   *
   * **The observation.** `Stop` and `SubagentStop` carry Claude Code's own
   * live `background_tasks` list, and when one arrives it *replaces* this set
   * wholesale — see the `backgroundShells` branch in `apply()`. That is the
   * only path that can ever see a shell **end**, because Claude Code emits no
   * hook when a backgrounded process dies.
   *
   * **The inference**, kept as the fallback for a body that carried no list: a
   * `PostToolUse` with `run_in_background` adds, and `UserPromptSubmit`
   * clears. It is what shipped in HIVE-84 and it is wrong in both directions
   * on its own — it cannot see a shell that finished inside its turn (so the
   * detail stayed on `script` until the next prompt), and it forgets a shell
   * that is genuinely still running the moment the user types (so the next
   * `Stop` read as a true idle). HIVE-89 made the first of those expensive:
   * a live detail suppresses `session.idle` *and* `session.input_needed`, so
   * a session that was genuinely the user's announced nothing at all.
   *
   * ## Why the two id spaces do not need to agree
   *
   * The inference adds a `tool_use_id`; the observation carries Claude Code's
   * own task ids (`bcy0lrc5b`). They never mix in a way that matters, because
   * an observation replaces rather than merges, and because membership here is
   * only ever *counted* — `derive()` asks whether the set is empty, never
   * which shell an entry is. Reconciling the spaces would mean reading
   * `tool_response.backgroundTaskId` off every `PostToolUse` to buy nothing.
   */
  bgShells: Set<string>;
  /**
   * Tools this turn whose `PreToolUse` was truncated past `tool_use_id`, by
   * name (HIVE-86).
   *
   * These are running but *unrecorded* — `outstanding` never learned about
   * them, because pairing needs an id. They have to be counted anyway, because
   * "exactly one match in `outstanding`" is uniqueness among what was recorded,
   * which is not the same as uniqueness among what is running. Without this, a
   * truncated `PostToolUse` belonging to one of these would retire the
   * unrelated recorded tool that happens to share its name.
   *
   * Cleared at the turn boundary alongside `bgShells`: an entry whose
   * `PostToolUse` arrived *with* an id (a large input and a small response)
   * has nothing to decrement it, so it would otherwise suppress pairing for
   * that name for the rest of the conversation.
   */
  unrecorded: Map<string, number>;
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

/**
 * How much bookkeeping a session is holding (HIVE-86).
 *
 * None of this is visible through `derive()`, and that is the point: `resolve()`
 * prefers the newest match, so a stale entry loses every race it could enter and
 * no status is ever wrong because of one. The defect a leak causes is the growth
 * itself — memory that a long conversation never gets back, and a longer walk on
 * every `PermissionRequest` — which means a status assertion could never catch
 * it. This is the seam that can.
 */
export interface HeldCounts {
  outstanding: number;
  blocked: number;
  agents: number;
  bgShells: number;
}

export interface StatusTracker {
  apply(input: TrackerInput): DerivedState;
  /** `/clear` and `SessionStart`: same pty, new conversation. */
  reset(entityId: string): void;
  /** The process is gone; drop the record entirely. */
  forget(entityId: string): void;
  /** What this session is still holding. See `HeldCounts`. */
  held(entityId: string): HeldCounts;
}

function empty(): Session {
  return {
    turnActive: false,
    outstanding: new Map(),
    blocked: new Set(),
    blockedNames: new Map(),
    agents: new Set(),
    bgShells: new Set(),
    unrecorded: new Map(),
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
 * therefore the newest outstanding entry with this name. `agentId` participates
 * because a subagent's block and the main agent's must not resolve to each
 * other.
 *
 * The walk is forward and keeps the *last* match rather than reversing a copy
 * of the map (HIVE-86). Insertion order makes those identical — the last match
 * in insertion order is the newest — and this one allocates nothing, where
 * `[...s.outstanding.entries()]` built a fresh array of the whole map on every
 * `PermissionRequest`.
 */
function resolve(s: Session, toolName?: string, agentId?: string): string {
  if (toolName === undefined) return UNPAIRED;
  let newest = UNPAIRED;
  for (const [id, entry] of s.outstanding) {
    if (entry.toolName === toolName && entry.agentId === agentId && !s.blocked.has(id))
      newest = id;
  }
  return newest;
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

      /**
       * An observation outranks the inference (HIVE-90).
       *
       * Applied before the switch rather than inside the `Stop` and
       * `SubagentStop` cases, because the rule is about the *payload* and not
       * about which event delivered it: any body that reports its live
       * background shells is more authoritative than a set assembled from the
       * tool events that opened each one. Those two are the only events
       * measured carrying the list, so today this is where it lands — but a
       * release that starts sending it elsewhere is then already handled,
       * where an event-keyed version would quietly keep guessing.
       *
       * Before the switch, so `derive()` at the end of every case already sees
       * it. The one case that also writes this set is `UserPromptSubmit`,
       * whose clear runs afterwards and therefore wins; that is correct and
       * costs nothing, since a `UserPromptSubmit` carries no list to overrule.
       */
      if (input.backgroundShells !== undefined) {
        s.bgShells.clear();
        for (const id of input.backgroundShells) s.bgShells.add(id);
      }

      switch (input.event) {
        case 'SessionStart':
          sessions.set(input.entityId, empty());
          return derive(sessions.get(input.entityId) as Session);

        case 'UserPromptSubmit':
          /**
           * Also the background-shell inference's only way to stop being
           * sticky — and no longer the only way a shell's end is *seen*
           * (HIVE-90).
           *
           * Claude Code still emits no hook when a backgrounded process dies,
           * so nothing here observes one. What this clear buys is that the
           * inference cannot hold a shell forever; what it costs is that a
           * shell genuinely still running is forgotten the moment the user
           * types. That was a real defect while the inference was all there
           * was: the next `Stop` read as a true idle and raised
           * `session.idle` mid-shell, then the shell's own re-invoke ended in
           * a second `Stop` and a second row. The `background_tasks` list on
           * that same `Stop` now restores the shell before `derive()` runs —
           * see {@link Session.bgShells} — so the clear is corrected within
           * one event and only a body too large to carry the list is left
           * paying for it.
           *
           * ## Why `outstanding` is not cleared wholesale here (HIVE-86)
           *
           * The internal re-invoke that delivers a subagent's result is itself
           * a `UserPromptSubmit`, and it is **not distinguishable** from a
           * typed one. Measured against Claude Code 2.1.239, the two bodies
           * carry identical key sets — `session_id, transcript_path, cwd,
           * prompt_id, permission_mode, hook_event_name, prompt`. No `source`,
           * no `agent_id`, no flag. `prompt_id` differs, but it is a fresh uuid
           * on both, so it says "a new prompt", not "who sent it". The only
           * separator is the prompt *body* being a `<task-notification>`
           * envelope — sniffing an undocumented internal format, which is worse
           * than the leak it would fix.
           *
           * So a blanket clear would discard a subagent's in-flight tools
           * mid-flight and reintroduce the defect HIVE-83 removed: a tool
           * completing against no record.
           *
           * What is safe *enough* is the intersection with `blocked`. An entry
           * that is both outstanding and blocked is a tool waiting on a human;
           * had it been answered, its `PostToolUse` would have removed it from
           * both. The one path that strands it is Escape, which — measured,
           * same probe — emits no event whatsoever, so nothing else can ever
           * clear it.
           *
           * "Safe enough" and not "safe", because a subagent's tool *can* be in
           * `blocked`: `resolve()` matches on `agentId`, so a subagent's own
           * `PermissionRequest` resolves to its own `tool_use_id`. A re-invoke
           * carrying another subagent's result therefore can drop an entry that
           * is genuinely still blocked on a human.
           *
           * What makes that acceptable is that it costs nothing new:
           * `blocked.clear()` on the very next line already discards exactly
           * those ids, and has since HIVE-83. The status consequence is
           * identical before and after this change; all that changes is that
           * `outstanding` stops disagreeing with `blocked` about them. Widening
           * the sweep past this intersection is what would be a regression.
           */
          s.turnActive = true;
          for (const id of s.blocked) s.outstanding.delete(id);
          s.blocked.clear();
          s.blockedNames.clear();
          s.bgShells.clear();
          s.unrecorded.clear();
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
          } else if (input.toolName !== undefined) {
            // Truncated past `tool_use_id`: running, but unpairable. See
            // `unrecorded` — it is what stops a later truncated `PostToolUse`
            // from retiring a *different* tool of the same name.
            s.unrecorded.set(input.toolName, (s.unrecorded.get(input.toolName) ?? 0) + 1);
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

            /**
             * And the same recovery for `outstanding`, which this branch never
             * performed (HIVE-86).
             *
             * HIVE-83 reasoned that truncation cancels out: a large
             * `tool_input` strips `tool_use_id` from `PreToolUse` and from its
             * `PostToolUse` alike, so neither side records anything. That holds
             * for a large *input*. It does not hold for a small input with a
             * large `tool_response` — a `Read` of a big file — where the
             * `PreToolUse` keeps its id and only the `PostToolUse` loses it.
             * The entry then had nothing left to clear it.
             *
             * ## Why this needs two guards the `blocked` recovery above does not
             *
             * "Exactly one match" is uniqueness among what was *recorded*, and
             * that is weaker than uniqueness among what is *running*:
             *
             * - A same-named tool whose own `PreToolUse` was truncated is
             *   running but absent from `outstanding`, so the lone remaining
             *   match is a *different*, live tool. Retiring it makes its own
             *   `PermissionRequest` resolve to `UNPAIRED`, which its id-ful
             *   `PostToolUse` can then never clear — the session sits on
             *   `waiting` past `Stop`. That is worse than the leak, and exactly
             *   the defect class HIVE-83 removed, so `unrecorded` is consulted
             *   first and an ambiguous completion is left alone.
             * - `agentId` cannot discriminate here. It is recoverable only from
             *   a whole body, and this branch runs only on a truncated one
             *   (`receiver.ts` recovers `hook_event_name`, `reason`, `cwd`,
             *   `notification_type` and `tool_name` — there is no agent-id
             *   prefix regex), so `input.agentId` is always `undefined`. It
             *   would therefore match main-agent entries indiscriminately,
             *   including when the completion came from inside a subagent. With
             *   any subagent live, whose completion this is cannot be known, so
             *   nothing is retired.
             *
             * Both guards fail closed: the entry leaks, which costs memory and
             * nothing else, rather than stranding a session on a wrong status.
             */
            const unrecorded = s.unrecorded.get(input.toolName) ?? 0;
            if (unrecorded > 0) {
              // Plausibly this completion. Spend it, and retire nothing.
              if (unrecorded === 1) s.unrecorded.delete(input.toolName);
              else s.unrecorded.set(input.toolName, unrecorded - 1);
            } else if (s.agents.size === 0) {
              let onlyMatch: string | undefined;
              let matchCount = 0;
              for (const [id, entry] of s.outstanding) {
                if (entry.toolName === input.toolName && entry.agentId === undefined) {
                  matchCount += 1;
                  onlyMatch = id;
                }
              }
              if (matchCount === 1 && onlyMatch !== undefined)
                s.outstanding.delete(onlyMatch);
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

    held(entityId) {
      const s = sessions.get(entityId);
      if (s === undefined)
        return { outstanding: 0, blocked: 0, agents: 0, bgShells: 0 };
      return {
        outstanding: s.outstanding.size,
        blocked: s.blocked.size,
        agents: s.agents.size,
        bgShells: s.bgShells.size,
      };
    },
  };
}
