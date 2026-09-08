import { randomBytes } from 'node:crypto';
import { createServer as createNetServer, connect, type Socket } from 'node:net';

import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRemoteListener } from '@remote-host/listener';
import type { ServerDevice } from '@shared/config-contract';
import { CH } from '@shared/ipc-contract';
import { REMOTE_PROTOCOL_VERSION, type AttachRequest } from '@shared/remote-contract';

import { mintDevice } from '../../../electron/main/server/devices';
import type { RemoteDispatch } from '../../../electron/main/ipc/remote-dispatch';
import type { AttachedSocket } from '../../../electron/main/ipc/socket-broadcaster';

let listener: ReturnType<typeof createRemoteListener> | null = null;
afterEach(async () => {
  await listener?.stop();
  listener = null;
});

/**
 * `dispatch`/`onAttach`/`onDetach` a test does not care about — every
 * pre-existing HIVE-142 case in this file only exercises the handshake, so
 * these stand in wherever `createRemoteListener` is built without the
 * post-attach frame loop (HIVE-143) itself under test.
 */
const noopDispatch: RemoteDispatch = { call: vi.fn(), notify: vi.fn() };
const noopOnAttach = vi.fn();
const noopOnDetach = vi.fn();

const start = async (devices: readonly ServerDevice[], allowedOrigins: string[] = []) => {
  listener = createRemoteListener({
    bind: { host: '127.0.0.1', port: 0, allowedOrigins },
    devices: () => devices,
    serverName: 'test-mini',
    dispatch: noopDispatch,
    onAttach: noopOnAttach,
    onDetach: noopOnDetach,
  });
  const address = await listener.start();
  expect(address).not.toBeNull();
  return address as string;
};

/** Attach, and resolve with the single frame the server answers. */
const attach = (url: string, frame: unknown, headers: Record<string, string> = {}) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.on('open', () => socket.send(JSON.stringify(frame)));
    socket.on('message', (data) => {
      resolve(JSON.parse(String(data)));
      socket.close();
    });
    socket.on('error', reject);
  });

/**
 * Attach, but tolerate the server dropping the connection instead of
 * answering — `ws`'s own `close` code arrives in `code`, and `message` is
 * `null` when no reply frame preceded it. `ws`'s client cannot be made to
 * send a real attach frame that is also too large or malformed at the wire
 * level (it always produces well-formed, correctly masked frames), so this
 * is for cases where the *content* is what should be refused.
 */
const attachTolerant = (url: string, frame: unknown) =>
  new Promise<{ code: number | null; message: Record<string, unknown> | null }>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.on('open', () => socket.send(JSON.stringify(frame)));
    socket.on('message', (data) => {
      resolve({ code: null, message: JSON.parse(String(data)) });
      socket.close();
    });
    socket.on('close', (code) => resolve({ code, message: null }));
    socket.on('error', reject);
  });

/**
 * Speaks the WebSocket opening handshake by hand, for probes `ws`'s own
 * client cannot produce — an unmasked frame, or a request with no `Host`
 * header at all. Resolves once a full header block (ending `\r\n\r\n`) has
 * arrived, with the raw socket still open for the caller to drive further.
 */
