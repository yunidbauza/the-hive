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
 */

export interface RemoteListener {
  /** Starts listening. Resolves the bound address, or `null` on bind failure. */
  start: () => Promise<string | null>;
  /** Closes the socket. Resolves once it is actually closed. */
  stop: () => Promise<void>;
  /** What the kernel actually bound to, or `null` before `start` / after `stop`. */
  readonly boundHost: string | null;
}

export function createRemoteListener(options: {
  bind: ServerBindConfig;
  /**
   * Read once per handshake, never cached at construction.
   *
   * `--pair` runs in a separate process from the running server, appending a
   * device to the config file on disk. The only way an already-listening
   * server sees that new device without a restart is by calling this getter
   * fresh on every attach rather than capturing its result once at `start()`.
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
          one line.
        */
        const created = createServer((_req, res) => {
          res.writeHead(426, { 'content-type': 'text/plain' }).end('Upgrade required');
        });

        const sockets = new WebSocketServer({ noServer: true });
        sockets.on('connection', (socket: WebSocket) => {
          /*
            Exactly one frame is read from an unattached socket: the brief's
            entire handshake surface. `once` rather than `on` — anything past
            the first frame on a socket that never attached is scope this
            story does not own, and the connection is closed either way once
            this handler decides.
          */
          socket.once('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
            let frame: unknown;
            try {
              frame = JSON.parse(String(data));
            } catch {
              refuse(socket, unauthorized('Malformed first frame.'));
              return;
            }

            if (
              frame === null ||
              typeof frame !== 'object' ||
              (frame as { kind?: unknown }).kind !== 'attach'
            ) {
              // A `call`, a `notify`, or anything else arriving first is
              // refused exactly like a bad credential would be — an
              // unattached socket has no standing to be told which kind of
              // mistake it made.
              refuse(socket, unauthorized('The first frame on a connection must be an attach.'));
              return;
            }

            const request = frame as AttachRequest;

            /*
              Protocol before authorization, deliberately. A client on a
              mismatched build should be told that — it costs nothing to check
              and leaks nothing to answer — rather than being told its
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
            // The socket now sits attached with nothing further wired to it.
            // That is the whole surface this story owns.
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
            const line = status === 400 ? 'Bad Request' : 'Forbidden';
            // A real status line, not a silent drop — `ws`'s client parses
            // this as an HTTP response and surfaces it as a connection error
            // rather than hanging.
            socket.write(`HTTP/1.1 ${String(status)} ${line}\r\nConnection: close\r\n\r\n`);
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
          resolve(`ws://${bind.host}:${String(address.port)}`);
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
        if (running === null) {
          resolve();
          return;
        }
        runningSockets?.close();
        running.close(() => resolve());
        running.closeAllConnections?.();
      });
    },
  };
}
