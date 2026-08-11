import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import {
  CLEAR_REASON,
  HOOK_HEADER_SESSION,
  HOOK_HEADER_TOKEN,
  HOOK_MAX_BODY_BYTES,
  HOOK_PATH,
  HOOK_STATUS,
  HOOK_EVENTS,
  NOTIFICATION_TYPE_STATUS,
  isHookNotificationType,
  type HookEvent,
  type HookStatusEvent,
  type HookTicketIntentEvent,
} from '@shared/hook-contract';

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
 * 2. It requires a **per-launch token**, generated at start and never written
 *    anywhere but the settings file the app itself wrote and the environment of
 *    the PTYs it spawned. A token that leaks dies with the app.
 * 3. It answers **one path** and reads a **capped body**, so nothing about it is
 *    a general-purpose server.
 *
 * It also has no authority: the only thing a valid POST can do is move a status
 * dot for a session id that is already known. There is no command surface here
 * to reach.
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
   * The session's conversation ended by `/clear`, and its pty is still running.
   *
   * A separate callback rather than a widened {@link HookStatusEvent}, because
   * this is not a status: nothing about the agent's moment-to-moment state
   * changed, a boundary was crossed. Conflating the two is what made the first
   * version of `SessionEnd` handling lock users out of live sessions.
   */
  onCleared: (entityId: string) => void;
  /** Whether an entity id is a session this app actually has. */
  knowsSession: (entityId: string) => boolean;
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
  /** The per-launch shared secret. Stable for the lifetime of the receiver. */
  readonly token: string;
  /** The URL hooks should POST to, or `null` before a successful start. */
  readonly url: string | null;
  stop(): Promise<void>;
}

/** Whether a string is one of the events the app subscribes to. */
const isHookEvent = (value: unknown): value is HookEvent =>
  typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value);

export function createReceiver(options: ReceiverOptions): Receiver {
  const { onEvent, onTicketIntent, onCleared, knowsSession, port = 0 } = options;

  const token = randomUUID();
  let server: Server | null = null;
  let url: string | null = null;

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

  function handle(
    headers: Record<string, string | string[] | undefined>,
    body: string,
    truncated = false,
  ): number {
    /**
     * Compared before anything else is read.
     *
     * Not a timing-safe comparison, and deliberately not: the secret is a v4
     * uuid on a loopback socket, where an attacker able to time it is already
     * running as this user and has no need of it.
     */
    if (headers[HOOK_HEADER_TOKEN] !== token) return 403;

    const entityId = headers[HOOK_HEADER_SESSION];
    if (typeof entityId !== 'string' || entityId === '') return 400;

    /**
     * An unknown session is refused rather than remembered.
     *
     * Sessions outlive nothing here: if the app does not have this entity, the
     * event is about a pty that has already gone, and creating state for it
     * would leak an entry per stale hook forever.
     */
    if (!knowsSession(entityId)) return 404;

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

    if (truncated) {
      // The prefix is all there is; see EVENT_IN_PREFIX.
      event = EVENT_IN_PREFIX.exec(body)?.[1];
      reason = REASON_IN_PREFIX.exec(body)?.[1];
      cwd = CWD_IN_PREFIX.exec(body)?.[1];
      notificationType = NOTIFICATION_TYPE_IN_PREFIX.exec(body)?.[1];
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
            })
          : undefined;
      event = fields?.hook_event_name;
      reason = fields?.reason;
      cwd = fields?.cwd;
      prompt = fields?.prompt;
      notificationType = fields?.notification_type;
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
      if (reason === CLEAR_REASON) onCleared(entityId);
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
    if (event === 'UserPromptSubmit' && typeof prompt === 'string') {
      const key = ticketKeyFromPrompt(prompt);
      if (key !== null) onTicketIntent({ entityId, key });
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
      });
      return 204;
    }

    onEvent({
      entityId,
      event,
      status: HOOK_STATUS[event],
      /**
       * Absent rather than empty when the payload did not carry one. The
       * session layer treats absence as "nothing to look at on this tick",
       * which is the honest reading — an empty string would be a directory.
       */
      ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
    });
    return 204;
  }

  return {
    token,

    get url() {
      return url;
    },

    start() {
      return new Promise<string | null>((resolve) => {
        const created = createServer((req, res) => {
          if (req.method !== 'POST' || (req.url ?? '') !== HOOK_PATH) {
            res.writeHead(404).end();
            return;
          }

          let body = '';
          let bytes = 0;
          let truncated = false;

          req.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            /**
             * Past the cap the body is **drained, not refused**.
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
            if (bytes > HOOK_MAX_BODY_BYTES) {
              truncated = true;
              return;
            }
            body += chunk.toString('utf8');
          });

          req.on('end', () => {
            let status: number;
            try {
              status = handle(req.headers, body, truncated);
            } catch {
              /**
               * A throw here must not take the app down. An uncaught exception
               * in a request handler is an `uncaughtException` on the main
               * process, which would turn a malformed hook into a crashed
               * desktop app.
               */
              status = 500;
            }
            res.writeHead(status).end();
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
          url = `http://127.0.0.1:${address.port}${HOOK_PATH}`;
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
