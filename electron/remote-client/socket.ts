import { lookup as dnsLookup } from 'node:dns';
import type { LookupFunction } from 'node:net';

import { WebSocket, type ClientOptions } from 'ws';

import { isRemoteTarget } from '@shared/config-contract';
import type { Channel } from '@shared/ipc-contract';
import {
  ATTACH_FRAME_MAX_BYTES,
  CALL_GIVE_UP_MS,
  CALL_TIMEOUT_CODE,
  POST_ATTACH_FRAME_MAX_BYTES,
  frameKindOf,
  type AttachAccepted,
  type AttachRefused,
  type CallFrame,
  type NotifyFrame,
  type ResumePoint,
  type ServerFrame,
} from '@shared/remote-contract';

import { attachRequest } from './index';

/**
 * The socket half of the client (HIVE-144): open the connection, perform the
 * attach handshake, correlate `result` and `error` frames back to the `call`
 * that is waiting for them, and fan `event` frames out to whoever subscribed.
 *
 * The mirror of `electron/remote-host/listener.ts`, and deliberately only that.
 * It knows nothing about sessions, the store, or what any channel means — it
 * moves frames. `electron/main/**`'s router is what gives them meaning.
 *
 * ## The two fences, and why one of them is not enough
 *
 * There is no TLS in this story. The device credential
 * (`electron/remote-client/token-store.ts`) crosses this socket in the clear,
 * so the socket's confidentiality is entirely whatever network it crosses —
 * which makes "what will this app dial?" a security decision rather than a
 * convenience check. Two guards answer it, and they fail closed independently:
 *
 * 1. **The string.** {@link isRemoteTarget} on `host`, before a socket object
 *    exists at all. Loopback never leaves the machine; a Tailscale address
 *    never leaves Tailscale's own WireGuard mesh. Anything else is a route
 *    across the open internet.
 *
 * 2. **The resolved address.** A MagicDNS name such as `mini.tail1234.ts.net`
 *    satisfies (1) as a *string*, and is then handed to whatever resolver the
 *    OS has. If Tailscale is not up — a laptop on a café network, a tailnet
 *    that has not come back after a sleep — an attacker who controls local DNS
 *    answers that name with their own address and is handed the credential.
 *    **No string-level predicate can see that**, because the string is genuinely
 *    a `.ts.net` name; the address behind it is the thing that changed. So a
 *    custom `lookup` is passed down to `net.createConnection` and re-runs the
 *    same predicate on the address DNS actually returned, refusing before the
 *    TCP connection is made.
 *
 * `ws` forwards unknown options straight into `http.request`, which forwards
 * them into `net.createConnection`, and `lookup` survives that trip — verified
 * against `ws@8.21.3` on Node 22 rather than assumed: a `lookup` that answers
 * `127.0.0.1` for a name with no DNS record connects, and one that calls back
 * with an error fails the connection carrying that error's message. An IP
 * literal host never consults `lookup` at all, which is correct and costs
 * nothing: fence (1) has already read that literal directly.
 *
 * **`family: 4` is part of fence (2), not a performance tweak.** It pins
 * `dns.lookup` to A records, so every address the fence inspects is a dotted
 * quad — the spelling `isLoopbackHost` and `isTailnetHost` are written in.
 * Without it a dual-stack answer arrives as a mixed A/AAAA array and the fence
 * would have to either refuse the whole answer (breaking every IPv6-capable
 * host) or skip the AAAA entries (a hole). Tailscale assigns every node a
 * `100.64.0.0/10` IPv4 and `localhost` resolves to `127.0.0.1` everywhere, so
 * nothing reachable is lost. An IPv6 answer that arrives anyway — a resolver
 * that ignores `family` — is refused, because these predicates cannot vouch for
 * one and refusing is the failing-closed direction.
 */

/**
 * A plaintext socket this app will not open, from either fence.
 *
 * One class, two messages, deliberately: the caller's remedy is the same —
 * check the address, bring the tailnet up — and the distinction between "the
 * name is wrong" and "the name resolved somewhere wrong" belongs in the
 * sentence a human reads, not in a code a `catch` branches on. The messages
 * are distinguishable, and the tests assert on them.
 */