const rawUpgrade = (url: string, headerLines: string[] = []) =>
  new Promise<{ statusLine: string; socket: Socket }>((resolve, reject) => {
    const { hostname, port, pathname } = new URL(url.replace(/^ws:/, 'http:'));
    const socket = connect(Number(port), hostname, () => {
      const key = randomBytes(16).toString('base64');
      const lines = [
        `GET ${pathname || '/'} HTTP/1.1`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        ...headerLines,
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    });
    let buffered = '';
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString('latin1');
      if (buffered.includes('\r\n\r\n')) {
        socket.off('data', onData);
        resolve({ statusLine: buffered.split('\r\n')[0] ?? '', socket });
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });

describe('the attach handshake', () => {
  it('accepts a known device with its token', async () => {
    const { device, token } = mintDevice('MacBook');
    const url = await start([device]);
    const reply = await attach(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: device.id,
      token,
    });
    expect(reply.kind).toBe('attach-accepted');
    expect(reply.serverName).toBe('test-mini');
  });

  it('refuses a wrong token as unauthorized', async () => {
    const { device } = mintDevice('MacBook');
    const url = await start([device]);
    const reply = await attach(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: device.id,
      token: 'AAAA-BBBB-CCCC-DDDD',
    });
    expect(reply).toMatchObject({ kind: 'attach-refused', code: 'unauthorized' });
  });

  it('refuses a revoked device as revoked, and says so', async () => {
    const { device, token } = mintDevice('MacBook');
    const url = await start([{ ...device, revoked: true }]);
    const reply = await attach(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: device.id,
      token,
    });
    expect(reply).toMatchObject({ kind: 'attach-refused', code: 'revoked' });
  });

  it('names both versions on a protocol mismatch', async () => {
    const { device, token } = mintDevice('MacBook');
    const url = await start([device]);
    const reply = await attach(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION + 1,
      deviceId: device.id,
      token,
    });
    expect(reply).toMatchObject({ kind: 'attach-refused', code: 'protocol-mismatch' });
    expect(String(reply.message)).toContain(String(REMOTE_PROTOCOL_VERSION));
    expect(String(reply.message)).toContain(String(REMOTE_PROTOCOL_VERSION + 1));
  });

  it('refuses a call frame that arrives before an attach', async () => {
    const { device } = mintDevice('MacBook');
    const url = await start([device]);
    const reply = await attach(url, { kind: 'call', id: '1', channel: 'config:get', args: [] });
    expect(reply).toMatchObject({ kind: 'attach-refused', code: 'unauthorized' });
  });

  it('sees a device added after start, because the list is read per handshake', async () => {
    const devices: ServerDevice[] = [];
    listener = createRemoteListener({
      bind: { host: '127.0.0.1', port: 0, allowedOrigins: [] },
      devices: () => devices,
      serverName: 'test-mini',
      dispatch: noopDispatch,
      onAttach: noopOnAttach,
      onDetach: noopOnDetach,
    });
    const url = (await listener.start()) as string;
    const { device, token } = mintDevice('LateBook');
    devices.push(device);
    const reply = await attach(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: device.id,
      token,
    });
    expect(reply.kind).toBe('attach-accepted');
  });
});

describe('the upgrade guard', () => {
  it('refuses an Origin when the allow-list is empty', async () => {
    const { device, token } = mintDevice('MacBook');
    const url = await start([device]);
    await expect(
      attach(
        url,
        { kind: 'attach', protocol: REMOTE_PROTOCOL_VERSION, deviceId: device.id, token },
        { Origin: 'http://evil.test' },
      ),
    ).rejects.toThrow();
  });

  it('admits a listed Origin', async () => {
    const { device, token } = mintDevice('MacBook');
    const url = await start([device], ['http://localhost:5173']);
    const reply = await attach(
      url,
      { kind: 'attach', protocol: REMOTE_PROTOCOL_VERSION, deviceId: device.id, token },
      { Origin: 'http://localhost:5173' },
    );
    expect(reply.kind).toBe('attach-accepted');
  });

  it('refuses an upgrade with no Host header at all', async () => {
    const { device } = mintDevice('MacBook');
    const url = await start([device]);
    // No `Host:` line — `rawUpgrade` adds none unless told to.
    const { statusLine, socket } = await rawUpgrade(url, []);
    expect(statusLine).toContain('403');
    socket.destroy();
  });
});

