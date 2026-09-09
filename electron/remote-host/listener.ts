import { createServer, type Server } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import type { ServerBindConfig, ServerDevice } from '@shared/config-contract';
import type { Channel } from '@shared/ipc-contract';
import {
  ATTACH_FRAME_MAX_BYTES,
  CALL_DEADLINE_MS,
  CALL_TIMEOUT_CODE,
  POST_ATTACH_FRAME_MAX_BYTES,
  REMOTE_PROTOCOL_VERSION,
  type AttachRefused,
  type AttachRequest,
  type CallFrame,
  type NotifyFrame,
  type ResumePoint,
  type ServerFrame,
} from '@shared/remote-contract';

import { describe } from '../main/config/paths';
import { createOriginGuard } from '../main/hooks/http-guard';
import type { RemoteDispatch } from '../main/ipc/remote-dispatch';
import type { AttachedSurface } from '../main/ipc/surfaces';
import { verifyDevice } from '../main/server/devices';

import { refuseProtocol } from './index';

/**
 * The listener half of server mode: a second `node:http` server, bound to
 * `server.bind`, that accepts a `ws` upgrade, completes the attach handshake
 * (HIVE-142), and — once attached — routes every `call` and `notify` frame
 * to the `dispatch` it was given and reports the socket's lifetime through
 * `onAttach`/`onDetach` (HIVE-143).
 *
 * **Scope, stated so the next story does not creep backward into this one.**
 * `dispatch`, `onAttach` and `onDetach` are injected, not imported — this
 * file still does not import `electron/main/ipc/index.ts`, which is what
 * constructs all three and wires this listener up. What crosses a channel and
 * what a device is authorized to do live in `electron/main/ipc/remote-dispatch.ts`;
 * this file only gets frames to and from the socket that carries them.
 *
 * **Everything below the guard is untrusted input, and stays untrusted until
 * `verifyDevice` says otherwise (HIVE-142 review).** The Origin/Host guard
 * proves a caller's *browser* is one this app would talk to; it proves
 * nothing about the bytes on the wire once the TCP handshake completes. A
 * peer that clears the guard can still send an unmasked frame, a frame with
 * no upper bound on size, or a first frame that is not shaped like an
 * `AttachRequest` at all — and until `verifyDevice` returns `'ok'`, that peer
 * has proven nothing else about itself. Every branch in the `'connection'`
 * handler below exists because the first review of this file treated
 * "reached `handleUpgrade`" as if it meant "trusted", which it does not.
 *
 * **The residual aggregate exposure, stated rather than implied (HIVE-143
 * review).** An unauthenticated peer that clears the Origin/Host guard — which
 * is header-based, so a non-browser client satisfies it trivially, and
 * `server.bind.host` may be a LAN or tailnet address rather than loopback —
 * can make this process buffer up to
 * {@link MAX_UNATTACHED_SOCKETS} × {@link POST_ATTACH_FRAME_MAX_BYTES}, because
 * `ws` builds each connection's `Receiver` at connection time and the
 * post-attach ceiling therefore governs from the first byte, before
 * {@link ATTACH_FRAME_MAX_BYTES} is ever checked. That is 64 MiB, transient:
 * each of those sockets is dropped by {@link ATTACH_HANDSHAKE_TIMEOUT_MS} if it
 * has not attached, and no further one is accepted while the cap is full. It is
 * bounded in aggregate and not merely per socket, which is the part the
 * previous version of this comment got wrong.
 */

/**
 * How long an upgraded socket has to send its attach frame before it is
 * dropped.
 *
 * A real attach frame is a few hundred bytes and arrives within milliseconds
 * of the socket opening; a few seconds is already generous slack for a slow
 * network. Without a deadline, a peer that clears the Origin/Host guard and
 * then sends nothing holds the socket — and the fd and memory behind it —
 * open forever, which on a Tailscale-reachable listener is a standing
 * exhaustion path rather than a hypothetical one.
 *
 * **Exported so `tests/electron/remote-host/listener.test.ts` can assert
 * {@link SNAPSHOT_READ_BUDGET_MS} stays comfortably under it (HIVE-144
 * review)**, reading both real values directly rather than trusting the two
 * comments to stay in agreement on their own.
 */
export const ATTACH_HANDSHAKE_TIMEOUT_MS = 5_000;

/**
 * How long a single `SNAPSHOT_CHANNELS` read may take before its key is
 * dropped from the attach snapshot — exactly as a throwing read already is
 * (Ruling 15, extended by HIVE-144 review: a slow read is dropped the same
 * way a broken one is, because a client waiting on it cannot tell the two
 * apart).
 *
 * **Beside `ATTACH_HANDSHAKE_TIMEOUT_MS` rather than in
 * `electron/shared/remote-contract.ts` (HIVE-144 review, second correction).**
 * `electron/shared/**` is for what *both halves of the link* have to agree
 * on; this number governs only how long the server spends building a
 * snapshot before the client ever sees a frame, exactly the same server-only
 * shape `ATTACH_HANDSHAKE_TIMEOUT_MS` and `MAX_UNATTACHED_SOCKETS` already
 * are (see `POST_ATTACH_FRAME_MAX_BYTES`'s own comment in `remote-contract.ts`
 * for why *that* one, unlike these, had to move the other way). Having to
 * export `ATTACH_HANDSHAKE_TIMEOUT_MS` out of this file for a constant that
 * belonged next to it was the signal this one was living in the wrong file.
 *
 * **A sibling of `ATTACH_HANDSHAKE_TIMEOUT_MS`**, in the sense `CALL_DEADLINE_MS`
 * and `CALL_GIVE_UP_MS` (`electron/shared/remote-contract.ts`) are siblings:
 * the two numbers have to agree, or the server can time out a socket while a
 * read it has not yet given up on is still running. `buildAttachSnapshot`
 * (`electron/main/ipc/index.ts`) races every channel **concurrently** against
 * this one budget rather than sequentially against six of them, so the whole
 * snapshot's wall-clock cost is bounded by this single number regardless of
 * how many of the six are slow at once — a sequential sum could exceed the
 * handshake window on its own even with a "safe" per-channel value. 2 000 ms
 * leaves 3 000 ms of margin inside the 5 000 ms deadline above for everything
 * else the handshake still has to do before and after this read
 * (`verifyDevice`, `fitSnapshot`, the `send` itself) — comfortable rather than
 * exact, and the margin is asserted directly by
 * `tests/electron/remote-host/listener.test.ts` rather than left to this
 * comment staying true.
 *
 * **Why a per-channel try/catch alone was not enough (HIVE-144 review).**
 * `CH.githubPrs`'s handler awaits `loginEnvStatus()` and shells out to `gh`,
 * whose own runner timeout (`electron/main/integrations/github/run.ts`) is
 * 20 000 ms — four times the whole handshake window on its own — and it
 * *resolves* with an error result rather than rejecting, so nothing throws
 * for a catch to see. Unbounded, that read alone holds the whole snapshot
 * open past `ATTACH_HANDSHAKE_TIMEOUT_MS`, and the socket is closed with zero
 * frames sent: no accept, no refusal, just the generic "closed before it
 * attached" a version mismatch produces — the exact failure Ruling 15 exists
 * to prevent, reached through latency instead of size.
 */