export class PlaintextRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaintextRefusedError';
  }
}

/** A handshake the server refused, with the code it refused it with. */
export class AttachRefusedError extends Error {
  readonly code: AttachRefused['code'];

  constructor(code: AttachRefused['code'], message: string) {
    super(message);
    this.name = 'AttachRefusedError';
    this.code = code;
  }
}

/**
 * An attach frame this client refused to send, because the server would refuse
 * it as `unauthorized` and the caller would read that as a bad credential.
 *
 * Its own class rather than a bare `Error` for exactly that reason: "pair
 * again" is the wrong remedy for a `resumeFrom` that outgrew the ceiling, and a
 * settings pane needs to be able to tell the two apart.
 */
export class AttachFrameTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachFrameTooLargeError';
  }
}

/**
 * A `call` that came back as an `error` frame, or that this client gave up on.
 *
 * The code crosses the wire intact for the reason `ErrorFrame` states: the
 * explorer and the editor branch on `EOUTSIDE` versus `IpcValidationError`,
 * and flattening either to a message would delete behaviour that works today.
 */
export class RemoteCallError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RemoteCallError';
    this.code = code;
  }
}

export interface RemoteClient {
  /** Invoke a call channel. Rejects on an error frame or the give-up deadline. */
  call(channel: Channel, payload: unknown): Promise<unknown>;
  /** Fire a notify channel. Never awaits. */
  notify(channel: Channel, payload: unknown): void;
  /** Subscribe to every event frame. Returns an unsubscribe. */
  onEvent(listener: (channel: Channel, payload: unknown) => void): () => void;
  /** The snapshot the server sent with AttachAccepted. */
  snapshot(): Readonly<Partial<Record<Channel, unknown>>>;
  /** The name this client paired under, for the header chip. */
  serverName(): string;
  close(): void;
}

export interface ConnectRemoteDeps {
  host: string;
  port: number;
  credential: { deviceId: string; token: string };
  resumeFrom?: Readonly<Record<string, ResumePoint>>;
  /** Injectable purely so a unit test needs no socket. Defaults to `ws`'s. */
  WebSocketCtor?: typeof WebSocket;
  /**
   * The resolver the address fence consults, defaulting to `node:dns`'s
   * `lookup` — injectable for the same reason `WebSocketCtor` is, and for one
   * more: a test cannot make the real resolver answer a `.ts.net` name with an
   * address of its choosing, which is exactly the attack fence (2) exists to
   * stop. Substituting it is how that fence gets exercised against a real `ws`
   * client rather than asserted about in isolation.
   */
  resolveAddress?: LookupFunction;
}