describe('an unauthenticated socket is untrusted input (HIVE-142 review)', () => {
  it('does not crash the listener on an unmasked frame, and keeps serving other sockets', async () => {
    const { device, token } = mintDevice('MacBook');
    const url = await start([device]);
    const { hostname, port } = new URL(url.replace(/^ws:/, 'http:'));

    const { statusLine, socket } = await rawUpgrade(url, [`Host: ${hostname}:${port}`]);
    expect(statusLine).toContain('101');

    const closed = new Promise<number>((resolve) => {
      // A close frame's code, if `ws` manages to send one before the raw
      // socket goes away — not asserted on below, just drained so the
      // socket does not dangle past the test.
      socket.once('close', () => resolve(0));
    });

    // A client-to-server frame with the MASK bit clear (byte 1's high bit).
    // RFC 6455 forbids this; `ws`'s own client can never produce it, which is
    // exactly why only a hand-rolled frame can prove the server's reaction to
    // one. FIN + text opcode (0x81), length 1 with MASK unset (0x01),
    // one payload byte ('A' = 0x41).
    socket.write(Buffer.from([0x81, 0x01, 0x41]));
    await closed;

    // The only way to prove "did not take the process down" from inside that
    // same process: something else must still work in it afterward.
    const reply = await attach(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: device.id,
      token,
    });
    expect(reply.kind).toBe('attach-accepted');
  });

  it('refuses an attach whose token is not a string, rather than throwing', async () => {
    const { device } = mintDevice('MacBook');
    const url = await start([device]);
    const reply = await attach(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: device.id,
      token: 12345,
    });
    expect(reply).toMatchObject({ kind: 'attach-refused', code: 'unauthorized' });
  });

  it('refuses an attach whose deviceId is not a string, rather than throwing', async () => {
    const { device } = mintDevice('MacBook');
    const url = await start([device]);
    const reply = await attach(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: { not: 'a string' },
      token: 'AAAA-BBBB-CCCC-DDDD',
    });
    expect(reply).toMatchObject({ kind: 'attach-refused', code: 'unauthorized' });
  });

  it('refuses an attach whose resumeFrom is not a map of numbers, rather than throwing', async () => {
    const { device, token } = mintDevice('MacBook');
    const url = await start([device]);
    const reply = await attach(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: device.id,
      token,
      resumeFrom: { 'session-1': 'not-a-number' },
    });
    expect(reply).toMatchObject({ kind: 'attach-refused', code: 'unauthorized' });
  });

  it('accepts an attach with a well-formed resumeFrom', async () => {
    const { device, token } = mintDevice('MacBook');
    const url = await start([device]);
    const reply = await attach(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: device.id,
      token,
      resumeFrom: { 'session-1': 42 },
    });
    expect(reply.kind).toBe('attach-accepted');
  });

  it('drops an oversized first frame rather than buffering it', async () => {
    const { device, token } = mintDevice('MacBook');
    const url = await start([device]);
    // Well past `ATTACH_MAX_PAYLOAD_BYTES` (8 KiB) once serialised.
    const { code, message } = await attachTolerant(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: device.id,
      token,
      padding: 'x'.repeat(20_000),
    });
    expect(message).toBeNull();
    // 1009 is `ws`'s own "Message Too Big" close code — the direct signature
    // of `maxPayload`, not just "something went wrong".
    expect(code).toBe(1009);
  });

  it('drops a socket that never sends an attach frame, after the handshake deadline', async () => {
    // Fake timers, not a real wait — the deadline itself is the behaviour
    // under test, and `listener.ts`'s `setTimeout` is a global the fake
    // clock intercepts in this same process, so advancing it fires the real
    // production timer without the test actually waiting in wall-clock time.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { device } = mintDevice('MacBook');
      const url = await start([device]);
      const socket = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => resolve());
        socket.on('error', reject);
      });

      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      // Comfortably past the production deadline without importing its exact
      // value — the constant is intentionally not exported, and "eventually
      // drops a silent socket" does not need to pin the exact number.
      await vi.advanceTimersByTimeAsync(60_000);
      await closed;

      expect(socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('start()/stop() lifecycle', () => {
  it('resolves start() with null and leaves boundHost null on a bind failure', async () => {
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('expected an AddressInfo');
    const port = address.port;

    listener = createRemoteListener({
      bind: { host: '127.0.0.1', port, allowedOrigins: [] },
      devices: () => [],
      serverName: 'test-mini',
      dispatch: noopDispatch,
      onAttach: noopOnAttach,
      onDetach: noopOnDetach,
    });
    const result = await listener.start();
    expect(result).toBeNull();
    expect(listener.boundHost).toBeNull();

    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  /**
   * HIVE-142 review, I3: a bind failure used to be silent everywhere — no
   * log, and `boundHost === null` is indistinguishable from "still
   * starting". Both the log and `lastBindError` have to name the real cause.
   */
  it('logs the bind failure with its cause, and records it on lastBindError', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('expected an AddressInfo');
    const port = address.port;

    listener = createRemoteListener({
      bind: { host: '127.0.0.1', port, allowedOrigins: [] },
      devices: () => [],
      serverName: 'test-mini',
      dispatch: noopDispatch,
      onAttach: noopOnAttach,
      onDetach: noopOnDetach,
    });
    await listener.start();

    expect(listener.lastBindError).toEqual(expect.stringContaining('EADDRINUSE'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('EADDRINUSE'));

    errorSpy.mockRestore();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  /**
   * HIVE-142 review, M2: on a pre-listen error the handler used to leave
   * `wss` assigned and the half-created `http.Server` unclosed, and `stop()`
   * early-returns on `server === null` — so neither was ever closed. Both
   * have to be cleaned up on the failure path itself.
   */
  it('closes the half-created WebSocketServer on a bind failure, rather than leaking it', async () => {
    const wssCloseSpy = vi.spyOn(WebSocketServer.prototype, 'close');
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('expected an AddressInfo');
    const port = address.port;

    listener = createRemoteListener({
      bind: { host: '127.0.0.1', port, allowedOrigins: [] },
      devices: () => [],
      serverName: 'test-mini',
      dispatch: noopDispatch,
      onAttach: noopOnAttach,
      onDetach: noopOnDetach,
    });
    await listener.start();

    expect(wssCloseSpy).toHaveBeenCalled();

    wssCloseSpy.mockRestore();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it('clears lastBindError once a later start() actually binds', async () => {
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('expected an AddressInfo');
    const port = address.port;

    const failing = createRemoteListener({
      bind: { host: '127.0.0.1', port, allowedOrigins: [] },
      devices: () => [],
      serverName: 'test-mini',
      dispatch: noopDispatch,
      onAttach: noopOnAttach,
      onDetach: noopOnDetach,
    });
    await failing.start();
    expect(failing.lastBindError).not.toBeNull();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));

    // A fresh listener, since `bind.port` is fixed per instance: proves the
    // field genuinely reports "no error", not merely "never checked again".
    listener = createRemoteListener({
      bind: { host: '127.0.0.1', port: 0, allowedOrigins: [] },
      devices: () => [],
      serverName: 'test-mini',
      dispatch: noopDispatch,
      onAttach: noopOnAttach,
      onDetach: noopOnDetach,
    });
    await listener.start();
    expect(listener.lastBindError).toBeNull();
  });

  it('resolves stop() before start() was ever called', async () => {
    listener = createRemoteListener({
      bind: { host: '127.0.0.1', port: 0, allowedOrigins: [] },
      devices: () => [],
      serverName: 'test-mini',
      dispatch: noopDispatch,
      onAttach: noopOnAttach,
      onDetach: noopOnDetach,
    });
    await expect(listener.stop()).resolves.toBeUndefined();
  });

  it('resolves stop() called twice', async () => {
    await start([]);
    await listener?.stop();
    await expect(listener?.stop()).resolves.toBeUndefined();
  });

  it('resolves stop() even when a client is still attached (HIVE-142 review, I4)', async () => {
    const { device, token } = mintDevice('MacBook');
    const url = await start([device]);
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            kind: 'attach',
            protocol: REMOTE_PROTOCOL_VERSION,
            deviceId: device.id,
            token,
          }),
        );
      });
      // Deliberately does not close the socket after the reply — this is the
      // regression case: a client that stays attached across `stop()`.
      socket.on('message', () => resolve());
      socket.on('error', reject);
    });

    await listener?.stop();
  }, 3_000);
});

