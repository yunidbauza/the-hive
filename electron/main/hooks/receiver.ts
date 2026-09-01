import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { StringDecoder } from 'node:string_decoder';

import { parseLedgerPostBody, parseLedgerReadQuery } from '@shared/guards';
import {
  CLEAR_REASON,
  HOOK_HEADER_SESSION,
  HOOK_HEADER_TOKEN,
  HOOK_MAX_BODY_BYTES,
  DONE_PATH,
  HOOK_PATH,
  READY_PATH,
  HOOK_STATUS,
  HOOK_EVENTS,
  NOTIFICATION_TYPE_STATUS,
  isHookNotificationType,
  type HookAgentEvent,
  type HookEvent,
  type HookStatusEvent,
  type HookTicketIntentEvent,
} from '@shared/hook-contract';
import {
  LEDGER_POST_PATH,
  LEDGER_READ_PATH,
  type LedgerPostRequest,
  type LedgerReadQuery,
  type LedgerResult,
  type LedgerSnapshot,
} from '@shared/ledger-contract';
import { keepNewest } from '@shared/ledger-derive';
import {
  METRICS_MAX_BODY_BYTES,
  METRICS_PATH,
  type SessionMetrics,
} from '@shared/metrics-contract';
import { sessionNameFromPrompt } from '@shared/session-contract';

import { parseMetrics } from './metrics';
import { ticketKeyFromPrompt } from './ticket-intent';

/**
 * The loopback endpoint Claude Code's hooks report session status to (HIVE-62).
 *
 * ## Why a socket at all
 *
 * Claude Code's hook system offers a `command` handler and an `http` handler.
 * `command` would mean shipping a helper script, resolving its path inside a
 * packaged app, and paying a process spawn per event per session — for events
 * that arrive several times per turn across a fleet of sessions. `http` is one
 * POST to a port the app already owns.
 *
 * ## Why that is safe
 *
 * A listening socket inside a desktop app deserves suspicion, so three things
 * are true of this one and are enforced below rather than documented:
 *
 * 1. It binds **`127.0.0.1`**, never `0.0.0.0` — unreachable from the network.
 * 2. It requires a **per-session token**, keyed off a per-launch secret that
 *    is generated at start and never leaves this file — not on the
 *    {@link Receiver} interface, not in an environment variable, not in the
 *    generated config, not in a log line. What a session is handed, and what
 *    the settings file and the environment of the PTYs it spawned carry, is
 *    {@link tokenFor} applied to that one session's own id (HIVE-112) — so a
 *    session that leaks its token hands over only its own identity, not
 *    every other session's.
 * 3. It answers a **closed set of six paths** — the hook event, the status
 *    line's metrics (HIVE-79), `/done`, the boot-ready signal, and, since
 *    HIVE-111, a ledger post and a ledger read — and reads a **capped body**
 *    on each, so nothing about it is a general-purpose server. Every path
 *    checks the token against the session header it was issued for; several
 *    carry a smaller cap than the hook path.
 *
 * Its authority is correspondingly wider than it once was: a valid POST can
 * still move a status dot or record usage percentages, but the ledger paths
 * let a known session id append to the shared log — post, ask, answer, claim,
 * release, done, failed, event, handoff — and read it back. `from` is always
 * the caller's own session header, never a value the body supplies, and
 * `Ledger.append` (`electron/main/ledger/index.ts`) is the one place that
 * decides what a party may write; this file only authenticates the caller and
 * forwards. There is still no command surface here to reach.
 *
 * ## Why a failure to bind is not an error
 *
 * A machine that refuses the bind — a sandbox, a hostile firewall, a port
 * exhaustion — must still be able to run sessions. Status falls back to
 * `activity.ts`'s pty inference, which is what shipped before this story. A
 * session never fails to start because status reporting is unavailable.
 */

