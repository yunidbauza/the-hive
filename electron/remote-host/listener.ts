import { createServer, type Server } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import type { ServerBindConfig, ServerDevice } from '@shared/config-contract';
import {
  REMOTE_PROTOCOL_VERSION,
  type AttachRefused,
  type AttachRequest,
  type ServerFrame,
} from '@shared/remote-contract';

import { createOriginGuard } from '../main/hooks/http-guard';
import { verifyDevice } from '../main/server/devices';

import { refuseProtocol } from './index';

/**
 * The listener half of server mode (HIVE-142): a second `node:http` server,
 * bound to `server.bind`, that accepts a `ws` upgrade and completes the attach
 * handshake. Nothing else.
 *
 * **Scope, stated so the next story does not creep backward into this one.**
 * A socket that attaches successfully is handed nothing further — no call
 * routing, no event delivery, no PTY bytes. That is HIVE-143's `router.ts`,
 * wired in from `electron/main/**`, which this module may import but does not
 * yet need to. Building any of that here would be answering a question this
 * story was not asked.
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
 */
const ATTACH_HANDSHAKE_TIMEOUT_MS = 5_000;

/**
 * The most a first frame may weigh, enforced by `ws` itself via
 * `WebSocketServer`'s `maxPayload`.
 *
 * An attach frame — `kind`, `protocol`, `deviceId`, `token`, and an optional
 * `resumeFrom` map — is a few hundred bytes even with a realistic session
 * count in `resumeFrom`. `ws` defaults `maxPayload` to 100 MiB, which is a
 * limit sized for a data channel, not a handshake; an unauthenticated peer
 * should not get to make this process buffer that much before the frame is
 * even inspected. The same discipline the hook receiver applies per route
 * (`HOOK_MAX_BODY_BYTES` and its siblings in `electron/shared/hook-contract.ts`)
 * applies here, sized for what this one frame actually needs.
 */
const ATTACH_MAX_PAYLOAD_BYTES = 8 * 1024;

export interface RemoteListener {
  /** Starts listening. Resolves the bound address, or `null` on bind failure. */
  start: () => Promise<string | null>;
  /** Closes the socket. Resolves once it is actually closed. */
  stop: () => Promise<void>;
  /** What the kernel actually bound to, or `null` before `start` / after `stop`. */
  readonly boundHost: string | null;
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
 * Whether every value in `value` is a `number` — {@link AttachRequest.resumeFrom}'s
 * shape, checked so {@link isAttachShaped} does not claim a field it never
 * inspected. This story never reads `resumeFrom`, but the predicate's return
 * type says the whole `AttachRequest` is safe to use, and HIVE-143 is the
 * story that will actually consume this field — a predicate that skipped it
 * would be handing that story a lie it has no reason to suspect.
 */
function isResumeFromShaped(value: unknown): value is Readonly<Record<string, number>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'number');
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
}): RemoteListener {
  const { bind, devices, serverName } = options;

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
  });

  let server: Server | null = null;
  let wss: WebSocketServer | null = null;
  let boundHost: string | null = null;

  /**
   * Every armed handshake-deadline timer that has not yet fired or been
   * cleared. `stop()` clears whatever is left so a timer belonging to a
   * listener that no longer exists cannot fire against it later — load-
   * bearing for a test process, where a leaked `setTimeout` is a handle that
   * outlives the test it was created in.
   */
  const pendingTimers = new Set<NodeJS.Timeout>();

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

  return {
    get boundHost() {
      return boundHost;
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

        const sockets = new WebSocketServer({ noServer: true, maxPayload: ATTACH_MAX_PAYLOAD_BYTES });
        sockets.on('connection', (socket: WebSocket) => {
          /*
            Armed the instant the socket exists, cleared the instant a first
            frame arrives (or the socket closes or errors on its own) — see
            `ATTACH_HANDSHAKE_TIMEOUT_MS` (I5, HIVE-142 review).
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
          socket.once('close', clearHandshakeTimer);

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
          socket.once('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
            clearHandshakeTimer();

            try {
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

              send(socket, {
                kind: 'attach-accepted',
                protocol: REMOTE_PROTOCOL_VERSION,
                serverName,
                // No IPC surface exists on this socket yet (HIVE-143) — an
                // empty snapshot is the honest answer, not a placeholder.
                snapshot: {},
              });
              // The socket now sits attached with nothing further wired to
              // it. That is the whole surface this story owns.
            } catch {
              /*
                Belt and suspenders under `isAttachShaped`'s own validation:
                anything this handler did not anticipate refuses the socket
                rather than throwing past it (C2, HIVE-142 review). If even
                the refusal cannot be sent — the socket is already going down
                — terminate rather than let a second exception through.
              */
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

          sockets.handleUpgrade(req, socket, head, (ws) => {
            sockets.emit('connection', ws, req);
          });
        });

        created.on('error', () => {
          // Only a bind failure clears the handles — see `stop()` and
          // `receiver.ts`'s identical guard for why `server === null` is the
          // discriminator between "never bound" and "bound, then errored".
          if (server === null) {
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
        // but one armed against a socket that never sent anything must not
        // survive the listener it belongs to.
        for (const timer of pendingTimers) clearTimeout(timer);
        pendingTimers.clear();

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