/** What one outstanding `call` is waiting on. */
interface Pending {
  resolve: (payload: unknown) => void;
  reject: (cause: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The `lookup` handed to `net.createConnection`, wrapping `resolve` with fence
 * (2).
 *
 * `refuse` is a sink rather than a return value because this callback's error
 * does not come back to the caller as itself: `net` hands it to the socket,
 * `ws` re-emits it as an `'error'` event, and by then the identity of the
 * `Error` is not something this file should be relying on. Recording the
 * refusal where `connectRemote` can read it means the promise rejects with the
 * sentence that names the address, not with `ECONNREFUSED`.
 */
function fencedLookup(
  host: string,
  resolve: LookupFunction,
  refuse: (cause: PlaintextRefusedError) => void,
): LookupFunction {
  return (hostname, options, callback) => {
    /*
      Answered once, whatever the resolver does (HIVE-144 review).

      `resolveAddress` is an injectable dependency, and a resolver that called
      back twice — a refused answer, then a good one — would run this body
      twice: the refusal is recorded, and a second `callback(null, address)`
      still goes out and the connection proceeds. `node:dns` does not do that,
      but every other fence in this file is fail-closed by construction rather
      than by trusting its caller, and this one should be too.
    */
    let answered = false;
    resolve(hostname, options, (error, address, family) => {
      if (answered) return;
      answered = true;
      if (error !== null) {
        callback(error, '', 4);
        return;
      }
      // `dns.lookup` answers with an array when `options.all` is set and a bare
      // string otherwise, and which one arrives is Node's choice, not ours —
      // `family: 4` takes the bare-string path today, and `all` is set when a
      // family is not pinned. Both are normalised here so the fence reads every
      // address in the answer either way.
      const answers = Array.isArray(address) ? address : [{ address, family: family ?? 4 }];
      const offending = answers.find((answer) => !isRemoteTarget(answer.address));
      if (offending !== undefined) {
        const cause = new PlaintextRefusedError(
          `Refusing to open a plaintext socket to "${host}": it resolved to ` +
            `${offending.address}, which is neither loopback nor inside the ` +
            `100.64.0.0/10 tailnet range. Bring Tailscale up, or check the address.`,
        );
        refuse(cause);
        callback(cause, '', 4);
        return;
      }
      // Passed through exactly as it arrived, so `net` sees the shape it asked
      // for. This function's job is to inspect the answer, not to rewrite it.
      (callback as (e: Error | null, a: typeof address, f?: number) => void)(null, address, family);
    });
  };
}

/** How many bytes a frame actually weighs on the wire — UTF-8, not UTF-16. */
function frameBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function connectRemote(deps: ConnectRemoteDeps): Promise<RemoteClient> {
  const {
    host,
    port,
    credential,
    resumeFrom,
    WebSocketCtor = WebSocket,
    resolveAddress = dnsLookup,
  } = deps;

  /*
    Fence (1), before a socket object exists. The brief's first test asserts
    `WebSocketCtor` was never called, and that assertion is the point: a
    refusal that costs a TCP connection has already told an attacker this
    machine is here and looking for a Hive.
  */
  if (!isRemoteTarget(host)) {
    return Promise.reject(
      new PlaintextRefusedError(
        `Refusing to open a plaintext socket to "${host}": it is neither ` +
          `loopback nor a tailnet address, and this connection carries a device ` +
          `credential in the clear.`,
      ),
    );
  }

  return new Promise<RemoteClient>((resolveConnection, rejectConnection) => {
    let refusal: PlaintextRefusedError | null = null;

    /*
      `lookup` is absent from `@types/ws`'s `ClientOptions`, which models the
      options `ws` reads itself and not the ones it forwards. It forwards
      everything it does not recognise into `http.request`, and from there into
      `net.createConnection`, where `lookup` is a documented option — verified
      against `ws@8.21.3` on Node 22, not assumed. The intersection is the
      narrowest way to say that: `lookup` is declared here, so the object
      literal type-checks, and every other key is still checked against `ws`'s
      own option type rather than escaping through a cast of the whole thing.
    */
    const options: ClientOptions & { lookup: LookupFunction } = {
      family: 4,
      lookup: fencedLookup(host, resolveAddress, (cause) => {
        refusal = cause;
      }),
      maxPayload: POST_ATTACH_FRAME_MAX_BYTES,
    };

    const socket = new WebSocketCtor(`ws://${host}:${String(port)}/`, options);

    /** Cleared once the handshake settles, so a later failure is not a double-settle. */
    let handshakeSettled = false;
    /** The client, once `attach-accepted` has built it. */
    let attached: {
      accepted: AttachAccepted;
      pending: Map<string, Pending>;
      listeners: Set<(channel: Channel, payload: unknown) => void>;
    } | null = null;
    let closed = false;

    const failHandshake = (cause: Error): void => {
      if (handshakeSettled) return;
      handshakeSettled = true;
      rejectConnection(cause);
    };

    /**
     * Rejects every outstanding call and clears its timer.
     *
     * Called on `close` — without it a detach leaves every caller awaiting a
     * promise nothing will ever settle, which is a hang rather than an error
     * and is the failure mode the map exists to make impossible.
     */
    const failAllPending = (cause: Error): void => {
      if (attached === null) return;
      for (const waiting of attached.pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(cause);
      }
      attached.pending.clear();
    };

    socket.on('open', () => {
      const frame = JSON.stringify(
        attachRequest(credential.deviceId, credential.token, resumeFrom),
      );
      /*
        The attach frame is the one client-sent frame `sendBounded` never sees,
        and the only one with an unbounded shape (HIVE-144 review). `deviceId`,
        `token` and `protocol` are fixed; `resumeFrom` is one `{ gen, seq }` per
        tracked session, roughly forty bytes each, so a few hundred sessions
        reaches the server's `ATTACH_FRAME_MAX_BYTES` on its own — and the
        snapshot HIVE-144's later tasks put behind this handshake only grows it.

        Unbounded, the server answers `unauthorized('The first frame on a
        connection is too large.')`, which is indistinguishable at this end from
        a bad credential: a settings pane would tell the user to pair again over
        a problem pairing cannot fix. It fails closed either way, so this is
        diagnosability rather than a hole — but naming the real cause costs one
        comparison, and it is checked *before* the frame goes out so the socket
        is not spent proving something this side already knew.
      */
      const weight = frameBytes(frame);
      if (weight > ATTACH_FRAME_MAX_BYTES) {
        const sessions = resumeFrom === undefined ? 0 : Object.keys(resumeFrom).length;
        failHandshake(
          new AttachFrameTooLargeError(
            `The attach frame is ${String(weight)} bytes, over the ` +
              `${String(ATTACH_FRAME_MAX_BYTES)}-byte handshake ceiling, carrying resume ` +
              `points for ${String(sessions)} sessions. This is not a credential problem — ` +
              `the server would refuse it as "unauthorized" and mean this. Reattach with ` +
              `fewer resume points.`,
          ),
        );
        socket.close();
        return;
      }
      socket.send(frame);
    });

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch {
        // A server that cannot produce JSON is not a server this client can
        // talk to; dropping the frame is right for an attached socket, and for
        // an unattached one the handshake timeout on the far end closes it.
        return;
      }
      if (typeof frame !== 'object' || frame === null || !('kind' in frame)) return;
      const server = frame as ServerFrame;

      if (attached === null) {
        if (server.kind === 'attach-accepted') {
          handshakeSettled = true;
          const pending = new Map<string, Pending>();
          const listeners = new Set<(channel: Channel, payload: unknown) => void>();
          attached = { accepted: server, pending, listeners };
          resolveConnection(buildClient(server, pending, listeners));
          return;
        }
        if (server.kind === 'attach-refused') {
          failHandshake(new AttachRefusedError(server.code, server.message));
          socket.close();
          return;
        }
        // Anything else before the handshake answers is a protocol violation.
        // Ignored rather than fatal: the far end still owes an accept or a
        // refusal, and its own handshake deadline closes the socket if it never
        // sends one.
        return;
      }

      if (server.kind === 'result') {
        const waiting = attached.pending.get(server.id);
        if (waiting === undefined) return;
        clearTimeout(waiting.timer);
        attached.pending.delete(server.id);
        waiting.resolve(server.payload);
        return;
      }
      if (server.kind === 'error') {
        const waiting = attached.pending.get(server.id);
        if (waiting === undefined) return;
        clearTimeout(waiting.timer);
        attached.pending.delete(server.id);
        waiting.reject(new RemoteCallError(server.code, server.message));
        return;
      }
      if (server.kind === 'event') {
        /*
          The mirror of `isClientFrameAllowed`'s direction half, pointed the
          other way (HIVE-144). That function stops a *client* sending a frame
          naming one of the event channels; this stops a *server* pushing an
          `event` naming a `call` or `notify` channel, which no honest server
          does and which a subscriber would have no way to tell from a real
          push. Derived from `FRAME_KIND` through `frameKindOf`, so it cannot
          drift from the table the server grades against.
        */
        if (frameKindOf(server.channel) !== 'event') return;
        for (const listener of attached.listeners) {
          /*
            Guarded per listener (HIVE-144 review). This loop runs inside `ws`'s
            `'message'` emit, so a subscriber that throws does two things at
            once: it aborts the fan-out, silently losing the event for every
            listener registered after it, and it propagates out of the
            EventEmitter as an uncaught exception in the main process. HIVE-144's
            later tasks register the remote proxy against this fan-out and drive
            the store from it, so "one bad consumer" would mean "the app is
            gone". A subscriber's own failure is its own; it is not this socket's
            to re-raise, and it is certainly not the other subscribers'.
          */
          try {
            listener(server.channel, server.payload);
          } catch {
            // Deliberately swallowed. There is no channel back to a subscriber
            // that has already failed, and a console line per dropped frame on
            // `pty:data` would be its own denial of service.
          }
        }
      }
    });

    socket.on('error', (cause: Error) => {
      // `refusal` is fence (2) speaking: `net` gave our own error to the
      // socket and `ws` re-emitted it here, so this is where a refused
      // resolution becomes the promise's rejection reason rather than a
      // generic connect failure.
      failHandshake(refusal ?? cause);
      failAllPending(refusal ?? cause);
    });

    socket.on('close', () => {
      closed = true;
      failHandshake(
        refusal ??
          new Error(`The connection to ${host}:${String(port)} closed before it attached.`),
      );
      failAllPending(new Error(`The connection to ${host}:${String(port)} closed.`));
    });

    /**
     * Sends one client frame, refusing it rather than letting `ws` close the
     * socket over it.
     *
     * Both **post-attach** client-to-server frame kinds go through here,
     * deliberately: a `notify` over the ceiling is refused by the far end's `maxPayload`
     * exactly as a `call` is — with a 1009 close that takes every unrelated
     * in-flight correlation id with it — so bounding only the kind that has a
     * promise to reject would leave the cheaper-looking half able to kill the
     * connection. `pty:write` carrying a very large paste is the realistic way
     * that happens. The **attach** frame is bounded separately, in the `'open'`
     * handler, against the server's own and much smaller handshake ceiling: it
     * is the third client-sent frame, and the only one that has to clear 8 KiB.
     */
    const sendBounded = (frame: CallFrame | NotifyFrame): string | null => {
      const text = JSON.stringify(frame);
      const weight = frameBytes(text);
      if (weight > POST_ATTACH_FRAME_MAX_BYTES) {
        return (
          `The ${frame.kind} frame for ${frame.channel} is ${String(weight)} bytes, over the ` +
          `${String(POST_ATTACH_FRAME_MAX_BYTES)}-byte frame ceiling. The server answers a frame ` +
          `this large by closing the connection rather than by refusing the frame, so it is ` +
          `refused here instead.`
        );
      }
      socket.send(text);
      return null;
    };

    function buildClient(
      accepted: AttachAccepted,
      pending: Map<string, Pending>,
      listeners: Set<(channel: Channel, payload: unknown) => void>,
    ): RemoteClient {
      let nextId = 0;

      return {
        call(channel, payload) {
          if (closed) {
            return Promise.reject(
              new Error(`Cannot call ${channel}: the connection to ${host} is closed.`),
            );
          }
          nextId += 1;
          const id = String(nextId);
          const frame: CallFrame = { kind: 'call', id, channel, payload };

          return new Promise<unknown>((resolvePayload, rejectPayload) => {
            const tooLarge = sendBounded(frame);
            if (tooLarge !== null) {
              rejectPayload(new RemoteCallError('frame-too-large', tooLarge));
              return;
            }
            /*
              `CALL_GIVE_UP_MS`, not `CALL_DEADLINE_MS`. The server answers its
              own timeout at the shorter number; giving up at or before that
              instant would abandon a call the server is still going to answer,
              which is the race the two constants exist as a pair to close.
            */
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectPayload(
                new RemoteCallError(
                  CALL_TIMEOUT_CODE,
                  `${channel} did not answer within ${String(CALL_GIVE_UP_MS)}ms.`,
                ),
              );
            }, CALL_GIVE_UP_MS);
            pending.set(id, { resolve: resolvePayload, reject: rejectPayload, timer });
          });
        },

        notify(channel, payload) {
          if (closed) return;
          const tooLarge = sendBounded({ kind: 'notify', channel, payload });
          if (tooLarge !== null) throw new RemoteCallError('frame-too-large', tooLarge);
        },

        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },

        snapshot() {
          return accepted.snapshot;
        },

        serverName() {
          return accepted.serverName;
        },

        close() {
          closed = true;
          socket.close();
        },
      };
    }
  });
}