export interface ReceiverOptions {
  /** Called for each valid, correlated hook event. */
  onEvent: (event: HookStatusEvent) => void;
  /**
   * A prompt named a ticket the user intends to work on (HIVE-78).
   *
   * A separate callback rather than a field on {@link HookStatusEvent}, for the
   * reason `onCleared` is separate: this is not a status. `UserPromptSubmit`
   * always means `working` and only sometimes carries an intent, so folding the
   * two would put an optional key on every tick of the busiest event here.
   */
  onTicketIntent: (event: HookTicketIntentEvent) => void;
  /**
   * A name derived from the session's **first** prompt (first-prompt naming).
   *
   * Separate from {@link onTicketIntent} even though both read the same event,
   * because they answer different questions and disagree on purpose: a ticket
   * association demands work intent around the key ("work on ABC-123" claims it,
   * "the PR for ABC-123 broke CI" does not), while a *name* takes any key it can
   * see. Folding them together would force one rule to serve both, and the
   * stricter rule would leave most sessions unnamed to avoid a harm a label
   * cannot do.
   *
   * Fired **at most once per conversation** — see the first-prompt set in
   * `createReceiver`. Nothing here forwards the prompt itself; the derivation
   * happens in this process and only the resulting name leaves it.
   */
  onPromptName: (entityId: string, name: string) => void;
  /**
   * The session's conversation ended by `/clear`, and its pty is still running.
   *
   * A separate callback rather than a widened {@link HookStatusEvent}, because
   * this is not a status: nothing about the agent's moment-to-moment state
   * changed, a boundary was crossed. Conflating the two is what made the first
   * version of `SessionEnd` handling lock users out of live sessions.
   */
  onCleared: (entityId: string) => void;
  /**
   * A session reported its context and rate-limit usage (HIVE-79).
   *
   * Arrives on a second path from Claude Code's status line rather than from a
   * hook — see `metrics-contract.ts`. A separate callback for the reason
   * `onTicketIntent` is one: it is not a status, and folding it in would put an
   * optional payload on every tick of the busiest event here.
   */
  onMetrics: (entityId: string, metrics: SessionMetrics) => void;
  /**
   * The session declared itself finished — `/done` (HIVE-93).
   *
   * A separate callback for the reason every other one here is separate, and
   * more so: this is not an observation at all. Every other path in this file
   * reports something Claude Code saw; this one reports something a *person*
   * decided, either by typing `/done` or by writing a skill that hands off to
   * it. It is the only input the app has that can honestly produce `done`.
   */
  onDone: (entityId: string) => void;
  /**
   * Claude is up — the shell has finished whatever it was doing (HIVE-101).
   *
   * Arrives from a `SessionStart` **command** hook, because the http one on
   * that event does not arrive; see `readyCommand`. Like `onDone` it carries no
   * payload: the request itself is the message.
   *
   * Fires at most usefully once, but is **not** guaranteed to fire once. A
   * `/clear` starts a new Claude session inside the same pty and produces
   * another `SessionStart`, so the handler on the other side has to be
   * idempotent — a session that is already up cannot become more up.
   */
  onReady: (entityId: string) => void;
  /**
   * A party asked to read the ledger (HIVE-111).
   *
   * `caller` is the session id off `x-hive-session`, never the body — the same
   * discipline `onLedgerPost` follows and for the same reason.
   */
  onLedgerRead: (caller: string, query: LedgerReadQuery) => LedgerSnapshot;
  /**
   * A party asked to append to the ledger (HIVE-111).
   *
   * `request` has already had any `from` in the body stripped by
   * {@link parseLedgerPostBody} — the caller supplies it from the header.
   */
  onLedgerPost: (
    caller: string,
    request: Omit<LedgerPostRequest, 'from'>,
  ) => LedgerResult;
  /** Whether an entity id is a session this app actually has. */
  knowsSession: (entityId: string) => boolean;
  /**
   * Whether an entity id is an **agent** this app has a definition for
   * (HIVE-115).
   *
   * Separate from {@link ReceiverOptions.knowsSession} rather than folded into
   * it. An agent and a session are disjoint id spaces, and the difference has
   * consequences downstream: an agent must not produce a `session:status` push
   * and must not reach the session history. Keeping the two questions apart is
   * what makes that a matter of which callback matched, rather than a branch
   * somewhere later that a future story can forget to write.
   *
   * Nothing about the token changes for it: a token is
   * `HMAC(launchSecret, entityId)` and an agent name is a legal entity id, so
   * the only thing that ever stood between an agent's `Stop` and this receiver
   * was the question this answers.
   */
  knowsAgent: (entityId: string) => boolean;
  /**
   * A hook event from an agent's headless turn (HIVE-115).
   *
   * The agent-space twin of {@link ReceiverOptions.onEvent}, and deliberately
   * not the same callback. What a session's event goes on to do — move a
   * status dot, write a history record, close a `/done` — is meaningless for a
   * name with no pty behind it, and *harmful* for it: a `session:status` push
   * for an id the fleet has never heard of is a row the user cannot explain.
   * With two callbacks the guarantee is structural. There is no path from an
   * agent's POST to `onEvent`, so there is none to any of that either.
   */
  onAgentEvent: (event: HookAgentEvent) => void;
  /** Overridable for tests; `0` asks the OS for any free port. */
  port?: number;
}

export interface Receiver {
  /**
   * Bind and start serving. Resolves to the URL, or `null` if the bind failed.
   *
   * Never rejects: see the note above on why a failure here is not fatal.
   */
  start(): Promise<string | null>;
  /**
   * The token a session named `entityId` must present (HIVE-112).
   *
   * A keyed derivation — `HMAC-SHA256(launchSecret, entityId)`, hex — of a
   * secret that is minted once per receiver and never leaves this module: it
   * is not a field here, not an environment variable, not written to the
   * generated config, not logged. Two calls with the same `entityId` on the
   * same receiver always agree, which is what lets `reject` recompute the
   * expected token from a request's own session header instead of looking one
   * up in a map — there is no map, so there is nothing to grow or evict as
   * sessions come and go.
   */
  tokenFor(entityId: string): string;
  /** The URL hooks should POST to, or `null` before a successful start. */
  readonly url: string | null;
  /**
   * The URL the injected status line POSTs usage to, or `null` (HIVE-79).
   *
   * Same socket and same token as {@link Receiver.url}; a different path
   * because the bodies are unrelated shapes.
   */
  readonly metricsUrl: string | null;
  /**
   * The URL `/done`'s body POSTs to, or `null` (HIVE-93).
   *
   * Same socket and same token as {@link Receiver.url}. Read by the skills
   * runtime, which bakes it into the generated skill exactly as the status line
   * script bakes {@link Receiver.metricsUrl} — see `skills/done-skill.ts` for
   * why that beats a third environment variable.
   */
  readonly doneUrl: string | null;
  /**
   * Where a starting session reports that Claude is up (HIVE-101).
   *
   * Same socket and same token as {@link Receiver.url}. Baked into the
   * generated settings file's `SessionStart` command hook, the way
   * {@link Receiver.metricsUrl} is baked into the status line script — a
   * session is handed the URL it should call rather than being told to
   * discover one.
   */
  readonly readyUrl: string | null;
  /**
   * The scheme and authority alone, or `null` before a successful start
   * (HIVE-112).
   *
   * Every other URL on this interface is a *path* — `url` is `origin +
   * HOOK_PATH`, and the same shape holds for `metricsUrl`, `doneUrl` and
   * `readyUrl` — because each names one fixed route this receiver serves and
   * the caller that reads it never appends anything of its own.
   *
   * The MCP host is different: it is handed a base and builds its own
   * request paths from `@shared/ledger-contract` (`LEDGER_POST_PATH`,
   * `LEDGER_READ_PATH`), because a single client speaks to more than one
   * route. Handing it `url` instead would have it POST to
   * `…/hook/ledger/read`, a path this server never registers — so this is a
   * distinct field rather than a reuse of `url` with the last segment
   * trimmed off by a caller.
   */
  readonly origin: string | null;
  stop(): Promise<void>;
}

/** Whether a string is one of the events the app subscribes to. */
const isHookEvent = (value: unknown): value is HookEvent =>
  typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value);