/**
 * Flushes every pending microtask — the `.then()` a `dispatch.call` answer
 * travels through before it reaches `socketHandle.send()`. `setImmediate`
 * runs after Node fully drains the microtask queue, regardless of how many
 * `.then()`s are chained, which is what makes this reliable where a fixed
 * number of `await Promise.resolve()`s would not be.
 */
const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Drives a real attach handshake against a `createRemoteListener` built with
 * one stub device, then hands back the **server-side** connection object —
 * not the client's — plus every frame the listener has sent on it since.
 *
 * The server-side object is captured off `WebSocketServer.prototype.emit`,
 * which `listener.ts`'s own `'upgrade'` handler calls directly
 * (`sockets.emit('connection', ws, req)`) — nothing else exposes it, since
 * `onAttach` is handed a wrapper (`AttachedSocket`), not the socket itself.
 * A real `ws.WebSocket` is an `EventEmitter` underneath, so calling
 * `.emit('message', ...)` on this captured object invokes `listener.ts`'s own
 * `.on('message', ...)` handler synchronously, in-process — the same handler
 * a real frame would reach — without a second real round trip's
 * non-deterministic tick count.
 *
 * `sent` is filled by a spy on this same socket's own `.send`, not by
 * reading the real client's `'message'` event: a spy records the instant
 * `listener.ts` calls it, while the real client only learns of a write after
 * genuine loopback I/O completes, which is not bounded by a microtask flush.
 *
 * `.emit('close')` on the returned socket is real-`terminate()`d immediately
 * after: firing only the synthetic event would run `listener.ts`'s `'close'`
 * handler (what the test wants) while also running `ws`'s own internal
 * `'close'` listener, which drops the socket from `WebSocketServer#clients`
 * — the exact set `stop()` walks to tear down what is, underneath the fake
 * event, still a genuinely open connection. Terminating for real keeps that
 * bookkeeping honest so `afterEach`'s `listener.stop()` does not hang.
 */