export const SNAPSHOT_READ_BUDGET_MS = 2_000;

/**
 * How many sockets may be mid-handshake — upgraded, but not yet attached — at
 * once (HIVE-143 review).
 *
 * {@link ATTACH_HANDSHAKE_TIMEOUT_MS} bounds what *one* unauthenticated socket
 * costs; nothing bounded how many of them there could be, so the aggregate was
 * unbounded and the timeout's docblock claiming otherwise was reading a
 * per-socket number as a total. A peer that can reach the port opens sockets in
 * a loop and each one arms a `Receiver` willing to buffer
 * {@link POST_ATTACH_FRAME_MAX_BYTES} before anything in this file gets to look
 * at a byte of it.
 *
 * Eight, because it is an order of magnitude above the real peak and still a
 * small number of megabytes. Server mode serves *this user's* paired devices —
 * a laptop and a phone is the shape of it — and a device holds exactly one
 * socket, unattached only for the milliseconds between the upgrade and its
 * attach frame. Even a tailnet coming back up after a flap reconnects one
 * socket per device, not eight; a ninth concurrent *unattached* socket is
 * already a client bug or an attacker, and either is better refused than
 * buffered for.
 *
 * Counted before attach only. An attached socket has proven a device
 * credential, is tracked by `onAttach`/`onDetach`, and is subject to whatever
 * `CHANNEL_AUTHORIZATION` allows it — this cap exists for the phase where none
 * of that is true yet, and counting attached sockets against it would cap how
 * many devices may be *paired and connected*, which is a different question
 * with a different right answer.
 */
const MAX_UNATTACHED_SOCKETS = 8;

/**
 * How many bytes a `ws` message actually is, across the three shapes `ws` can
 * hand a `'message'` listener.
 *
 * Measured on the raw data rather than on `String(data).length`, because those
 * are different numbers: the wire carries UTF-8 and a JS string is counted in
 * UTF-16 code units, so a frame of multi-byte text would be under-counted by
 * the very check meant to bound it.
 */
function frameByteLength(data: Buffer | ArrayBuffer | Buffer[]): number {
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.byteLength, 0);
  return data.byteLength;
}

export interface RemoteListener {
  /** Starts listening. Resolves the bound address, or `null` on bind failure. */
  start: () => Promise<string | null>;
  /** Closes the socket. Resolves once it is actually closed. */
  stop: () => Promise<void>;
  /** What the kernel actually bound to, or `null` before `start` / after `stop`. */
  readonly boundHost: string | null;
  /**
   * Why the most recent `start()` failed to bind, or `null` when bound or
   * never tried (HIVE-142 review, I3). A port already in use, or a
   * `bind.host` that does not yet resolve to a local interface — Tailscale
   * not up yet, most likely on this deployment — both leave `boundHost` at
   * `null` with no way to tell "still starting" from "gave up"; this is
   * that difference, for the tray to show rather than swallow.
   */
  readonly lastBindError: string | null;
}

/**
 * Formats `host`:`port` for the `ws://` URL `start()` resolves.
 *
 * `bind.host` is validated elsewhere to exclude an IPv6 literal today (see
 * `isServerBindHost`), but this function does not get to assume its caller
 * never changes — a bare `::1` interpolated unbracketed produces
 * `ws://::1:54321`, which is not a parseable authority. Bracketing whenever
 * the host contains a colon is correct for both literal families and costs
 * nothing when it is not needed.
 */
function wsUrl(host: string, port: number): string {
  const authority = host.includes(':') ? `[${host}]` : host;
  return `ws://${authority}:${String(port)}`;
}

/**
 * Whether `value` is a {@link ResumePoint} — `{ gen, seq }`, both finite
 * non-negative integers.
 *
 * Neither may be negative or fractional: both are counters this file's peers
 * only ever increment, and a negative or fractional one could only mean a
 * malformed or hostile client, not an honest one that ran out of range.
 *
 * A bare number — the whole shape of a v1 client's `resumeFrom` value — is
 * rejected here rather than coerced into `{ gen: <that number>, seq: 0 }` or
 * similar: `REMOTE_PROTOCOL_VERSION` moved to 2 precisely so a version
 * mismatch is caught at the handshake, as a readable refusal, instead of a v1
 * peer's request being silently reinterpreted into whatever this function
 * guessed it meant.
 */