/**
 * The ids of the background **shells** a payload reports still running
 * (HIVE-90).
 *
 * Returns `undefined` when the payload carried no `background_tasks` key at
 * all, and an array — possibly empty — when it did. That distinction is the
 * whole contract; see {@link HookStatusEvent.backgroundShells} for why an
 * observed empty list and a silent body must not collapse into each other.
 *
 * ## `background_tasks` is a union, and that is why `type` is filtered
 *
 * The name suggests one kind of thing and it is two. Measured against 2.1.245,
 * a session whose only background work is a **subagent**:
 *
 * ```
 * Stop  background_tasks: [
 *   { id: 'a1bb2b63ce60a4e1c', type: 'subagent', status: 'running',
 *     agent_type: 'general-purpose', description: '…' }
 * ]
 * ```
 *
 * — the same array a backgrounded `Bash` puts a `type: 'shell'` entry in. So
 * an unfiltered read makes a live subagent arrive as a background shell, and
 * a session that has reported `idle (agents)` since HIVE-83 starts reporting
 * `idle (script)` about an agent. Subagents are tracked from `SubagentStart` /
 * `SubagentStop`, which is both a finer signal and a *fresher* one: the same
 * measurement shows a subagent still listed as `running` in the
 * `background_tasks` of its own `SubagentStop`, because the list is a snapshot
 * taken before the stop is applied. Shells are the half with no such pair —
 * no hook fires when a backgrounded process dies — which is exactly why this
 * list is worth reading for them and not for agents.
 *
 * `status === 'running'` is filtered for the obvious reason, and an entry with
 * no string `id` is dropped because ids are the only part of an entry this app
 * keeps.
 *
 * **What the `type` filter costs:** a third kind of background task, added in
 * some later release, is dropped here and a session running one would report a
 * plain `idle`. That is a real risk and the honest reading of it is that the
 * union has one member this app already tracks better and one it needs; a
 * member that does not exist yet cannot be assigned to `script` — which is a
 * *shell* — without repeating the subagent mistake in the other direction.
 *
 * So it is dropped and **said out loud**: `onUnknownType` fires for a running
 * entry of a kind this app has no reading for, and `createReceiver` turns that
 * into one warning per kind per launch. Without it the only thing that could
 * ever notice is `hook-conformance.test.ts`, which needs a real binary and an
 * opt-in environment variable — a silent wrong `idle` is exactly the failure
 * HIVE-90 exists to remove, and it should not be able to come back quietly.
 */
function liveBackgroundShellIds(
  value: unknown,
  onUnknownType: (type: string) => void,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, type, status } = entry as {
      id?: unknown;
      type?: unknown;
      status?: unknown;
    };
    if (status !== 'running') continue;
    if (type !== 'shell') {
      /*
        `subagent` is a known member and tracked elsewhere, so it is dropped
        quietly. Anything else is news.
      */
      if (typeof type === 'string' && type !== '' && type !== 'subagent')
        onUnknownType(type);
      continue;
    }
    if (typeof id === 'string' && id !== '') ids.push(id);
  }
  return ids;
}

/**
 * What a handler may answer with.
 *
 * Every route before HIVE-111 replied with a bare status and nothing else, so
 * a `number` stays the whole answer for those. The ledger routes have to hand
 * back a snapshot, and a refusal has to hand back a reason a *model* can read —
 * so they return a body, and the union is what lets both shapes share one
 * dispatch.
 */
type Reply = number | { status: number; json: unknown };

interface Route {
  readonly path: string;
  /** Bytes buffered before the body is drained; see the `data` handler. */
  readonly cap: number;
  readonly handle: (
    headers: Record<string, string | string[] | undefined>,
    body: string,
    truncated: boolean,
  ) => Reply;
}

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Whether `caller` may see this ledger entry (HIVE-111 review finding 3).
 *
 * Applied to the *result* of `onLedgerRead`, independent of whatever the query
 * asked for — `to` stays usable as an ordinary filter a caller can narrow its
 * own view with, but naming another party in it must never widen what comes
 * back. `entry.to === undefined` is a broadcast; `entry.from === caller`
 * covers the asker reading its own thread, whose entries are addressed
 * `to: overmind` rather than to itself, so forcing `to === caller` upstream
 * would hide a party's own questions from it.
 *
 * Lives here, in the receiver, rather than in whatever implements
 * `onLedgerRead` — the caller's identity is known at this layer regardless of
 * how the ledger is wired in, so the guarantee holds no matter what the next
 * task does on the other side of that callback.
 */
const visibleTo = (caller: string, entry: { from: string; to?: string }): boolean =>
  entry.to === caller || entry.to === undefined || entry.from === caller;