const attachedSocket = async (
  overrides: {
    dispatch?: RemoteDispatch;
    onAttach?: (socket: AttachedSocket, resumeFrom: Readonly<Record<string, number>> | undefined) => void;
    onDetach?: (socket: AttachedSocket) => void;
    attach?: Partial<AttachRequest>;
  } = {},
): Promise<{ socket: WebSocket; sent: unknown[] }> => {
  const dispatch: RemoteDispatch = overrides.dispatch ?? { call: vi.fn(), notify: vi.fn() };
  const onAttach = overrides.onAttach ?? vi.fn();
  const onDetach = overrides.onDetach ?? vi.fn();
  const { device, token } = mintDevice('MacBook');

  const emitSpy = vi.spyOn(WebSocketServer.prototype, 'emit');

  listener = createRemoteListener({
    bind: { host: '127.0.0.1', port: 0, allowedOrigins: [] },
    devices: () => [device],
    serverName: 'test-mini',
    dispatch,
    onAttach,
    onDetach,
  });
  const url = await listener.start();
  expect(url).not.toBeNull();

  const client = new WebSocket(url as string);
  await new Promise<void>((resolve, reject) => {
    client.on('open', () => resolve());
    client.on('error', reject);
  });

  const accepted = new Promise<void>((resolve, reject) => {
    client.once('message', (data) => {
      const reply = JSON.parse(String(data)) as { kind: string };
      if (reply.kind === 'attach-accepted') resolve();
      else reject(new Error(`attach was refused: ${String(data)}`));
    });
  });
  client.send(
    JSON.stringify({
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: device.id,
      token,
      ...overrides.attach,
    }),
  );
  await accepted;

  const connectionCall = emitSpy.mock.calls.find((call) => call[0] === 'connection');
  emitSpy.mockRestore();
  const socket = connectionCall?.[1] as WebSocket;

  const sent: unknown[] = [];
  vi.spyOn(socket, 'send').mockImplementation((data: unknown) => {
    sent.push(JSON.parse(String(data)));
  });

  const rawEmit = socket.emit.bind(socket);
  socket.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
    const result = rawEmit(event, ...args);
    if (event === 'close') socket.terminate();
    return result;
  }) as typeof socket.emit;

  return { socket, sent };
};