function isResumePointShaped(value: unknown): value is ResumePoint {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    Number.isInteger(candidate.gen) &&
    (candidate.gen as number) >= 0 &&
    Number.isInteger(candidate.seq) &&
    (candidate.seq as number) >= 0
  );
}

/**
 * Whether every value in `value` is a {@link ResumePoint} —
 * {@link AttachRequest.resumeFrom}'s shape, checked so {@link isAttachShaped}
 * does not claim a field it never inspected. `resumeFrom` is handed to
 * `onAttach` unread by this file (HIVE-143) — replay is
 * `electron/main/ipc/index.ts`'s decision to make, not this listener's — but
 * the predicate's return type says the whole `AttachRequest` is safe to use,
 * and a predicate that skipped this field would be handing that caller a lie
 * it has no reason to suspect.
 */
function isResumeFromShaped(value: unknown): value is Readonly<Record<string, ResumePoint>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(isResumePointShaped);
}

/** Whether `value` has the shape `verifyDevice` and the protocol check can safely use. */
function isAttachShaped(value: unknown): value is AttachRequest {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === 'attach' &&
    typeof candidate.protocol === 'number' &&
    typeof candidate.deviceId === 'string' &&
    typeof candidate.token === 'string' &&
    (candidate.resumeFrom === undefined || isResumeFromShaped(candidate.resumeFrom))
  );
}