export function createReceiver(options: ReceiverOptions): Receiver {
  const {
    onEvent,
    onTicketIntent,
    onPromptName,
    onCleared,
    onMetrics,
    onDone,
    onReady,
    onLedgerRead,
    onLedgerPost,
    knowsSession,
    knowsAgent,
    onAgentEvent,
    port = 0,
  } = options;

  /**
   * Background-task kinds already reported, so the warning is **once per kind
   * per receiver** rather than once per `Stop`.
   *
   * Per receiver rather than per module: a module-level set would make the
   * first test that triggers it silence every test after, which is the shape
   * of a fixture that passes for the wrong reason. It also keeps this file
   * free of mutable module state, which nothing else here has.
   */
  const warnedTaskTypes = new Set<string>();

  /**
   * Conversations whose first prompt has already been read.
   *
   * The whole point of naming from a prompt is that it is the **first** one: the
   * name should say why the session exists, not what it drifted onto by turn
   * 170. That is exactly the failure Claude's own `ai-title` has, so a rule that
   * re-derived on every prompt would reproduce it with extra steps.
   *
   * ## Keyed by the conversation, not by the session
   *
   * A session id outlives the conversations inside it, and the two boundaries
   * that start a new one look nothing like each other: `/clear` announces itself
   * with a `SessionEnd`, and a **restart** does not announce itself here at all —
   * main kills the pty and spawns a fresh `claude`, which no hook reports. Keyed
   * by entity id, a restarted session would carry the previous generation's mark
   * for the life of the process and never be named from a prompt again.
   *
   * Claude's own conversation id is the thing that actually changes at both
   * boundaries — a `/clear` and a restart each mint a new one — so it is the
   * honest key. The entity id is the fallback for a payload that carried no
   * `session_id`, and `SessionEnd{clear}` still clears that fallback, which is
   * the only case it can still matter for.
   *
   * Per receiver rather than per module, for the reason {@link warnedTaskTypes}
   * gives: module state would let one test silence the next.
   */
  const promptedSessions = new Set<string>();

  /**
   * What identifies the conversation a hook fired in, best available.
   *
   * The uuid is globally unique, so it needs no entity qualifier; the fallback
   * does, or two sessions with no uuid would share one mark.
   */
  const conversationKey = (entityId: string, sessionUuid: unknown): string =>
    typeof sessionUuid === 'string' && sessionUuid !== ''
      ? `uuid:${sessionUuid}`
      : `entity:${entityId}`;
  const noteUnknownTaskType = (type: string): void => {
    if (warnedTaskTypes.has(type)) return;
    warnedTaskTypes.add(type);
    console.warn(
      `[hive] ignoring an unrecognised background task type: ${type}.` +
        ' A session running one reports plain idle, with no "script" detail —' +
        ' see liveBackgroundShellIds in electron/main/hooks/receiver.ts.',
    );
  };

  /**
   * Minted once per receiver and never returned from this function — see the
   * {@link tokenFor} doc on {@link Receiver} for why. `randomUUID` is used here
   * only as a convenient source of high-entropy randomness, not because the
   * result is ever compared as a uuid.
   */
  const launchSecret = randomUUID();

  /** HMAC-SHA256(launchSecret, entityId), hex — see {@link Receiver.tokenFor}. */
  const tokenFor = (entityId: string): string =>
    createHmac('sha256', launchSecret).update(entityId).digest('hex');

  let server: Server | null = null;
  let url: string | null = null;
  /**
   * The scheme and authority, kept so {@link Receiver.metricsUrl} can name the
   * second path without re-deriving a port from a string it just built.
   */
  let origin: string | null = null;

  /**
   * Pull the event name out of a body too large to have been kept whole.
   *
   * `JSON.parse` cannot help on a truncated prefix, and the field is a fixed,
   * unambiguous shape near the front of every payload, so a direct match is
   * both sufficient and honest about what it is doing.
   */
  const EVENT_IN_PREFIX = /"hook_event_name"\s*:\s*"([A-Za-z]+)"/;

  /**
   * Same trick, same justification, for `SessionEnd`'s `reason`.
   *
   * It decides whether a `SessionEnd` means the conversation ended (`clear`) or
   * something this app leaves to the pty, so it has to survive a truncated body
   * exactly as the event name does.
   */
  const REASON_IN_PREFIX = /"reason"\s*:\s*"([a-z_]+)"/;

  /**
   * And again for `cwd`, which HIVE-78 reads to resolve the session's branch.
   *
   * A path is not a fixed vocabulary the way an event name is, so this is the
   * loosest of the three: everything up to the closing quote, refusing a value
   * that carries a backslash escape rather than trying to unescape it. On the
   * platforms this app runs on a project path contains no character JSON
   * escapes, so the refusal costs nothing real — and hand-rolling an unescaper
   * against a truncated body to save it would be the wrong trade.
   */
  const CWD_IN_PREFIX = /"cwd"\s*:\s*"([^"\\]*)"/;

  /**
   * And once more for `notification_type`, which decides what a `Notification`
   * means.
   *
   * A closed vocabulary like the event name, so the same fixed shape and the
   * same justification apply — and it has to survive truncation for a reason
   * the others do not share: a `Notification` payload carries the `message`
   * Claude would have shown, which is unbounded prose.
   */
  const NOTIFICATION_TYPE_IN_PREFIX = /"notification_type"\s*:\s*"([a-z_]+)"/;

  /**
   * And once more for `tool_name`, which HIVE-83 needs to keep a blocked
   * session from stranding on `waiting`.
   *
   * `tool_name` precedes `tool_input` on the wire, and `tool_input` is what
   * grows a body past `HOOK_MAX_BODY_BYTES` in the first place (a `Write` or
   * `Edit` carries the whole file there) — so `tool_name` always survives a
   * truncation that claims `tool_input` and everything after it, including
   * `tool_use_id`. A closed-enough vocabulary — `Bash`, `Write`,
   * `mcp__server__tool` — so word characters and underscores, same
   * conservatism as the other prefix regexes here.
   */
  const TOOL_NAME_IN_PREFIX = /"tool_name"\s*:\s*"([A-Za-z0-9_]+)"/;

  /**
   * And once more for `session_id`, which correlates an agent's `Stop` with the
   * run it belongs to (HIVE-115).
   *
   * A uuid is the narrowest vocabulary of any of these, so the shape is the
   * strictest: hex and hyphens only, which no truncated tail can half-satisfy.
   * It survives truncation on every payload measured — `session_id` is the
   * first key Claude Code writes — but the regex is here rather than assumed,
   * because dropping the uuid silently is exactly the failure this correlation
   * exists to prevent: a `Stop` with no uuid arms a watchdog against whatever
   * is live under that name, which after a fast turnaround is the *next* run.
   */
  const SESSION_ID_IN_PREFIX = /"session_id"\s*:\s*"([0-9a-fA-F-]+)"/;

  /**
   * Token, entity id, and "is this an identity this app still has".
   *
   * Shared by every path because they all need exactly this and in this order —
   * and because a second endpoint that checked two of the three would be the
   * kind of drift a reviewer has to notice rather than the compiler.
   *
   * "An identity this app has" is **two** registers since HIVE-115: the pty
   * sessions, and the agents `~/.hive/agents` holds a definition for. Both post
   * here, both authenticate identically — a token is
   * `HMAC(launchSecret, entityId)` and an agent name is a legal entity id — and
   * both are refused when the app has never heard of them. What differs is what
   * each may reach afterwards, which is {@link rejectUnlessSession}'s and the
   * hook route's business rather than this function's.
   *
   * Answers the status to return, or `null` when the request may proceed.
   */
  function reject(
    headers: Record<string, string | string[] | undefined>,
  ): number | null {
    const entityId = headers[HOOK_HEADER_SESSION];
    if (typeof entityId !== 'string' || entityId === '') return 400;

    /**
     * The presented token must be the one derived for *this* session id, not
     * merely a token this receiver minted for someone else (HIVE-112).
     *
     * Not a timing-safe comparison, and deliberately not: this is a derived
     * secret on a loopback socket, where an attacker able to time the
     * comparison is already running as this user and has no need to — the
     * thing being protected is one session's isolation from another's ledger
     * entries, not the socket as a whole, and timing leaks nothing an
     * on-machine attacker does not already have.
     */
    if (headers[HOOK_HEADER_TOKEN] !== tokenFor(entityId)) return 403;

    /**
     * An unknown identity is refused rather than remembered.
     *
     * Neither register outlives anything here: if the app has neither a pty nor
     * an agent definition under this name, the event is about something that
     * has already gone, and creating state for it would leak an entry per stale
     * hook forever.
     */
    if (!knowsSession(entityId) && !knowsAgent(entityId)) return 404;

    return null;
  }

  /**
   * {@link reject}, and then "and it must be a **session**" (HIVE-115).
   *
   * Three routes here are session-only in a way the hook route and the ledger
   * routes are not. `/metrics` reports a status line that `claude -p` never
   * runs; `/done` and `/ready` both end in a `session:*` push about a terminal
   * on the fleet. An agent has no terminal, so every one of those is either
   * inert or a row the user cannot account for — and "inert" is not a property
   * to rely on from over here, since it is enforced in `sessions/index.ts` and
   * could stop being true without this file noticing.
   *
   * A named layer rather than a line inside each handler, so that which id
   * space a route serves is visible at its first statement, and a route added
   * later has to choose one on purpose.
   */
  function rejectUnlessSession(
    headers: Record<string, string | string[] | undefined>,
  ): number | null {
    const refusal = reject(headers);
    if (refusal !== null) return refusal;

    // Narrowed by `reject`, which refused every non-string case above.
    return knowsSession(headers[HOOK_HEADER_SESSION] as string) ? null : 404;
  }

  /**
   * A status line reported (HIVE-79).
   *
   * Nothing like the hook path below, and the difference is the point: there is
   * no event vocabulary, no truncation recovery, and no prefix regex. A status
   * line payload is small, fixed and entirely scalar, so a body that did not
   * parse is simply a 400 — there is no partial reading of it worth having.
   */
  function handleMetrics(
    headers: Record<string, string | string[] | undefined>,
    body: string,
    truncated: boolean,
  ): number {
    const refusal = rejectUnlessSession(headers);
    if (refusal !== null) return refusal;

    /*
      A truncated status line body is not a payload this endpoint is for — see
      METRICS_MAX_BODY_BYTES. Answered 204 rather than 413 for the reason the
      hook path drains rather than refuses: the reply is visible in the user's
      session, and nothing the app does with these numbers is worth a red line
      in a terminal.
    */
    if (truncated) return 204;

    const metrics = parseMetrics(body);
    if (metrics === null) return 400;

    onMetrics(headers[HOOK_HEADER_SESSION] as string, metrics);
    return 204;
  }

  /**
   * A party read the log (HIVE-111).
   *
   * POST, not GET, and that is not an accident of taste: this server has never
   * parsed a query string and every route on it is POST-only. A read whose
   * arguments arrive as a JSON body needs no method routing and no parser, and
   * `LedgerReadQuery` crosses the wire as itself.
   */
  function handleLedgerRead(
    headers: Record<string, string | string[] | undefined>,
    body: string,
    truncated: boolean,
  ): Reply {
    const refusal = reject(headers);
    if (refusal !== null) return refusal;

    // Same discipline as the write route's own check, and the same reason:
    // the caller reading this is a model, and "413, over the transport cap"
    // is something it can act on. "400, unexpected end of JSON input" is not.
    if (truncated) {
      return { status: 413, json: { reason: `body exceeds ${HOOK_MAX_BODY_BYTES} bytes` } };
    }

    const caller = headers[HOOK_HEADER_SESSION] as string;
    let query: LedgerReadQuery;
    try {
      query = parseLedgerReadQuery(body === '' ? {} : JSON.parse(body));
    } catch (cause) {
      return { status: 400, json: { reason: describeCause(cause) } };
    }

    /*
      Queried with no limit, so nothing is trimmed before the caller's
      visibility is known. `onLedgerRead` (via `Ledger.read`) would otherwise
      take the newest `limit` entries over the *whole* ledger and hand back a
      set `visibleTo` then narrows — which can discard an entry addressed to
      this caller in favour of ones addressed elsewhere, with nothing to
      signal the truncation. The limit is applied below, after filtering,
      against what the caller can actually see.
    */
    const { limit, ...unbounded } = query;
    const snapshot = onLedgerRead(caller, unbounded);
    const visible: LedgerSnapshot = {
      // Identity-locked here rather than trusted from `onLedgerRead`, so a
      // query's own `to` can never widen what a caller is shown — see
      // `visibleTo`.
      entries: keepNewest(
        snapshot.entries.filter((entry) => visibleTo(caller, entry)),
        limit,
      ),
      openAsks: snapshot.openAsks.filter((entry) => visibleTo(caller, entry)),
      claims: snapshot.claims,
    };
    return { status: 200, json: visible };
  }

  /**
   * A party wrote to the log (HIVE-111).
   *
   * `from` is taken from the header and the body's is discarded by the guard —
   * a party cannot post as another party.
   */
  function handleLedgerPost(
    headers: Record<string, string | string[] | undefined>,
    body: string,
    truncated: boolean,
  ): Reply {
    const refusal = reject(headers);
    if (refusal !== null) return refusal;

    /*
      Refused, not drained. The hook path drains an oversized body because
      losing a `waiting` flag is worse than a silent truncation; here the
      caller is a tool waiting on a result, and a write it believes succeeded
      but that was quietly cut in half is the worse failure.
    */
    if (truncated) {
      return { status: 413, json: { reason: `body exceeds ${HOOK_MAX_BODY_BYTES} bytes` } };
    }

    const caller = headers[HOOK_HEADER_SESSION] as string;
    let request: Omit<LedgerPostRequest, 'from'>;
    try {
      request = parseLedgerPostBody(JSON.parse(body));
    } catch (cause) {
      return { status: 400, json: { reason: describeCause(cause) } };
    }

    const result = onLedgerPost(caller, request);
    if (!result.ok) return { status: result.status, json: { reason: result.reason } };
    return { status: 200, json: { id: result.id, ref: result.ref } };
  }

  /**
   * A session declared itself finished (HIVE-93).
   *
   * The shortest handler here by a wide margin, and that is the design rather
   * than an omission: there is no body to parse, no event vocabulary, and no
   * payload the app could disagree with. `reject` has already established that
   * the token is right, the entity id is well-formed, and the app still has
   * this session — which is the whole of what `/done` needs to be trusted.
   *
   * The **request itself is the message**. Everything the app does next — arm
   * the finish, write `/exit\r` at the end of the turn, record `done` rather
   * than `terminated` — is `sessions/index.ts`'s, because that is where the pty
   * lives. This file's job ends at "a real session said so".
   */
  function handleDone(
    headers: Record<string, string | string[] | undefined>,
  ): number {
    const refusal = rejectUnlessSession(headers);
    if (refusal !== null) return refusal;

    onDone(headers[HOOK_HEADER_SESSION] as string);
    return 204;
  }

  /**
   * Claude is up (HIVE-101).
   *
   * `handleDone`'s twin, and deliberately its equal in brevity: no body, no
   * event vocabulary, nothing to disagree with. `reject` has already proved the
   * token and that the app still has this session, which is the whole of what
   * this needs to be trusted.
   *
   * What the app does next — lift the boot overlay, stop the timeout — belongs
   * to the session layer. This file's job ends at "a real session said so".
   */
  function handleReady(
    headers: Record<string, string | string[] | undefined>,
  ): number {
    const refusal = rejectUnlessSession(headers);
    if (refusal !== null) return refusal;

    onReady(headers[HOOK_HEADER_SESSION] as string);
    return 204;
  }

  /**
   * A hook from an **agent's** headless turn (HIVE-115).
   *
   * Its own function rather than a flag inside {@link handle}, and that is the
   * whole of the story: the only callback reachable from here is
   * `onAgentEvent`. An agent therefore cannot produce a `session:status` push,
   * a session history record, a ticket rename or a `/clear` — not because
   * something downstream remembers to skip it, but because the code that would
   * do any of those is on a path this function never joins.
   *
   * It reads two fields where `handle` reads nine, which is honest rather than
   * lazy. Measured against `claude` 2.1.251, a `-p` run fires `SessionStart`,
   * `PreToolUse`, `PostToolUse`, `Stop` and `SubagentStop` — `Notification` and
   * `PermissionRequest` do not fire headless — and the only one the app acts on
   * today is `Stop`. The rest are accepted so the run does not print a hook
   * failure into its own log, and are carried no further until HIVE-116 has
   * somewhere to draw them. When it does, this is the one place that has to
   * learn a field, and it can learn it without touching the session path.
   */
  function handleAgent(
    entityId: string,
    body: string,
    truncated: boolean,
  ): number {
    let event: unknown;
    let sessionUuid: unknown;

    if (truncated) {
      // The prefix is all there is; see EVENT_IN_PREFIX and SESSION_ID_IN_PREFIX.
      event = EVENT_IN_PREFIX.exec(body)?.[1];
      sessionUuid = SESSION_ID_IN_PREFIX.exec(body)?.[1];
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return 400;
      }
      const fields =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { hook_event_name?: unknown; session_id?: unknown })
          : undefined;
      event = fields?.hook_event_name;
      sessionUuid = fields?.session_id;
    }

    // An event outside the subscribed set is a success, not an error — the
    // same reading the session path takes, and for the same reason.
    if (!isHookEvent(event)) return 204;

    /*
      `SessionEnd` leaves here with no callback at all. It is a lifecycle event
      about a conversation, and a run's lifecycle is the *process* — which
      `runs.ts` watches on 'close' and 'exit', where the exit code is. There is
      nothing this could add that is not already known more accurately a moment
      later, and `HOOK_STATUS` has no entry for it by construction.
    */
    if (event === 'SessionEnd') return 204;

    onAgentEvent({
      entityId,
      event,
      status: HOOK_STATUS[event],
      // Absent rather than empty when the payload did not carry one, the same
      // discipline every optional field on the session event follows.
      ...(typeof sessionUuid === 'string' && sessionUuid !== ''
        ? { sessionUuid }
        : {}),
    });
    return 204;
  }

  function handle(
    headers: Record<string, string | string[] | undefined>,
    body: string,
    truncated = false,
  ): number {
    const refusal = reject(headers);
    if (refusal !== null) return refusal;

    // Narrowed by `reject`, which refused every non-string case above.
    const entityId = headers[HOOK_HEADER_SESSION] as string;

    /**
     * The two id spaces part **here**, before a field of the payload is read
     * (HIVE-115).
     *
     * Everything below this line belongs to a session, and an agent's event has
     * already left on {@link handleAgent}. That is the guarantee, and it is
     * positional: there is no arrangement of the payload, no event name and no
     * later edit to the parsing below that can carry an agent-named event into
     * `onEvent`, `onTicketIntent` or `onCleared`.
     *
     * A session wins a collision. The registers are disjoint in practice —
     * `sess-07` is not a folder in `~/.hive/agents` — but were they ever not,
     * the session is the one with a pty, a status dot and a history record that
     * have to stay truthful.
     */
    if (!knowsSession(entityId) && knowsAgent(entityId)) {
      return handleAgent(entityId, body, truncated);
    }

    let event: unknown;
    let reason: unknown;
    let cwd: unknown;
    let notificationType: unknown;
    /**
     * Only ever set on a body that parsed whole.
     *
     * A truncated body means the payload was **larger than 64 KB**, and the
     * intent shapes this looks for are short opening phrases in short messages.
     * Recovering a prompt from a truncated prefix would mean matching against
     * text that has been cut at an arbitrary byte, in the one case where the
     * user pasted something enormous — the worst input for a shape test and the
     * least likely to be "work on ABC-123".
     */
    let prompt: unknown;
    let toolUseId: unknown;
    let toolName: unknown;
    let agentId: unknown;
    let runInBackground: unknown;
    let backgroundShells: string[] | undefined;
    /**
     * Claude's own id for the conversation this event fired in (first-prompt naming).
     *
     * Read on the session path as well as the agent one, because it is what
     * names the transcript — and unlike the uuid pinned at spawn it stays
     * correct across a `/clear`, which starts a *new* conversation in the same
     * pty under a uuid nothing told main about.
     */
    let sessionUuid: unknown;

    if (truncated) {
      // The prefix is all there is; see EVENT_IN_PREFIX.
      event = EVENT_IN_PREFIX.exec(body)?.[1];
      reason = REASON_IN_PREFIX.exec(body)?.[1];
      cwd = CWD_IN_PREFIX.exec(body)?.[1];
      notificationType = NOTIFICATION_TYPE_IN_PREFIX.exec(body)?.[1];
      toolName = TOOL_NAME_IN_PREFIX.exec(body)?.[1];
      sessionUuid = SESSION_ID_IN_PREFIX.exec(body)?.[1];
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return 400;
      }
      const fields =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as {
              hook_event_name?: unknown;
              reason?: unknown;
              cwd?: unknown;
              prompt?: unknown;
              notification_type?: unknown;
              tool_use_id?: unknown;
              tool_name?: unknown;
              agent_id?: unknown;
              tool_input?: { run_in_background?: unknown };
              background_tasks?: unknown;
              session_id?: unknown;
            })
          : undefined;
      event = fields?.hook_event_name;
      sessionUuid = fields?.session_id;
      reason = fields?.reason;
      cwd = fields?.cwd;
      prompt = fields?.prompt;
      notificationType = fields?.notification_type;
      toolUseId = fields?.tool_use_id;
      toolName = fields?.tool_name;
      agentId = fields?.agent_id;
      runInBackground = fields?.tool_input?.run_in_background;
      backgroundShells = liveBackgroundShellIds(
        fields?.background_tasks,
        noteUnknownTaskType,
      );
    }

    /**
     * An event outside the subscribed set is a success, not an error.
     *
     * Claude may deliver more than was asked for — a settings merge the user
     * made, a future default — and answering 4xx would print a hook failure in
     * their session for something the app simply does not care about.
     */
    if (!isHookEvent(event)) return 204;

    /**
     * `SessionEnd` is a lifecycle event and leaves here on its own channel.
     *
     * **Only `clear` is acted on.** `logout`, `prompt_input_exit` and `other`
     * all mean the process is going away, and the pty is the honest observer of
     * that — `activity.ts` reports `terminated` for hook-driven sessions too.
     * Acting on them here is the exact bug this event was withdrawn for once
     * already.
     */
    if (event === 'SessionEnd') {
      if (reason === CLEAR_REASON) {
        /*
          A cleared terminal is a fresh conversation, so its next prompt is a
          first prompt again. Only the entity-id fallback needs clearing: a
          `/clear` mints a new conversation id, so a uuid-keyed mark already
          belongs to the conversation that just ended and can never match the
          new one.
        */
        promptedSessions.delete(conversationKey(entityId, undefined));
        onCleared(entityId);
      }
      return 204;
    }

    /**
     * The intent goes out **before** the status (HIVE-78).
     *
     * Ordering, not taste. `onEvent` is what makes a session `working`, and a
     * renderer that learned the ticket second would briefly render the row
     * under its old identity — the visible flicker being precisely a rename, on
     * the frame the user pressed enter. Neither callback is allowed to throw
     * into the other's path, which is why the whole `handle` runs inside the
     * caller's try.
     */
    if (event === 'UserPromptSubmit') {
      if (typeof prompt === 'string') {
        const key = ticketKeyFromPrompt(prompt);
        if (key !== null) onTicketIntent({ entityId, key, source: 'prompt' });
      }

      /**
       * The first prompt names the session.
       *
       * ## Marked on the event, not on the text
       *
       * Marked as seen whether or not a name came out of it, and whether or not
       * the text was even readable. A greeting is still the first prompt, and so
       * is a 256 KB paste whose body truncated past `prompt` — re-reading until
       * some prompt happened to be nameable is "name from whatever prompt looks
       * nameable", which is the defect wearing the fix's clothes. The row waits
       * for Claude's title instead, exactly as it did before.
       *
       * That is why the mark is taken on `UserPromptSubmit` itself rather than
       * inside the `typeof prompt === 'string'` branch above: a truncated first
       * prompt left the mark unset, and the *second* prompt then named the
       * session — the late-prompt defect, reintroduced by an edge case.
       */
      const conversation = conversationKey(entityId, sessionUuid);
      if (!promptedSessions.has(conversation)) {
        promptedSessions.add(conversation);
        const name = typeof prompt === 'string' ? sessionNameFromPrompt(prompt) : undefined;
        if (name !== undefined) onPromptName(entityId, name);
      }
    }

    /**
     * A `Notification` is the one event whose status is not a property of the
     * event.
     *
     * An **unrecognised** type is answered 204 and published as nothing, which
     * is the same treatment an unsubscribed event gets and for the same reason:
     * Claude raises notifications this app has no reading of — an auth prompt,
     * something added in a later release — and moving a session to `waiting` on
     * one would put a dot on the rail that no amount of looking at the terminal
     * explains. The vocabulary is closed here so that a new member is a decision
     * someone makes, not a guess this code makes on their behalf.
     */
    if (event === 'Notification') {
      if (!isHookNotificationType(notificationType)) return 204;

      onEvent({
        entityId,
        event,
        status: NOTIFICATION_TYPE_STATUS[notificationType],
        notificationType,
        ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
      ...(typeof sessionUuid === 'string' && sessionUuid !== '' ? { sessionUuid } : {}),
      });
      return 204;
    }

    onEvent({
      entityId,
      event,
      status: HOOK_STATUS[event],
      ...(typeof sessionUuid === 'string' && sessionUuid !== '' ? { sessionUuid } : {}),
      /**
       * Absent rather than empty when the payload did not carry one. The
       * session layer treats absence as "nothing to look at on this tick",
       * which is the honest reading — an empty string would be a directory.
       */
      ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
      ...(typeof toolUseId === 'string' ? { toolUseId } : {}),
      ...(typeof toolName === 'string' ? { toolName } : {}),
      ...(typeof agentId === 'string' && agentId !== '' ? { agentId } : {}),
      ...(runInBackground === true ? { runInBackground: true } : {}),
      ...(backgroundShells === undefined ? {} : { backgroundShells }),
    });
    return 204;
  }

  return {
    tokenFor,

    get url() {
      return url;
    },

    get origin() {
      return origin;
    },

    get metricsUrl() {
      return origin === null ? null : `${origin}${METRICS_PATH}`;
    },

    get doneUrl() {
      return origin === null ? null : `${origin}${DONE_PATH}`;
    },

    get readyUrl() {
      return origin === null ? null : `${origin}${READY_PATH}`;
    },

    start() {
      return new Promise<string | null>((resolve) => {
        /*
          Six paths now, and still nothing resembling a general-purpose server:
          the set is closed, every one of them is POST-only, and each has its
          own body cap sized to the document it expects. A request that is none
          of them is 404 without reading a byte.
        */
        const routes: readonly Route[] = [
          { path: HOOK_PATH, cap: HOOK_MAX_BODY_BYTES, handle },
          { path: METRICS_PATH, cap: METRICS_MAX_BODY_BYTES, handle: handleMetrics },
          /*
            `/done` and `/ready` expect no body at all, so their cap is zero:
            the first byte of one marks the request truncated and every byte
            after it is dropped on the floor. Neither handler reads it, so a
            caller that sends something anyway is answered normally rather than
            refused — the same "drain, do not refuse" discipline the hook path
            takes, for the same reason. Nothing a session sends here should be
            able to produce a red line in the user's terminal.
          */
          { path: DONE_PATH, cap: 0, handle: (headers) => handleDone(headers) },
          { path: READY_PATH, cap: 0, handle: (headers) => handleReady(headers) },
          { path: LEDGER_POST_PATH, cap: HOOK_MAX_BODY_BYTES, handle: handleLedgerPost },
          { path: LEDGER_READ_PATH, cap: HOOK_MAX_BODY_BYTES, handle: handleLedgerRead },
        ];

        const created = createServer((req, res) => {
          const route = routes.find((candidate) => candidate.path === (req.url ?? ''));
          if (req.method !== 'POST' || route === undefined) {
            res.writeHead(404).end();
            return;
          }
          const cap = route.cap;

          let body = '';
          let bytes = 0;
          let truncated = false;
          /**
           * One decoder for the whole request, not `chunk.toString('utf8')`
           * per chunk.
           *
           * A TCP chunk boundary falls wherever the kernel put it, which can
           * be in the middle of a multi-byte character. Decoding each chunk on
           * its own turns that one character into two replacement characters,
           * one at the end of a chunk and one at the start of the next. That
           * was survivable while the only field ever read here was an ASCII
           * `hook_event_name` in the first few hundred bytes; a ledger body is
           * up to 16 KB of agent-written markdown that is appended to a file
           * nothing ever edits, so the corruption would be permanent.
           * `StringDecoder` holds the partial sequence back until the bytes
           * that complete it arrive.
           */
          const decoder = new StringDecoder('utf8');

          req.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            /**
             * Past the cap the body is **drained, not refused** — on every
             * route but the ledger's write, which refuses instead; see
             * `handleLedgerPost`.
             *
             * Refusing with 413 was wrong in the one case that matters most.
             * A `PermissionRequest` carries `tool_input`, which for a Write or
             * an Edit is a whole file — so the biggest payloads belong to
             * exactly the event that produces `waiting`, the state the entire
             * attention model exists for. Rejecting it meant a large edit never
             * raised the flag and printed a hook failure in the user's session
             * instead.
             *
             * Only `hook_event_name` is ever read, and it sits in the first few
             * hundred bytes, so the prefix is kept and the rest is discarded as
             * it arrives. The heap cost is the cap, not the payload.
             */
            if (bytes > cap) {
              truncated = true;
              return;
            }
            body += decoder.write(chunk);
          });

          req.on('end', () => {
            // Flushes a trailing incomplete sequence, if the body ended
            // mid-character, as a single replacement character rather than
            // dropping it.
            body += decoder.end();
            let reply: Reply;
            try {
              reply = route.handle(req.headers, body, truncated);
            } catch {
              /**
               * A throw here must not take the app down. An uncaught exception
               * in a request handler is an `uncaughtException` on the main
               * process, which would turn a malformed hook into a crashed
               * desktop app.
               */
              reply = 500;
            }
            if (typeof reply === 'number') {
              res.writeHead(reply).end();
              return;
            }
            res
              .writeHead(reply.status, { 'content-type': 'application/json' })
              .end(JSON.stringify(reply.json));
          });
        });

        created.on('error', () => {
          /**
           * Only a *bind* failure clears the handles.
           *
           * `error` also fires on a live server, and clearing `server` there
           * would leave `stop()` with nothing to close and the socket listening
           * for the rest of the process's life. `resolve` is idempotent, so a
           * later error simply does nothing.
           */
          if (server === null) {
            url = null;
            origin = null;
            resolve(null);
          }
        });

        created.listen(port, '127.0.0.1', () => {
          const address = created.address();
          if (address === null || typeof address === 'string') {
            resolve(null);
            return;
          }
          server = created;
          origin = `http://127.0.0.1:${address.port}`;
          url = `${origin}${HOOK_PATH}`;
          resolve(url);
        });
      });
    },

    stop() {
      return new Promise<void>((resolve) => {
        const running = server;
        if (running === null) {
          resolve();
          return;
        }
        server = null;
        url = null;
        origin = null;
        running.close(() => resolve());
        /**
         * Keep-alive sockets would otherwise hold the close open past app quit.
         * Hooks are one-shot POSTs, so nothing is lost by dropping them.
         */
        running.closeAllConnections?.();
      });
    },
  };
}