describe('post-attach frames', () => {
  it('answers a call frame with whatever dispatch returns', async () => {
    const dispatch: RemoteDispatch = {
      call: vi.fn(async () => ({ kind: 'result' as const, id: 'c1', payload: { ok: true } })),
      notify: vi.fn(),
    };
    const { socket, sent } = await attachedSocket({ dispatch });

    socket.emit('message', JSON.stringify({ kind: 'call', id: 'c1', channel: CH.configGet, payload: null }));
    await flushMicrotasks();

    expect(dispatch.call).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'call', id: 'c1', channel: CH.configGet }),
    );
    expect(sent).toContainEqual({ kind: 'result', id: 'c1', payload: { ok: true } });
  });

  it('routes a notify frame to dispatch and sends nothing back', async () => {
    const dispatch = { call: vi.fn(), notify: vi.fn() };
    const { socket, sent } = await attachedSocket({ dispatch });
    const before = sent.length;

    socket.emit('message', JSON.stringify({ kind: 'notify', channel: CH.ptyAck, payload: { seq: 1 } }));
    await flushMicrotasks();

    expect(dispatch.notify).toHaveBeenCalled();
    expect(sent.length).toBe(before);
  });

  it('hands the socket a reporter whose destroyed listener fires on close', async () => {
    const dispatch = { call: vi.fn(), notify: vi.fn() };
    const { socket } = await attachedSocket({ dispatch });
    socket.emit('message', JSON.stringify({ kind: 'notify', channel: CH.ptyPrompt, payload: { sessionId: 's1', input: 'empty' } }));
    await flushMicrotasks();

    const reporter = dispatch.notify.mock.calls[0][1] as { on: (e: string, l: () => void) => unknown };
    const onDestroyed = vi.fn();
    reporter.on('destroyed', onDestroyed);
    socket.emit('close');

    expect(onDestroyed).toHaveBeenCalledTimes(1);
  });

  it('reports the socket attached, with resumeFrom, and detached on close', async () => {
    const onAttach = vi.fn();
    const onDetach = vi.fn();
    const { socket } = await attachedSocket({
      onAttach,
      onDetach,
      attach: { resumeFrom: { s1: 7 } },
    });

    expect(onAttach).toHaveBeenCalledWith(expect.anything(), { s1: 7 });

    socket.emit('close');
    expect(onDetach).toHaveBeenCalledTimes(1);
  });

  it('passes resumeFrom as undefined when the client omitted it', async () => {
    const onAttach = vi.fn();
    await attachedSocket({ onAttach });

    expect(onAttach).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('drops a second attach frame rather than re-running the handshake', async () => {
    const dispatch = { call: vi.fn(), notify: vi.fn() };
    const { socket, sent } = await attachedSocket({ dispatch });
    const before = sent.length;

    socket.emit('message', JSON.stringify({ kind: 'attach', protocol: 1, deviceId: 'd', token: 't' }));
    await flushMicrotasks();

    /*
      Dropped, not refused. `AttachRefusalCode` names four reasons and none of
      them is "you already attached"; adding a fifth would change the wire and
      force a protocol bump for a case only a buggy client can reach. Silence
      costs that client nothing it did not already have.
    */
    expect(dispatch.call).not.toHaveBeenCalled();
    expect(dispatch.notify).not.toHaveBeenCalled();
    expect(sent.length).toBe(before);
  });

  it('drops a frame that is not JSON without killing the socket', async () => {
    const dispatch = { call: vi.fn(), notify: vi.fn() };
    const { socket } = await attachedSocket({ dispatch });

    expect(() => socket.emit('message', 'not json')).not.toThrow();
    expect(dispatch.call).not.toHaveBeenCalled();
  });

  it('drops a frame whose kind is not call or notify', async () => {
    const dispatch = { call: vi.fn(), notify: vi.fn() };
    const { socket } = await attachedSocket({ dispatch });

    socket.emit('message', JSON.stringify({ kind: 'result', id: 'x', payload: null }));
    await flushMicrotasks();

    expect(dispatch.call).not.toHaveBeenCalled();
    expect(dispatch.notify).not.toHaveBeenCalled();
  });
});