export function createRemoteListener(options: {
  bind: ServerBindConfig;
  /**
   * Read once per handshake, never cached at construction — and the caller
   * must make that actually true, not merely re-invoke a getter that closes
   * over an already-cached answer (HIVE-142 review, N5). `--pair` runs in a
   * separate process from the running server, appending a device to the
   * config file on disk; the only way an already-listening server sees that
   * new device without a restart is by this getter genuinely re-reading the
   * file on every attach, rather than capturing its result once at `start()`
   * — or, just as silently wrong, wrapping a value that was itself cached
   * elsewhere. `electron/main/ipc/index.ts` fulfils this with
   * `readServerDevicesFromDisk()` (`electron/main/server/file-backed-io.ts`),
   * which is also why it may **not** be a plain `getConfig()`/`reloadConfig()`
   * call: this getter runs on every inbound connection, before
   * `verifyDevice` — i.e. from a peer nothing has vouched for yet — and
   * `reloadConfig()` installs its result as this process's *shared* config
   * cache, which an unauthenticated path must not be able to do.
   */
  devices: () => readonly ServerDevice[];
  /** What the client renders in its header indicator: "attached · <name>". */
  serverName: string;
  /**
   * Where a `call` or `notify` frame goes once a socket has attached
   * (HIVE-143). The same `createRemoteDispatch(registry)` a renderer's own
   * IPC would have reached, injected rather than imported — `listener.ts`
   * importing `electron/main/ipc/index.ts` to build one itself would be the
   * cycle `electron/main/ipc/index.ts` avoids by constructing this listener
   * in the first place.
   */
  dispatch: RemoteDispatch;
  /**
   * What `AttachAccepted.snapshot` carries (HIVE-144) — built by calling
   * `remoteRegistry`'s own recorded call handlers for `SNAPSHOT_CHANNELS`, and
   * injected rather than imported for the same reason `dispatch` is:
   * `electron/main/ipc/index.ts` is what constructs it, and this file does not
   * import that one.
   *
   * A snapshot is a convenience, not a precondition. This function already
   * omits any channel whose read threw rather than rejecting, so this
   * listener never refuses an attach over a broken read — it sends whatever
   * calling this produced, bounded by {@link fitSnapshot} below.
   */
  buildSnapshot: () => Promise<Partial<Record<Channel, unknown>>>;
  /**
   * Told about a socket the instant its handshake completes, with whatever
   * `resumeFrom` it sent — `undefined` when it sent none, never `{}` (see
   * {@link AttachRequest.resumeFrom}). This is how `electron/main/ipc/index.ts`
   * learns a socket exists at all: nothing above this option tracks attached
   * sockets for it.
   */
  onAttach: (socket: AttachedSurface, resumeFrom: Readonly<Record<string, ResumePoint>> | undefined) => void;
  /** Told when an attached socket is gone — closed, errored, or terminated. */
  onDetach: (socket: AttachedSurface) => void;
}): RemoteListener {
  const { bind, devices, serverName, dispatch, buildSnapshot, onAttach, onDetach } = options;

  /*
    No host-alias concept here, unlike the hook receiver. `ServerBindConfig`
    binds one literal host chosen for server mode — there is no containerised
    session addressing this socket by an alias of its own — so the guard's
    third input is always the empty set.
  */
  const guard = createOriginGuard({
    allowedOrigins: bind.allowedOrigins,
    host: bind.host,
    hostAliases: () => new Set<string>(),
    /*
      Diagnostics only (HIVE-142 review, I4): a Tailscale node typically has
      both an address and a MagicDNS name, and a client that addresses this
      socket by the name is refused with a bare 403 and, until this, nothing
      explaining why. Logged here — this machine's own log — never on the
      wire, which would hand an unauthenticated peer exactly the admissible
      set it is being refused for not already knowing.
    */
    onHostRefused: (claimed, admissible) => {
      console.error(
        `[hive] server mode refused Host "${claimed}" — admissible: loopback, ${admissible.join(', ')}`,
      );
    },
  });

  let server: Server | null = null;
  let wss: WebSocketServer | null = null;
  let boundHost: string | null = null;
  /**
   * The cause of the most recent bind failure, or `null` when bound or never
   * tried (HIVE-142 review, I3) — set in the `'error'` handler below,
   * cleared the moment a bind actually succeeds. Exposed as
   * {@link RemoteListener.lastBindError} so the tray can tell "still
   * starting" apart from "failed, and here is why" instead of showing the
   * same "Not yet listening" for both.
   */
  let bindError: string | null = null;

  /**
   * Every timer armed on behalf of a socket that has not yet fired or been
   * cleared — the handshake deadline (`ATTACH_HANDSHAKE_TIMEOUT_MS`) and,
   * since HIVE-144, the per-call deadline (`CALL_DEADLINE_MS`) below. `stop()`
   * clears whatever is left so a timer belonging to a listener that no
   * longer exists cannot fire against it later — load-bearing for a test
   * process, where a leaked `setTimeout` is a handle that outlives the test
   * it was created in, and true in production too: a timer armed for a
   * socket must not survive the listener that armed it.
   */
  const pendingTimers = new Set<NodeJS.Timeout>();

  /**
   * Every socket that has been upgraded but has not yet attached — the set
   * {@link MAX_UNATTACHED_SOCKETS} caps (HIVE-143 review).
   *
   * A set rather than a counter so add and remove are idempotent: a socket
   * leaves it on `'close'` *and* on a successful attach, and either may happen
   * first without the number drifting. Membership is what "unattached" means
   * here, so there is nothing to keep in step.
   */
  const unattached = new Set<WebSocket>();

  function send(socket: WebSocket, frame: ServerFrame): void {
    socket.send(JSON.stringify(frame));
  }

  /** Sends a refusal and closes the socket — every handshake failure below ends this way. */
  function refuse(socket: WebSocket, frame: AttachRefused): void {
    send(socket, frame);
    socket.close();
  }

  function unauthorized(message: string): AttachRefused {
    return { kind: 'attach-refused', code: 'unauthorized', protocol: REMOTE_PROTOCOL_VERSION, message };
  }

  /** How many bytes the accept frame carrying `snapshot` would weigh on the wire. */
  function acceptFrameBytes(snapshot: Partial<Record<Channel, unknown>>): number {
    return Buffer.byteLength(
      JSON.stringify({ kind: 'attach-accepted', protocol: REMOTE_PROTOCOL_VERSION, serverName, snapshot }),
      'utf8',
    );
  }

  /**
   * Drops keys from `snapshot`, largest first, until the accept frame carrying
   * it fits under {@link POST_ATTACH_FRAME_MAX_BYTES} (Ruling 15, HIVE-144).
   *
   * **That ceiling, deliberately, not {@link ATTACH_FRAME_MAX_BYTES}.** The
   * two bound opposite directions — the client's own `ws` instance sets its
   * receive-side `maxPayload` to `POST_ATTACH_FRAME_MAX_BYTES` for the whole
   * connection at connect time (`electron/remote-client/socket.ts`), and that
   * governs from the very first frame it receives, this accept included.
   * `ATTACH_FRAME_MAX_BYTES` bounds the *client's* attach frame, on its way
   * in — reusing it here would refuse a snapshot at 8 KiB instead of the 8 MiB
   * a client's socket can actually take.
   *
   * A snapshot is a convenience, not a precondition: an oversized accept frame
   * is not refused with a wire code — there is none for "too big to send" —
   * it is silently dropped by the client's own `ws` at 1009, which at the
   * handshake reads as the same "closed before it attached" a version
   * mismatch produces. So this never lets that frame leave: it drops the
   * heaviest keys first, which gets back under budget in the fewest drops,
   * and logs which ones so a busy server's fleet is at least diagnosable
   * rather than merely smaller.
   *
   * No separate "does it already fit" fast path in front of the loop below,
   * deliberately: a snapshot that already fits just costs one `break` on the
   * loop's first iteration, and a second copy of the same comparison ahead of
   * it would be a check nothing distinguishes from the one inside the loop —
   * exactly the shape of redundant, unfalsifiable line this branch keeps
   * producing (HIVE-144 review). The loop's own check is the only place this
   * ceiling is compared against, so a test that swaps it for
   * {@link ATTACH_FRAME_MAX_BYTES} has nowhere else to hide.
   */
  function fitSnapshot(
    snapshot: Partial<Record<Channel, unknown>>,
  ): Partial<Record<Channel, unknown>> {
    const remaining: Partial<Record<Channel, unknown>> = { ...snapshot };
    const byteLengthOfValue = (value: unknown): number =>
      Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
    // Computed once, over the original snapshot, before anything is deleted —
    // an order recomputed mid-drop would keep re-measuring keys already gone.
    const largestFirst = (Object.keys(remaining) as Channel[]).sort(
      (a, b) => byteLengthOfValue(remaining[b]) - byteLengthOfValue(remaining[a]),
    );

    const dropped: Channel[] = [];
    for (const channel of largestFirst) {
      if (acceptFrameBytes(remaining) <= POST_ATTACH_FRAME_MAX_BYTES) break;
      delete remaining[channel];
      dropped.push(channel);
    }

    if (dropped.length > 0) {
      console.error(
        `[hive] attach snapshot exceeded ${String(POST_ATTACH_FRAME_MAX_BYTES)} bytes; dropped: ${dropped.join(', ')}`,
      );
    }

    /*
      Reachable only through a pathological `serverName` (HIVE-144 review):
      once `largestFirst` is exhausted, `remaining` is `{}` and everything
      left in the frame is `kind`, `protocol` and `serverName` — none of which
      this function has anything left to drop. `serverName` is `hostname()` in
      production (`electron/main/ipc/index.ts`), nowhere near this ceiling, so
      this is not expected to fire; it is not silent if it somehow does,
      because "the accept frame is being sent oversized anyway" is worse
      unstated than stated. There is no drop left to make it true, so this
      logs rather than pretends `fitSnapshot` can still fix it.
    */
    if (acceptFrameBytes(remaining) > POST_ATTACH_FRAME_MAX_BYTES) {
      console.error(
        `[hive] attach accept frame still exceeds ${String(POST_ATTACH_FRAME_MAX_BYTES)} bytes with an empty snapshot — serverName is unexpectedly large`,
      );
    }

    return remaining;
  }

  return {
    get boundHost() {
      return boundHost;
    },

    get lastBindError() {
      return bindError;
    },

    start() {
      return new Promise<string | null>((resolve) => {
        /*
          Any plain HTTP request to this socket is a mistake, not a use case —
          the only legitimate caller here is a `ws` upgrade. A `node:http`
          server with no `'request'` listener never writes a response, so the
          request just hangs; answering plainly is kinder than that and costs
          one line. The guard still runs first: "every route" includes this
          one, the same property `http-guard.ts` argues for in `reject`.
        */
        const created = createServer((req, res) => {
          const status = guard(req.headers);
          if (status !== null) {
            res.writeHead(status).end();
            return;
          }
          res.writeHead(426, { 'content-type': 'text/plain' }).end('Upgrade required');
        });

        /*
          `maxPayload` is the **post-attach** ceiling, deliberately — see both
          constants. `ws` builds a connection's `Receiver` once and enforces
          this for the socket's whole life, so it cannot be the handshake's own
          bound; that one is checked by hand, on the first frame, below.
        */
        const sockets = new WebSocketServer({
          noServer: true,
          maxPayload: POST_ATTACH_FRAME_MAX_BYTES,
        });
        sockets.on('connection', (socket: WebSocket) => {
          unattached.add(socket);

          /*
            Armed the instant the socket exists, cleared when the socket
            *attaches* (or closes or errors on its own) — see
            `ATTACH_HANDSHAKE_TIMEOUT_MS` (I5, HIVE-142 review).

            Not cleared merely because a first frame arrived (HIVE-143 review).
            The deadline means "become an attached socket within five seconds",
            not "send a byte within five seconds": a peer whose first frame is
            refused is sent a close frame and then, by `ws`'s own rules, has
            thirty seconds to answer it before `ws` destroys the socket. Left to
            that, eight peers sending eight bad attach frames would hold every
            slot {@link MAX_UNATTACHED_SOCKETS} has for half a minute and lock a
            real device out — the cap turned into the denial it exists to
            prevent. Keeping the timer armed until attach closes that.
          */
          const timer = setTimeout(() => {
            pendingTimers.delete(timer);
            socket.terminate();
          }, ATTACH_HANDSHAKE_TIMEOUT_MS);
          pendingTimers.add(timer);
          const clearHandshakeTimer = (): void => {
            clearTimeout(timer);
            pendingTimers.delete(timer);
          };
          socket.once('close', () => {
            clearHandshakeTimer();
            unattached.delete(socket);
          });

          /*
            An unauthenticated socket is untrusted input, and `ws` treats a
            protocol violation (an unmasked client frame, a frame over
            `maxPayload`) as an `Error` on the `Receiver`, forwarded to the
            `WebSocket`'s own `'error'` event. `EventEmitter` throws sync when
            an `'error'` event has no listener, which without this line is an
            uncaught exception on `electron`'s main process — proved end to
            end against this file (HIVE-142 review, C1). `ws` already runs its
            own `.close()` before this fires; this handler exists to exist,
            not to do anything clever with the error.
          */
          socket.on('error', () => {
            clearHandshakeTimer();
            socket.terminate();
          });

          /*
            Exactly one frame is read from an unattached socket: the brief's
            entire handshake surface. `once` rather than `on` — anything past
            the first frame on a socket that never attached is scope this
            story does not own, and the connection is closed either way once
            this handler decides.
          */
          socket.once('message', async (data: Buffer | ArrayBuffer | Buffer[]) => {
            /**
             * Whether `attach-accepted` has already gone out on this socket
             * (HIVE-143 review).
             *
             * The outer `catch` below used to answer `attach-refused`
             * unconditionally, including after the accept had been sent — and
             * `onAttach` can throw, so that sequence was reachable rather than
             * theoretical. The wire contract describes no accept-then-refuse
             * ordering and a client is entitled to be confused by one; past the
             * accept the honest thing is to log on this side and drop the
             * socket, which the client already has a branch for.
             */
            let accepted = false;

            try {
              /*
                The handshake's own size bound, before `JSON.parse` is asked to
                build an object graph out of the bytes — the point of a limit is
                that the work it refuses never happens. Refused with a frame
                rather than by dropping the socket, which is what `maxPayload`
                used to do here: an oversized attach is a client bug worth
                naming, and every other malformed first frame on this socket is
                already answered rather than silently closed.
              */
              if (frameByteLength(data) > ATTACH_FRAME_MAX_BYTES) {
                refuse(socket, unauthorized('The first frame on a connection is too large.'));
                return;
              }

              let frame: unknown;
              try {
                frame = JSON.parse(String(data));
              } catch {
                refuse(socket, unauthorized('Malformed first frame.'));
                return;
              }

              if (!isAttachShaped(frame)) {
                // A `call`, a `notify`, or an `attach` with a field of the
                // wrong type is refused exactly like a bad credential would
                // be — an unattached socket has no standing to be told which
                // kind of mistake it made, and `isAttachShaped` is what keeps
                // a non-string `token` or `deviceId` from ever reaching
                // `verifyDevice`, which would throw on one (C2, HIVE-142
                // review): `digestOf` hands `token` straight to
                // `createHash().update()`, which only accepts a string.
                refuse(socket, unauthorized('The first frame on a connection must be a well-formed attach.'));
                return;
              }

              const request = frame;

              /*
                Protocol before authorization, deliberately. A client on a
                mismatched build should be told that — it costs nothing to
                check and leaks nothing to answer — rather than being told its
                credential is wrong when the real problem is a stale build.
              */
              if (request.protocol !== REMOTE_PROTOCOL_VERSION) {
                refuse(socket, refuseProtocol(request.protocol));
                return;
              }

              // Read fresh, not the array captured at `createRemoteListener`
              // time — see the option's doc comment.
              const result = verifyDevice(devices(), request.deviceId, request.token);
              if (result === 'unknown') {
                refuse(socket, unauthorized('Unknown device, or the token did not match.'));
                return;
              }
              if (result === 'revoked') {
                refuse(socket, {
                  kind: 'attach-refused',
                  code: 'revoked',
                  protocol: REMOTE_PROTOCOL_VERSION,
                  message: 'This device has been revoked.',
                });
                return;
              }

              /*
                One object per socket: the frame sink and the lifetime are the
                same identity (HIVE-145).

                They used to be two — a `socketHandle` for `onAttach` and a
                separate `reporter` for notify dispatch — which meant one
                connection had two identities and anything keying by surface
                needed a lookup between them. The surface registry keys by this
                object, so there is one.

                `watchReporter` in `electron/main/ipc/index.ts` dedupes by
                identity, so handing it a fresh object per frame would register
                a new set of listeners on every keystroke report. It is the
                socket that has a lifetime, not the frame.

                Only `destroyed` is wired. A socket has no analogue of
                `did-start-loading` or `render-process-gone` — it is either open
                or it is gone — and firing a reset for events that cannot
                happen would be inventing a lifecycle.
              */
              const closeListeners: (() => void)[] = [];
              const socketHandle: AttachedSurface = {
                send(outgoing) {
                  send(socket, outgoing);
                },
                on(event, listener) {
                  if (event === 'destroyed') closeListeners.push(listener);
                  return undefined;
                },
              };

              /** Set by the close listener below — the only writer. */
              let gone = false;

              /*
                The close listener is registered **before the snapshot await**,
                not merely before `onAttach` (HIVE-144 review, I4).

                The original ordering comment justified itself with "the
                listener cannot fire before this **synchronous** block
                finishes." That was true when it was written, and HIVE-144
                stopped it being true by inserting an up-to-`SNAPSHOT_READ_BUDGET_MS`
                `await buildSnapshot()` earlier in the same block. A peer whose
                socket closed during that window fired the connection-level
                `'close'` with no listener of ours registered; this handler then
                resumed, sent the accept into a dead socket, registered a
                `'close'` that could never fire again, and handed the dead
                handle to `onAttach` — into `attachedSockets`, for the life of
                the process, with `send` having no `readyState` check to notice.
                Every later broadcast then serialised a frame and threw.

                What makes the ordering safe now is not synchrony, which this
                block no longer has, but that **nothing between registration and
                `onAttach` can leave the pair unbalanced**: `onDetach` is a
                `Set.delete`, so running it for a handle `onAttach` never added
                is a no-op, and the `gone` guard below stops the accept and the
                add from happening at all once the socket is closed.

                It still also covers the case the HIVE-143 review added it for:
                `onAttach` itself can throw — it iterates `resumeFrom` and calls
                into the session layer — and the outer `catch` closes the
                socket, which needs this listener already in place to unwind.
              */
              socket.once('close', () => {
                gone = true;
                for (const listener of closeListeners) listener();
                onDetach(socketHandle);
              });

              /*
                Built and bounded before the accept frame goes out — never
                after (HIVE-144). `buildSnapshot` already omits any channel
                whose read threw, so this can only ever come back with as
                many of `SNAPSHOT_CHANNELS` as could actually be answered;
                `fitSnapshot` then weighs the frame this produces and drops
                the heaviest keys first if a busy server's fleet would not
                otherwise fit. Awaiting this holds the handshake open a beat
                longer than a synchronous send would — every read behind it
                is this same process answering itself, not a network call —
                and it is still well inside `ATTACH_HANDSHAKE_TIMEOUT_MS`.
              */
              const snapshot = fitSnapshot(await buildSnapshot());

              /*
                The peer hung up while the snapshot was being built. There is
                nothing left to accept *to*: sending would write into a dead
                socket, and `onAttach`ing would put a handle nothing can ever
                remove into the fan-out — its `'close'` has already fired.
                `onDetach` has run for this handle, which is a no-op it never
                joined, so leaving here balances rather than leaks.
              */
              if (gone) return;

              send(socket, {
                kind: 'attach-accepted',
                protocol: REMOTE_PROTOCOL_VERSION,
                serverName,
                snapshot,
              });
              accepted = true;
              /*
                Attached: the handshake deadline has been met and this socket
                stops counting against {@link MAX_UNATTACHED_SOCKETS}, which
                caps the *unauthenticated* phase and not how many paired
                devices may be connected at once.
              */
              clearHandshakeTimer();
              unattached.delete(socket);

              onAttach(socketHandle, request.resumeFrom);

              /*
                Everything past the handshake arrives here, one socket-level
                `'message'` listener for the life of the connection — distinct
                from the `once('message', ...)` above, which is the
                handshake's own one-shot read and never fires again.
              */
              socket.on('message', (postAttachData: Buffer | ArrayBuffer | Buffer[]) => {
                let postAttachFrame: unknown;
                try {
                  postAttachFrame = JSON.parse(String(postAttachData));
                } catch {
                  console.error('[hive] server mode dropped an unparsable frame from an attached client');
                  return;
                }

                if (postAttachFrame === null || typeof postAttachFrame !== 'object') {
                  console.error('[hive] server mode dropped a malformed frame from an attached client');
                  return;
                }
                const kind = (postAttachFrame as Record<string, unknown>).kind;

                if (kind === 'call') {
                  /*
                    Answered without awaiting the socket's readiness and
                    without ordering against other calls: `id` is what
                    correlates a result, which is exactly so that a slow
                    channel cannot head-of-line block a fast one. Ordering
                    matters for `notify` and is preserved there by handling
                    those synchronously.

                    **A deadline on the call itself (HIVE-144).** `dispatch.call`
                    never *rejects* — every refusal and every thrown handler
                    comes back as an `error` frame — but it can fail to settle
                    at all, because some handlers genuinely wait on the world:
                    `agents:run` awaits the memoised `mcp.start()`, and
                    `slack:sign-in` spawns a real `claude` turn and waits for
                    it. Left unbounded, that holds `socketHandle` — and
                    therefore the socket — past a detach that has already
                    happened, with the client's own correlation id outstanding
                    and nothing on the wire to say so. This deadline does not
                    change that retention: the `.then`/`.catch` reaction below
                    is still a live closure over `socketHandle` for as long as
                    `dispatch.call` takes to actually settle, however late.
                    What it fixes is the client's wait, not the handle's
                    lifetime.

                    `CALL_DEADLINE_MS` is the fix: if the call has not settled
                    by then, `deadline` fires, answers `CALL_TIMEOUT_CODE`, and
                    is the *only* thing that sets `settled` — a fired timeout
                    cannot itself run twice, so it needs no guard of its own.
                    `settled` exists for the other direction: a `dispatch.call`
                    that answers late, after the timeout already has, must not
                    send a second frame for the same `id` — two answers to one
                    correlation id is worse than the timeout alone, because the
                    client already resolved. `clearTimeout(deadline)` on the
                    settle path is what stops that stale timer from firing at
                    all once a real answer is in hand; without it, an
                    already-answered call would still get a spurious
                    `CALL_TIMEOUT_CODE` error minutes later. `CALL_GIVE_UP_MS`
                    (`electron/shared/remote-contract.ts`) is the client's own
                    number — `CALL_DEADLINE_MS` plus flight time, not the same
                    value — so it never gives up on a call this server is
                    still going to answer.
                  */
                  let settled = false;
                  const deadline = setTimeout(() => {
                    settled = true;
                    pendingTimers.delete(deadline);
                    if (socket.readyState !== socket.OPEN) return;
                    send(socket, {
                      kind: 'error',
                      id: (postAttachFrame as CallFrame).id,
                      code: CALL_TIMEOUT_CODE,
                      message: `no answer within ${String(CALL_DEADLINE_MS)}ms`,
                    });
                  }, CALL_DEADLINE_MS);
                  pendingTimers.add(deadline);

                  void dispatch
                    .call(postAttachFrame as CallFrame)
                    .then((answer) => {
                      // A late answer, after the deadline above already sent
                      // its own error frame for this `id` — nothing left to
                      // tell the client that would not be a second frame for
                      // one correlation id.
                      if (settled) return;
                      clearTimeout(deadline);
                      pendingTimers.delete(deadline);
                      /*
                        No `readyState` check here, unlike the two sites above
                        and below — this is HIVE-143's original answer path,
                        unchanged by this task. A send to a closed socket
                        routes through `ws`'s `sendAfterClose`, which emits an
                        `'error'` rather than throwing, and the `'error'`
                        listener registered on this socket at connection time
                        already swallows it. Adding a check here is scope this
                        task does not own.
                      */
                      socketHandle.send(answer);
                    })
                    .catch((cause: unknown) => {
                      /*
                        `dispatch.call` does not reject, so what lands here is
                        the *send* failing — and `send` stringifies first, so a
                        handler that answered a cyclic object or a `BigInt`
                        throws from `JSON.stringify` rather than from anything
                        the socket did. Without this the rejection is unhandled
                        in the main process; with it the client is told, which
                        is the difference between a call that failed and a call
                        that never comes back. Sent only while the socket can
                        still carry it, and inside its own try: the frame that
                        replaces an unserialisable one must not itself be the
                        thing that throws.
                      */
                      if (settled) return;
                      clearTimeout(deadline);
                      pendingTimers.delete(deadline);
                      console.error('[hive] server mode could not answer a call frame:', cause);
                      if (socket.readyState !== socket.OPEN) return;
                      try {
                        send(socket, {
                          kind: 'error',
                          id: (postAttachFrame as CallFrame).id,
                          code: 'send-failed',
                          message: 'The result could not be sent.',
                        });
                      } catch {
                        // The socket is going down under us. Nothing left to
                        // tell anyone, and a throw here would be the unhandled
                        // rejection this catch exists to prevent.
                      }
                    });
                  return;
                }
                if (kind === 'notify') {
                  dispatch.notify(postAttachFrame as NotifyFrame, socketHandle);
                  return;
                }
                // A second `attach`, a `result`/`error`/`event` this server
                // never expects a client to send, or anything else outside
                // the two channel kinds a client may use — dropped, not
                // refused. `AttachRefusalCode` names four reasons and none of
                // them is "you already attached"; adding a fifth would
                // change the wire and force a protocol bump for a case only
                // a buggy client can reach. Silence costs that client
                // nothing it did not already have.
                console.error(`[hive] server mode dropped a ${String(kind)} frame from a client`);
              });
            } catch (cause) {
              /*
                Belt and suspenders under `isAttachShaped`'s own validation:
                anything this handler did not anticipate refuses the socket
                rather than throwing past it (C2, HIVE-142 review). If even
                the refusal cannot be sent — the socket is already going down
                — terminate rather than let a second exception through.

                Only while the refusal is still a truthful thing to say
                (HIVE-143 review). Past `attach-accepted` the throw came from
                `onAttach` — the replay loop, which iterates `resumeFrom` and
                calls into the session layer — and answering `attach-refused`
                there would tell a client its credential was rejected on a
                connection this server has already accepted and, worse, already
                added to the fan-out. There is no wire code for "accepted, then
                something broke", so the socket is logged here and dropped;
                `onDetach` runs off the `'close'` this causes, exactly as it
                would for any other lost connection.
              */
              if (accepted) {
                console.error('[hive] server mode dropped a socket that failed after attach-accepted:', cause);
                socket.terminate();
                return;
              }
              try {
                refuse(socket, unauthorized('The attach could not be processed.'));
              } catch {
                socket.terminate();
              }
            }
          });
        });
        wss = sockets;

        created.on('upgrade', (req, socket, head) => {
          /*
            The Origin/Host guard runs here, on the upgrade request, before
            `handleUpgrade` — this is the entire reason `ws` in `noServer`
            mode was chosen over a raw TCP listener. An allowlist needs an
            HTTP request to inspect, and only an upgrade request gives you
            one; a plain accepted TCP connection never would.
          */
          const status = guard(req.headers);
          if (status !== null) {
            /*
              Node removes its own `'error'` listener from a socket the
              moment `'upgrade'` fires — this is exactly why `ws` installs
              one as the first statement of its own `handleUpgrade`
              (`websocket-server.js`). Without one here, writing a refusal to
              a peer-controlled socket that resets the connection mid-write
              is an unhandled `'error'` on this raw `net.Socket`, the same
              uncaught-exception shape as C1, just on a socket `ws` never
              took ownership of. A no-op is enough: there is nothing to do
              with a write error to a socket already being destroyed.
            */
            socket.on('error', () => {});
            // A real status line, not a silent drop — `ws`'s client parses
            // this as an HTTP response and surfaces it as a connection error
            // rather than hanging. `createOriginGuard` only ever returns 403
            // (or `null`), so there is exactly one reason phrase to spell.
            socket.write(`HTTP/1.1 ${String(status)} Forbidden\r\nConnection: close\r\n\r\n`);
            socket.destroy();
            return;
          }

          /*
            The concurrency half of the size bound, refused **before**
            `handleUpgrade` (HIVE-143 review).

            Enforced here rather than in the `'connection'` handler because
            here is the last point at which nothing has been allocated: past
            `handleUpgrade`, `ws` has built this connection's `Receiver` and it
            is willing to buffer `POST_ATTACH_FRAME_MAX_BYTES` for a peer that
            has proven nothing. Refusing in `'connection'` would mean refusing
            a socket that can already be filling that buffer, and `close()`
            does not stop it — `ws` keeps receiving through the closing
            handshake. Answering an HTTP status line instead of a WebSocket
            frame is the same shape the Origin/Host refusal above uses, and
            `ws`'s client surfaces it as a connection error rather than
            hanging. 503 rather than 403: the peer is not forbidden, this
            server is momentarily out of handshake slots, and retrying after
            `ATTACH_HANDSHAKE_TIMEOUT_MS` is the right response.
          */
          if (unattached.size >= MAX_UNATTACHED_SOCKETS) {
            socket.on('error', () => {});
            console.error(
              `[hive] server mode refused an upgrade: ${String(MAX_UNATTACHED_SOCKETS)} sockets are already mid-handshake`,
            );
            socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
          }

          sockets.handleUpgrade(req, socket, head, (ws) => {
            sockets.emit('connection', ws, req);
          });
        });

        created.on('error', (cause) => {
          // Only a bind failure clears the handles — see `stop()` and
          // `receiver.ts`'s identical guard for why `server === null` is the
          // discriminator between "never bound" and "bound, then errored".
          if (server === null) {
            // Logged with its cause, and recorded for the tray to show
            // (HIVE-142 review, I3) — a port conflict or a `bind.host` that
            // does not yet resolve to a local interface used to leave
            // `boundHost` at `null` with nothing anywhere saying why, which
            // on an unattended machine is indistinguishable from "still
            // starting".
            const reason = describe(cause);
            console.error(`[hive] server mode could not bind ${wsUrl(bind.host, bind.port)}: ${reason}`);
            bindError = reason;
            /*
              `wss` was already assigned below (before `created.listen` was
              even called) and `created` is a real, if now-erroring,
              `http.Server` — `stop()`'s own early return on `server === null`
              never reaches either of them, so both leak for the life of the
              process unless this handler closes them itself (HIVE-142
              review, M2). Neither ever accepted a real connection, so a bare
              `.close()` with no callback is enough — there is nothing
              in-flight to wait for.
            */
            wss?.close();
            wss = null;
            created.close();
            boundHost = null;
            resolve(null);
          }
        });

        created.listen(bind.port, bind.host, () => {
          const address = created.address();
          if (address === null || typeof address === 'string') {
            resolve(null);
            return;
          }
          server = created;
          boundHost = address.address;
          bindError = null;
          resolve(wsUrl(bind.host, address.port));
        });
      });
    },

    stop() {
      return new Promise<void>((resolve) => {
        const running = server;
        const runningSockets = wss;
        server = null;
        wss = null;
        boundHost = null;

        // Nothing left to wait for once a timer has fired or been cleared,
        // but one still armed on behalf of a socket — mid-handshake, or a
        // call still short of its deadline — must not survive the listener
        // it belongs to.
        for (const timer of pendingTimers) clearTimeout(timer);
        pendingTimers.clear();
        // The cap belongs to a running listener. Leaving members here would
        // let a stopped listener's mid-handshake sockets count against a
        // later `start()`'s slots — which in a test process is one case
        // silently shrinking the next one's cap.
        unattached.clear();

        if (running === null) {
          resolve();
          return;
        }

        /*
          `wss.close()` alone does not close an already-attached socket: in
          `noServer` mode it only stops accepting new upgrades and waits for
          `clients` to empty on its own (`websocket-server.js`'s `close()`).
          `closeAllConnections()` on the *http* server does not reach those
          sockets either — a socket `ws` took over on `'upgrade'` is no
          longer one `http.Server` tracks as a request-response connection.
          Proved by probe (HIVE-142 review, I4): with a client still attached,
          `stop()` never resolved in 1500ms; terminating that client by hand
          let it resolve 9ms later. Terminating every live client explicitly,
          before either `close()` call, is what actually empties `clients`
          and lets the http server's own close finish.
        */
        if (runningSockets) {
          for (const client of runningSockets.clients) client.terminate();
          runningSockets.close();
        }
        running.close(() => resolve());
        // Keep-alive sockets, and anything mid-upgrade, would otherwise hold
        // the close open past app quit.
        running.closeAllConnections?.();
      });
    },
  };
}
