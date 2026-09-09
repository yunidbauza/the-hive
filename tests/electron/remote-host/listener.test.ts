import { randomBytes } from 'node:crypto';
import { createServer as createNetServer, connect, type Socket } from 'node:net';

import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ATTACH_HANDSHAKE_TIMEOUT_MS,
  SNAPSHOT_READ_BUDGET_MS,
  createRemoteListener,
} from '@remote-host/listener';
import type { ServerDevice } from '@shared/config-contract';
import { MAX_FILE_BYTES } from '@shared/fs-contract';
import { CH, type Channel } from '@shared/ipc-contract';
import {
  ATTACH_FRAME_MAX_BYTES,
  CALL_DEADLINE_MS,
  CALL_TIMEOUT_CODE,
  POST_ATTACH_FRAME_MAX_BYTES,
  REMOTE_PROTOCOL_VERSION,
  SNAPSHOT_CHANNELS,
  type AttachRequest,
  type CallFrame,
  type ErrorFrame,
  type ResultFrame,
  type ResumePoint,
} from '@shared/remote-contract';

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
/** An empty snapshot — every pre-existing case in this file is silent on HIVE-144. */
const noopBuildSnapshot = (): Promise<Partial<Record<Channel, unknown>>> =>
  Promise.resolve({});

const start = async (devices: readonly ServerDevice[], allowedOrigins: string[] = []) => {
  listener = createRemoteListener({
    bind: { host: '127.0.0.1', port: 0, allowedOrigins },
    devices: () => devices,
    serverName: 'test-mini',
    dispatch: noopDispatch,
    buildSnapshot: noopBuildSnapshot,
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
      buildSnapshot: noopBuildSnapshot,
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

  it('refuses an attach whose resumeFrom is not a map of {gen, seq} points, rather than throwing', async () => {
    const { device, token } = mintDevice('MacBook');
    const url = await start([device]);
    const reply = await attach(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: device.id,
      token,
      resumeFrom: { 'session-1': 'not-a-point' },
    });
    expect(reply).toMatchObject({ kind: 'attach-refused', code: 'unauthorized' });
  });

  it("refuses a v1 client's bare-number resumeFrom rather than reinterpreting it (HIVE-144)", async () => {
    /**
     * `{ 'session-1': 42 }` was the whole shape of a well-formed `resumeFrom`
     * under protocol 1. A server that coerced it into `{ gen: 42, seq: 0 }` or
     * similar would silently misread an old client instead of refusing the
     * handshake — exactly what `REMOTE_PROTOCOL_VERSION` moving to 2 exists to
     * prevent.
     */
    const { device, token } = mintDevice('MacBook');
    const url = await start([device]);
    const reply = await attach(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: device.id,
      token,
      resumeFrom: { 'session-1': 42 },
    });
    expect(reply).toMatchObject({ kind: 'attach-refused', code: 'unauthorized' });
  });

  it('refuses a resumeFrom point with a negative gen (HIVE-144)', async () => {
    /**
     * `Number.isInteger` alone would accept `-1`. Both `gen` and `seq` are
     * counters this file's peers only ever increment, so a negative one is
     * never an honest client's — refusing it here, before authentication,
     * is cheaper than discovering downstream that `sessions.resume` was
     * never meant to see one.
     */
    const { device, token } = mintDevice('MacBook');
    const url = await start([device]);
    const reply = await attach(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: device.id,
      token,
      resumeFrom: { 'session-1': { gen: -1, seq: 0 } },
    });
    expect(reply).toMatchObject({ kind: 'attach-refused', code: 'unauthorized' });
  });

  it('refuses a resumeFrom point with a fractional gen (HIVE-144)', async () => {
    // `typeof 1.5 === 'number'` — only `Number.isInteger` catches this.
    const { device, token } = mintDevice('MacBook');
    const url = await start([device]);
    const reply = await attach(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: device.id,
      token,
      resumeFrom: { 'session-1': { gen: 1.5, seq: 0 } },
    });
    expect(reply).toMatchObject({ kind: 'attach-refused', code: 'unauthorized' });
  });

  it('refuses a resumeFrom point with a missing seq (HIVE-144)', async () => {
    // `{ gen: 1 }` alone is an object, and would pass a check that only
    // confirmed the value is an object with a numeric `gen`.
    const { device, token } = mintDevice('MacBook');
    const url = await start([device]);
    const reply = await attach(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: device.id,
      token,
      resumeFrom: { 'session-1': { gen: 1 } },
    });
    expect(reply).toMatchObject({ kind: 'attach-refused', code: 'unauthorized' });
  });

  it('accepts an attach with a well-formed {gen, seq} resumeFrom', async () => {
    const { device, token } = mintDevice('MacBook');
    const url = await start([device]);
    const reply = await attach(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: device.id,
      token,
      resumeFrom: { 'session-1': { gen: 1, seq: 42 } },
    });
    expect(reply.kind).toBe('attach-accepted');
  });

  it('refuses an oversized first frame rather than parsing it', async () => {
    const { device, token } = mintDevice('MacBook');
    const url = await start([device]);
    /*
      Well past `ATTACH_FRAME_MAX_BYTES` (8 KiB) once serialised, and well
      *under* `POST_ATTACH_FRAME_MAX_BYTES` — so `ws` delivers it and
      `listener.ts`'s own explicit check is the thing that refuses it. That
      split is the whole of the HIVE-143 review fix: the 8 KiB bound is the
      handshake's, and it has to be enforced somewhere that knows which frame
      is the first one.
    */
    const { code, message } = await attachTolerant(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: device.id,
      token,
      padding: 'x'.repeat(20_000),
    });
    // Refused with a frame, where `maxPayload` used to drop the socket
    // wordlessly. An oversized attach is a client bug worth naming, and the
    // credentials inside it were never read.
    expect(code).toBeNull();
    expect(message).toMatchObject({ kind: 'attach-refused', code: 'unauthorized' });
  });

  it('still lets ws drop a first frame past the connection-wide ceiling', async () => {
    const { device, token } = mintDevice('MacBook');
    const url = await start([device]);
    // Past `POST_ATTACH_FRAME_MAX_BYTES` (8 MiB), so `ws` never delivers it and
    // the explicit check above never runs — which proves the ceiling is a real
    // bound and not an absent one.
    const { code, message } = await attachTolerant(url, {
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: device.id,
      token,
      padding: 'x'.repeat(9 * 1024 * 1024),
    });
    expect(message).toBeNull();
    /*
      1009 is `ws`'s own "Message Too Big"; 1006 is that same refusal seen by a
      client that was still writing five megabytes when the server dropped the
      connection under it, so no close frame ever reached it. Which one arrives
      is loopback timing rather than behaviour — `listener.ts`'s `'error'`
      handler terminates the socket, and whether `ws`'s close frame flushes
      first depends on how much of the frame is still in the send buffer. Both
      mean refused-and-dropped, and pinning one of them would be pinning the
      kernel's buffering.
    */
    expect([1006, 1009]).toContain(code);
  }, 20_000);

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

/**
 * The concurrency half of the frame-size bound (HIVE-143 review).
 *
 * `ATTACH_HANDSHAKE_TIMEOUT_MS` bounds what one unauthenticated socket costs;
 * nothing bounded how many there could be, so a peer that clears the header
 * guard could open sockets in a loop and make `ws` arm a `Receiver` willing to
 * buffer `POST_ATTACH_FRAME_MAX_BYTES` for each of them. `MAX_UNATTACHED_SOCKETS`
 * is that bound.
 *
 * The cases below never name the number. It is deliberately not exported, and
 * what has to hold is "there is a cap, it frees on attach, it frees on close" —
 * pinning eight would pin a choice, not the behaviour.
 */
describe('the concurrent unattached-socket cap (HIVE-143 review)', () => {
  /** Opens a socket and leaves it silent — the shape the cap counts. */
  const openSilent = (url: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.on('open', () => resolve(socket));
      socket.on('error', reject);
    });

  /**
   * Opens silent sockets until one is refused, and hands back both halves.
   *
   * Sequential rather than parallel: the cap is read on the upgrade request, so
   * a batch fired at once would race the increments and make "the (N+1)th" a
   * statement about scheduling rather than about the guard.
   */
  const fillHandshakeSlots = async (url: string): Promise<{ opened: WebSocket[]; refusal: Error }> => {
    const opened: WebSocket[] = [];
    for (let attempt = 0; attempt < 64; attempt += 1) {
      try {
        opened.push(await openSilent(url));
      } catch (cause) {
        return { opened, refusal: cause as Error };
      }
    }
    for (const socket of opened) socket.terminate();
    throw new Error('the listener accepted 64 silent sockets without ever refusing one');
  };

  /**
   * Opens a socket, retrying while the cap is full — with a deadline **under**
   * `ATTACH_HANDSHAKE_TIMEOUT_MS` (5s).
   *
   * That is what makes the two cases below mean anything: the handshake
   * deadline frees every silent slot on its own, so a generous retry window
   * would pass whether or not attaching and closing free a slot. Two seconds
   * cannot be the timeout doing the work.
   */
  const openWhenAdmitted = async (url: string): Promise<WebSocket> => {
    const deadline = Date.now() + 2_000;
    for (;;) {
      try {
        return await openSilent(url);
      } catch (cause) {
        if (Date.now() > deadline) throw cause as Error;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
  };

  /** Sends a real attach on an already-open socket, and waits for the accept. */
  const attachOn = (socket: WebSocket, deviceId: string, token: string) =>
    new Promise<void>((resolve, reject) => {
      socket.once('message', (data) => {
        const reply = JSON.parse(String(data)) as { kind: string };
        if (reply.kind === 'attach-accepted') resolve();
        else reject(new Error(`attach was refused: ${String(data)}`));
      });
      socket.send(
        JSON.stringify({ kind: 'attach', protocol: REMOTE_PROTOCOL_VERSION, deviceId, token }),
      );
    });

  let logged: ReturnType<typeof vi.spyOn> | null = null;
  afterEach(() => {
    logged?.mockRestore();
    logged = null;
  });

  it('refuses the socket past the cap with a status line, rather than buffering for it', async () => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { device } = mintDevice('MacBook');
    const url = await start([device]);

    const { opened, refusal } = await fillHandshakeSlots(url);

    /*
      A real cap, not a degenerate one: more than a single socket may be
      mid-handshake at a time, and the refusal is an HTTP status line rather
      than a silent drop — `ws`'s client surfaces 503 as a connection error
      instead of hanging, which is the same courtesy the Origin/Host refusal
      pays. 503 and not 403: the peer is not forbidden, the server is out of
      handshake slots for a moment.
    */
    expect(opened.length).toBeGreaterThan(1);
    expect(refusal.message).toContain('503');
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('mid-handshake'));

    for (const socket of opened) socket.terminate();
  }, 20_000);

  it('admits another socket once a mid-handshake one closes', async () => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { device } = mintDevice('MacBook');
    const url = await start([device]);
    const { opened } = await fillHandshakeSlots(url);

    opened[0]?.terminate();
    const admitted = await openWhenAdmitted(url);

    expect(admitted.readyState).toBe(WebSocket.OPEN);
    admitted.terminate();
    for (const socket of opened) socket.terminate();
  }, 20_000);

  it('admits another socket once a mid-handshake one attaches, because attached sockets do not count', async () => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { device, token } = mintDevice('MacBook');
    const url = await start([device]);
    const { opened } = await fillHandshakeSlots(url);

    const first = opened[0];
    if (first === undefined) throw new Error('expected at least one open socket');
    await attachOn(first, device.id, token);
    const admitted = await openWhenAdmitted(url);

    /*
      The cap governs the *unauthenticated* phase. An attached socket has proven
      a device credential and is tracked by `onAttach`/`onDetach`; counting it
      here would cap how many paired devices may be connected at once, which is
      a different question with a different right answer.
    */
    expect(admitted.readyState).toBe(WebSocket.OPEN);
    expect(first.readyState).toBe(WebSocket.OPEN);
    admitted.terminate();
    for (const socket of opened) socket.terminate();
  }, 20_000);
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
      buildSnapshot: noopBuildSnapshot,
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
      buildSnapshot: noopBuildSnapshot,
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
      buildSnapshot: noopBuildSnapshot,
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
      buildSnapshot: noopBuildSnapshot,
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
      buildSnapshot: noopBuildSnapshot,
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
      buildSnapshot: noopBuildSnapshot,
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
    onAttach?: (socket: AttachedSocket, resumeFrom: Readonly<Record<string, ResumePoint>> | undefined) => void;
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
    buildSnapshot: noopBuildSnapshot,
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
      attach: { resumeFrom: { s1: { gen: 1, seq: 7 } } },
    });

    expect(onAttach).toHaveBeenCalledWith(expect.anything(), { s1: { gen: 1, seq: 7 } });

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

  /**
   * HIVE-143 review: `onAttach` can throw — it iterates `resumeFrom` and calls
   * into the session layer to do it — and the outer `catch` used to answer
   * `attach-refused` on a socket that had already been sent `attach-accepted`.
   * The wire contract describes no such sequence and a client is entitled to be
   * confused by one.
   */
  it('does not refuse an attach it has already accepted', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onDetach = vi.fn();
    const { device, token } = mintDevice('MacBook');
    listener = createRemoteListener({
      bind: { host: '127.0.0.1', port: 0, allowedOrigins: [] },
      devices: () => [device],
      serverName: 'test-mini',
      dispatch: noopDispatch,
      buildSnapshot: noopBuildSnapshot,
      onAttach: () => {
        throw new Error('the replay loop blew up');
      },
      onDetach,
    });
    const url = (await listener.start()) as string;

    const client = new WebSocket(url);
    const kinds: string[] = [];
    client.on('message', (data) => kinds.push((JSON.parse(String(data)) as { kind: string }).kind));
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => resolve());
      client.on('error', reject);
    });
    client.send(
      JSON.stringify({ kind: 'attach', protocol: REMOTE_PROTOCOL_VERSION, deviceId: device.id, token }),
    );
    await closed;

    /*
      The accept, and nothing after it. The socket is dropped — which a client
      already has a branch for — the failure is logged on this side, and
      `onDetach` still runs, because the `'close'` listener is registered before
      `onAttach` precisely so a throw there cannot strand a handle in the
      fan-out set.
    */
    expect(kinds).toEqual(['attach-accepted']);
    expect(onDetach).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('after attach-accepted'),
      expect.anything(),
    );
    logged.mockRestore();
  });

  it('reuses one reporter across every notify frame from a socket', async () => {
    const dispatch = { call: vi.fn(), notify: vi.fn() };
    const { socket } = await attachedSocket({ dispatch });

    const report = (input: string): void => {
      socket.emit(
        'message',
        JSON.stringify({ kind: 'notify', channel: CH.ptyPrompt, payload: { sessionId: 's1', input } }),
      );
    };
    report('draft');
    report('empty');
    await flushMicrotasks();

    /*
      The **same object**, not merely one of the same shape. `watchReporter` in
      `ipc/index.ts` dedupes by identity through a `WeakSet`, so a fresh
      reporter per frame would register a new `destroyed` listener on every
      keystroke report — pushing into this socket's `closeListeners` array
      without bound, and firing `deliver.onRendererReset()` once per keystroke
      on close. Nothing else in this file would notice: every other assertion
      here is about what a reporter *does*, and a fresh one does the same thing.
    */
    expect(dispatch.notify).toHaveBeenCalledTimes(2);
    const first = dispatch.notify.mock.calls[0]![1];
    const second = dispatch.notify.mock.calls[1]![1];
    expect(second).toBe(first);
  });
});

/**
 * The call deadline (HIVE-144): `dispatch.call` never rejects, but a handler
 * can fail to settle at all — `agents:run` genuinely can, per
 * `listener.ts`'s own comment at the `dispatch.call` site. Fake timers
 * throughout, armed *after* {@link attachedSocket}'s real handshake has
 * already completed, so the production `setTimeout` under test is the only
 * timer these cases control.
 */
describe('the call deadline (HIVE-144)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers an error frame when a call outruns the deadline', async () => {
    // A handler that never settles, which is what agents:run genuinely can do.
    const dispatch: RemoteDispatch = {
      call: vi.fn(() => new Promise<ResultFrame | ErrorFrame>(() => {})),
      notify: vi.fn(),
    };
    const { socket, sent } = await attachedSocket({ dispatch });

    vi.useFakeTimers();
    socket.emit('message', JSON.stringify({ kind: 'call', id: 'c1', channel: CH.agentsRun, payload: {} }));
    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS + 1);

    expect(sent).toContainEqual(
      expect.objectContaining({ kind: 'error', id: 'c1', code: CALL_TIMEOUT_CODE }),
    );
  });

  it('does not answer twice when the call settles after the deadline', async () => {
    let resolveLate: (answer: ResultFrame | ErrorFrame) => void = () => {
      throw new Error('resolveLate called before the promise executor ran');
    };
    const late = new Promise<ResultFrame | ErrorFrame>((resolve) => {
      resolveLate = resolve;
    });
    const dispatch: RemoteDispatch = { call: vi.fn(() => late), notify: vi.fn() };
    const { socket, sent } = await attachedSocket({ dispatch });

    vi.useFakeTimers();
    socket.emit('message', JSON.stringify({ kind: 'call', id: 'c1', channel: CH.agentsRun, payload: {} }));
    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS + 1);

    resolveLate({ kind: 'result', id: 'c1', payload: 'late' });
    await vi.advanceTimersByTimeAsync(0);

    // Two frames for one correlation id is worse than none: the client
    // already resolved off the timeout's error frame.
    expect(sent.filter((frame) => (frame as { id?: string }).id === 'c1')).toHaveLength(1);
  });

  it('clears the deadline when the call settles in time', async () => {
    const dispatch: RemoteDispatch = {
      call: vi.fn(async () => ({ kind: 'result' as const, id: 'c1', payload: 'ok' })),
      notify: vi.fn(),
    };
    const { socket, sent } = await attachedSocket({ dispatch });

    vi.useFakeTimers();
    socket.emit('message', JSON.stringify({ kind: 'call', id: 'c1', channel: CH.configGet, payload: {} }));
    await vi.advanceTimersByTimeAsync(0);
    // Comfortably past the deadline, to prove the timer was actually
    // cancelled rather than merely not yet due.
    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS + 1);

    const framesForId = sent.filter((frame) => (frame as { id?: string }).id === 'c1');
    expect(framesForId).toHaveLength(1);
    expect(framesForId[0]).toMatchObject({ kind: 'result' });
  });

  /**
   * The `.catch()` branch's own pair, mirroring the two `.then()` cases
   * above: `dispatch.call` rejects — the *send* failing, per its own comment
   * — rather than resolving, and the `settled`/`clearTimeout` guard has to
   * hold on this path too, not only the success one.
   */
  it('sends a send-failed error and clears the deadline when dispatch.call rejects before it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dispatch: RemoteDispatch = {
      call: vi.fn(async () => {
        throw new Error('boom');
      }),
      notify: vi.fn(),
    };
    const { socket, sent } = await attachedSocket({ dispatch });

    vi.useFakeTimers();
    socket.emit('message', JSON.stringify({ kind: 'call', id: 'c1', channel: CH.configGet, payload: {} }));
    await vi.advanceTimersByTimeAsync(0);
    // Comfortably past the deadline, to prove clearTimeout on the catch path
    // actually cancelled the timer rather than merely not yet being due.
    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS + 1);

    const framesForId = sent.filter((frame) => (frame as { id?: string }).id === 'c1');
    expect(framesForId).toHaveLength(1);
    expect(framesForId[0]).toMatchObject({ kind: 'error', code: 'send-failed' });
    logged.mockRestore();
  });

  it('sends no second frame when dispatch.call rejects after the deadline', async () => {
    let rejectLate: (cause: unknown) => void = () => {
      throw new Error('rejectLate called before the promise executor ran');
    };
    const late = new Promise<ResultFrame | ErrorFrame>((_resolve, reject) => {
      rejectLate = reject;
    });
    const dispatch: RemoteDispatch = { call: vi.fn(() => late), notify: vi.fn() };
    const { socket, sent } = await attachedSocket({ dispatch });

    vi.useFakeTimers();
    socket.emit('message', JSON.stringify({ kind: 'call', id: 'c1', channel: CH.agentsRun, payload: {} }));
    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS + 1);

    rejectLate(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(0);

    // The timeout's own error frame, and nothing the late rejection adds —
    // the same "two answers is worse than one" property as the `.then()`
    // side, proven on the branch that answers a rejection instead of a
    // result.
    const framesForId = sent.filter((frame) => (frame as { id?: string }).id === 'c1');
    expect(framesForId).toHaveLength(1);
    expect(framesForId[0]).toMatchObject({ kind: 'error', code: CALL_TIMEOUT_CODE });
  });
});

/**
 * A real client on a real socket, kept open — the only way to test a *size*
 * bound.
 *
 * {@link attachedSocket} above drives the server's `'message'` handler by
 * emitting on the captured connection object, which is exactly right for the
 * routing cases and useless here: `maxPayload` is enforced by `ws`'s
 * `Receiver`, on the way in from the wire, so a frame that never crossed a
 * wire is never measured. Everything below therefore pays for genuine loopback
 * I/O and waits on real frames.
 */
const realClient = async (
  dispatch: RemoteDispatch,
): Promise<{
  url: string;
  device: { id: string; token: string };
  socket: WebSocket;
  frames: Record<string, unknown>[];
  closeCode: Promise<number>;
}> => {
  const { device, token } = mintDevice('MacBook');
  listener = createRemoteListener({
    bind: { host: '127.0.0.1', port: 0, allowedOrigins: [] },
    devices: () => [device],
    serverName: 'test-mini',
    dispatch,
    buildSnapshot: noopBuildSnapshot,
    onAttach: vi.fn(),
    onDetach: vi.fn(),
  });
  const url = await listener.start();
  expect(url).not.toBeNull();

  const socket = new WebSocket(url as string);
  const frames: Record<string, unknown>[] = [];
  let announceClose: (code: number) => void = () => {};
  const closeCode = new Promise<number>((resolve) => {
    announceClose = resolve;
  });
  socket.on('close', (code) => announceClose(code));

  const accepted = new Promise<void>((resolve, reject) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      frames.push(frame);
      if (frame.kind === 'attach-accepted') resolve();
      if (frame.kind === 'attach-refused') reject(new Error(`attach was refused: ${String(data)}`));
    });
    socket.on('error', reject);
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  socket.send(
    JSON.stringify({ kind: 'attach', protocol: REMOTE_PROTOCOL_VERSION, deviceId: device.id, token }),
  );
  await accepted;

  return { url: url as string, device: { id: device.id, token }, socket, frames, closeCode };
};

/** Resolves once `predicate` holds, polling — real I/O, so no tick count is safe. */
const until = async (predicate: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
};

/**
 * The two frame-size bounds, which are two different numbers for two different
 * reasons (HIVE-143 review).
 *
 * The bug these cover: 8 KiB was handed to `WebSocketServer` as its
 * `maxPayload`, documented as what a *first* frame may weigh — but `ws` builds
 * a connection's `Receiver` once and enforces that for the socket's whole life.
 * Every post-attach frame was silently bounded by a handshake-shaped limit, so
 * a `fs:write-file` or a pasted `pty:write` over 8 KiB never reached
 * `dispatch.call`, answered nothing at all, and closed the connection.
 */
describe('frame size bounds', () => {
  it('answers a call frame far larger than the handshake bound', async () => {
    const dispatch: RemoteDispatch = {
      call: vi.fn(async (frame: CallFrame) => ({
        kind: 'result' as const,
        id: frame.id,
        payload: { ok: true },
      })),
      notify: vi.fn(),
    };
    const { socket, frames } = await realClient(dispatch);

    // 64 KiB of payload — eight times the handshake bound, and the ordinary
    // weight of a file the editor saves over this socket.
    socket.send(
      JSON.stringify({
        kind: 'call',
        id: 'big',
        channel: CH.fsWriteFile,
        payload: { path: '/tmp/x.ts', text: 'x'.repeat(64 * 1024) },
      }),
    );

    await until(() => frames.some((frame) => frame.id === 'big'), 'the result frame');
    expect(dispatch.call).toHaveBeenCalledWith(expect.objectContaining({ id: 'big' }));
    expect(frames).toContainEqual({ kind: 'result', id: 'big', payload: { ok: true } });
    socket.close();
  }, 20_000);

  /**
   * The ceiling is derived from the worst-case *encoded* payload, not from the
   * file size (HIVE-143 review).
   *
   * `MAX_FILE_BYTES` caps a file body at 1,000,000 bytes, but what crosses this
   * socket is that body inside a JSON string, and JSON spends six characters on
   * a single unprintable byte. The old 4 MiB ceiling cited that six and then
   * multiplied by four, so a file the editor is willing to open encoded to ~6 MB
   * and was refused by `ws` at 1009 — which does not refuse the frame, it drops
   * the socket and every in-flight correlation id on it.
   */
  it('answers an fs:write-file whose escaped encoding is six times MAX_FILE_BYTES', async () => {
    const dispatch: RemoteDispatch = {
      call: vi.fn(async (frame: CallFrame) => ({
        kind: 'result' as const,
        id: frame.id,
        payload: { ok: true },
      })),
      notify: vi.fn(),
    };
    const { socket, frames } = await realClient(dispatch);

    // A legal file, entirely of a byte JSON has to escape — the worst case the
    // ceiling is derived from, asserted here so the derivation is checked
    // rather than asserted.
    const body = String.fromCharCode(1).repeat(MAX_FILE_BYTES);
    const encoded = JSON.stringify({
      kind: 'call',
      id: 'escaped',
      channel: CH.fsWriteFile,
      payload: { path: '/tmp/x.ts', text: body },
    });
    expect(Buffer.byteLength(encoded)).toBeGreaterThan(6 * MAX_FILE_BYTES);
    socket.send(encoded);

    await until(() => frames.some((frame) => frame.id === 'escaped'), 'the result frame');
    expect(dispatch.call).toHaveBeenCalledWith(expect.objectContaining({ id: 'escaped' }));
    expect(frames).toContainEqual({ kind: 'result', id: 'escaped', payload: { ok: true } });
    socket.close();
  }, 30_000);

  it('refuses a frame past the post-attach ceiling and keeps serving', async () => {
    const dispatch: RemoteDispatch = { call: vi.fn(), notify: vi.fn() };
    const { url, device, socket, closeCode } = await realClient(dispatch);

    // Past `POST_ATTACH_FRAME_MAX_BYTES` (8 MiB). `ws` refuses it at the
    // receiver, so it never reaches `dispatch` — the bound is still a bound.
    socket.send(
      JSON.stringify({
        kind: 'call',
        id: 'huge',
        channel: CH.fsWriteFile,
        payload: { path: '/tmp/x.ts', text: 'x'.repeat(9 * 1024 * 1024) },
      }),
    );

    // 1009 ("Message Too Big") or 1006 (the server dropped the connection
    // while this client was still writing) — see the handshake-side case above
    // for why the exact code is loopback timing rather than behaviour. What is
    // not timing: the frame never reached `dispatch`.
    expect([1006, 1009]).toContain(await closeCode);
    expect(dispatch.call).not.toHaveBeenCalled();

    /*
      And the listener is still alive: an oversized frame costs the socket that
      sent it and nothing else. A `maxPayload` violation surfaces as an `Error`
      on the socket, and `EventEmitter` throws synchronously for an `'error'`
      with no listener — which on the main process is an uncaught exception
      (C1, HIVE-142 review), not a closed connection.
    */
    const second = new WebSocket(url);
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      second.on('open', () => {
        second.send(
          JSON.stringify({
            kind: 'attach',
            protocol: REMOTE_PROTOCOL_VERSION,
            deviceId: device.id,
            token: device.token,
          }),
        );
      });
      second.on('message', (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
      second.on('error', reject);
    });
    expect(reply.kind).toBe('attach-accepted');
    second.close();
  }, 30_000);
});

describe('the attach snapshot (HIVE-144)', () => {
  /**
   * Attaches a real socket with a given `buildSnapshot`, and resolves with
   * `sent()` — every frame the server sent this socket, so a test can find
   * `attach-accepted` and read its `snapshot`.
   */
  const attaching = async (
    buildSnapshot: () => Promise<Partial<Record<Channel, unknown>>>,
  ): Promise<{ sent: () => Record<string, unknown>[] }> => {
    const { device, token } = mintDevice('MacBook');
    listener = createRemoteListener({
      bind: { host: '127.0.0.1', port: 0, allowedOrigins: [] },
      devices: () => [device],
      serverName: 'test-mini',
      dispatch: noopDispatch,
      buildSnapshot,
      onAttach: noopOnAttach,
      onDetach: noopOnDetach,
    });
    const url = (await listener.start()) as string;

    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    const sent: Record<string, unknown>[] = [];
    const firstFrame = new Promise<void>((resolve) => {
      socket.once('message', (data) => {
        sent.push(JSON.parse(String(data)) as Record<string, unknown>);
        resolve();
      });
    });
    socket.send(JSON.stringify({ kind: 'attach', protocol: REMOTE_PROTOCOL_VERSION, deviceId: device.id, token }));
    await firstFrame;
    socket.close();

    return { sent: () => sent };
  };

  /** A snapshot with a small, distinct value for every {@link SNAPSHOT_CHANNELS} entry. */
  const smallSnapshot = async (): Promise<Partial<Record<Channel, unknown>>> => {
    const snapshot: Partial<Record<Channel, unknown>> = {};
    for (const channel of SNAPSHOT_CHANNELS) snapshot[channel] = { from: channel };
    return snapshot;
  };

  it('accepts with a snapshot carrying every snapshot channel (HIVE-144)', async () => {
    const { sent } = await attaching(smallSnapshot);
    const accepted = sent().find((f) => f.kind === 'attach-accepted');
    const carried = accepted?.snapshot as Record<string, unknown>;

    for (const channel of SNAPSHOT_CHANNELS) {
      expect(carried).toHaveProperty(channel);
    }
  });

  it('sends the accept whole even when the snapshot is large', async () => {
    /*
      ATTACH_FRAME_MAX_BYTES (8 KiB) bounds the CLIENT's first frame, not this
      one. Asserted so nobody later "optimises" the snapshot under the wrong
      cap: 100 KiB is more than twelve times over that ceiling and still two
      orders of magnitude under POST_ATTACH_FRAME_MAX_BYTES (8 MiB) — the one
      that actually governs what a client's own socket will accept, because
      `electron/remote-client/socket.ts` sets its receive-side `maxPayload` to
      that same constant for the whole connection, this frame included.

      A mutation swapping `fitSnapshot`'s ceiling for `ATTACH_FRAME_MAX_BYTES`
      fails exactly this test: every key below would be dropped instead of
      none of them.
    */
    const oneHundredKiB = 'x'.repeat(100 * 1024);
    // The payload this test actually depends on: past the wrong ceiling,
    // nowhere near the right one.
    expect(Buffer.byteLength(oneHundredKiB, 'utf8')).toBeGreaterThan(ATTACH_FRAME_MAX_BYTES * 10);
    expect(Buffer.byteLength(oneHundredKiB, 'utf8')).toBeLessThan(POST_ATTACH_FRAME_MAX_BYTES / 10);

    const { sent } = await attaching(async () => ({ [CH.configGet]: oneHundredKiB }));

    const accepted = sent().find((f) => f.kind === 'attach-accepted');
    expect(accepted?.snapshot).toEqual({ [CH.configGet]: oneHundredKiB });
  });

  it('drops the heaviest keys first when the snapshot genuinely exceeds POST_ATTACH_FRAME_MAX_BYTES', async () => {
    // Genuinely too big — 9 MiB of one channel's own value, past the 8 MiB
    // ceiling on its own, before the envelope around it is even counted.
    const huge = 'x'.repeat(9 * 1024 * 1024);
    /*
      Sized between the two ceilings on purpose (100 KiB: over
      ATTACH_FRAME_MAX_BYTES's 8 KiB, comfortably under
      POST_ATTACH_FRAME_MAX_BYTES's 8 MiB once `huge` above is dropped) —
      not a `{ small: true }` a handful of bytes, which would survive under
      *either* constant and prove nothing about which one `fitSnapshot`'s
      loop actually compares against. A mutation swapping that comparison for
      `ATTACH_FRAME_MAX_BYTES` fails exactly here: it would keep dropping
      past `huge` and take this key too, because 100 KiB does not fit under
      8 KiB either.
    */
    const survivor = 'y'.repeat(100 * 1024);
    const { sent } = await attaching(async () => ({
      [CH.configGet]: huge,
      [CH.sessionHistory]: survivor,
    }));

    const accepted = sent().find((f) => f.kind === 'attach-accepted');
    expect(accepted).toBeDefined();
    const carried = accepted?.snapshot as Record<string, unknown>;

    // The huge key is gone; the 100 KiB one survives it.
    expect(carried).not.toHaveProperty(CH.configGet);
    expect(carried).toHaveProperty(CH.sessionHistory);
    expect(carried[CH.sessionHistory]).toBe(survivor);

    // And the frame that actually crossed the wire really does fit — the
    // property `fitSnapshot` exists to guarantee, not merely "fewer keys".
    expect(Buffer.byteLength(JSON.stringify(accepted), 'utf8')).toBeLessThanOrEqual(
      POST_ATTACH_FRAME_MAX_BYTES,
    );
  });

  it('drops nothing at exactly POST_ATTACH_FRAME_MAX_BYTES, and drops at one byte over it (HIVE-144 review)', async () => {
    /*
      The boundary itself, pinned rather than merely "somewhere near it"
      (HIVE-144 review): `fitSnapshot`'s loop uses `<=`, so a frame at exactly
      the ceiling must survive whole and one byte past it must lose a key. A
      test that only ever tries values far from the edge — as the two tests
      above do — cannot tell `<=` from `<`, and `ws` itself is unforgiving in
      the conservative direction (it refuses only `> maxPayload`), which is
      exactly the direction a boundary bug here would drift without anyone
      noticing on the tests already written.
    */
    const serverName = 'test-mini';
    const envelopeBytes = (snapshot: Partial<Record<Channel, unknown>>): number =>
      Buffer.byteLength(
        JSON.stringify({ kind: 'attach-accepted', protocol: REMOTE_PROTOCOL_VERSION, serverName, snapshot }),
        'utf8',
      );

    // What one key of an empty string costs, so the exact string length that
    // lands the whole frame on the ceiling can be solved for rather than
    // guessed at.
    const withEmptyValue = envelopeBytes({ [CH.configGet]: '' });
    const exactValueLength = POST_ATTACH_FRAME_MAX_BYTES - withEmptyValue;

    const exact = 'z'.repeat(exactValueLength);
    expect(envelopeBytes({ [CH.configGet]: exact })).toBe(POST_ATTACH_FRAME_MAX_BYTES);
    const over = 'z'.repeat(exactValueLength + 1);
    expect(envelopeBytes({ [CH.configGet]: over })).toBe(POST_ATTACH_FRAME_MAX_BYTES + 1);

    const { sent: sentExact } = await attaching(async () => ({ [CH.configGet]: exact }));
    const acceptedExact = sentExact().find((f) => f.kind === 'attach-accepted');
    expect(acceptedExact?.snapshot).toEqual({ [CH.configGet]: exact });

    const { sent: sentOver } = await attaching(async () => ({ [CH.configGet]: over }));
    const acceptedOver = sentOver().find((f) => f.kind === 'attach-accepted');
    expect(acceptedOver?.snapshot).toEqual({});
  });

  it('logs rather than stays silent if the frame is still oversized with an empty snapshot (HIVE-144 review)', async () => {
    /*
      Only reachable through a pathological `serverName` — `fitSnapshot` has
      nothing left to drop once the snapshot itself is empty, so this proves
      the failure is at least loud, not that it is fixed (there is nothing
      left in this function's power to fix it with).
    */
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { device, token } = mintDevice('MacBook');
    listener = createRemoteListener({
      bind: { host: '127.0.0.1', port: 0, allowedOrigins: [] },
      devices: () => [device],
      serverName: 'x'.repeat(9 * 1024 * 1024),
      dispatch: noopDispatch,
      buildSnapshot: async () => ({}),
      onAttach: noopOnAttach,
      onDetach: noopOnDetach,
    });
    const url = (await listener.start()) as string;
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    const firstFrame = new Promise<void>((resolve) => {
      socket.once('message', () => resolve());
    });
    socket.send(JSON.stringify({ kind: 'attach', protocol: REMOTE_PROTOCOL_VERSION, deviceId: device.id, token }));
    await firstFrame;

    expect(logged.mock.calls.some((call) => String(call[0]).includes('still exceeds'))).toBe(true);
    logged.mockRestore();
    socket.close();
  });
});

/**
 * The snapshot window is a window (HIVE-144 review, I4).
 *
 * The close-listener ordering comment justified itself with "the listener
 * cannot fire before this **synchronous** block finishes", and HIVE-144 made
 * that false by inserting an up-to-`SNAPSHOT_READ_BUDGET_MS` await earlier in
 * the same block. A peer that closed inside it fired the connection-level
 * `'close'` with no listener registered; the handler then resumed, sent the
 * accept into a dead socket, registered a `'close'` that could never fire, and
 * `onAttach`ed the dead handle into `attachedSockets` for the life of the
 * process — where `send` has no `readyState` check, so every later broadcast
 * serialised a frame and threw.
 *
 * These drive a real socket against a real listener and hold the snapshot open
 * until the peer is gone, which is the only way to be inside that window on
 * purpose.
 */
describe('a peer that closes during the snapshot window (HIVE-144 review)', () => {
  /**
   * Yield the loop `count` times, letting queued I/O callbacks run.
   *
   * Not a wait on a duration — nothing here is timer-driven — but a socket
   * close is delivered by libuv on a poll turn, and there is no promise on
   * this side of the fixture to await it on.
   */
  const turns = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };

  /**
   * Attaches, waits until `buildSnapshot` has actually been entered, kills the
   * client socket, and only then lets the snapshot resolve.
   *
   * `terminate()` rather than `close()`: a graceful close is a frame the
   * server answers on its own schedule, and this needs the connection gone
   * before the handler resumes, not politely closing.
   */
  const closeDuringSnapshot = async () => {
    const { device, token } = mintDevice('MacBook');
    const onAttach = vi.fn();
    const onDetach = vi.fn();

    let entered!: () => void;
    const inSnapshot = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    listener = createRemoteListener({
      bind: { host: '127.0.0.1', port: 0, allowedOrigins: [] },
      devices: () => [device],
      serverName: 'test-mini',
      dispatch: noopDispatch,
      buildSnapshot: async () => {
        entered();
        await held;
        return {};
      },
      onAttach,
      onDetach,
    });
    const url = (await listener.start()) as string;

    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));

    socket.send(
      JSON.stringify({
        kind: 'attach',
        protocol: REMOTE_PROTOCOL_VERSION,
        deviceId: device.id,
        token,
      }),
    );
    await inSnapshot;
    socket.terminate();
    await closed;
    /*
      The client's own `'close'` is not the server's. The RST reaches the
      listener's socket on a later poll turn, so the snapshot is released only
      once that has had room to land — otherwise this drives the handler back
      to life *before* the connection is observably gone, which is a different
      race from the one under test and one the fix is not about.
    */
    await turns(5);

    release();
    await turns(3);

    return { onAttach, onDetach };
  };

  it('never puts the dead handle into the fan-out', async () => {
    const { onAttach } = await closeDuringSnapshot();

    // The whole finding. `attachedSockets` is a `Set` nothing can ever remove
    // this handle from — its `'close'` fired before the listener that would
    // have run `onDetach` was ever registered.
    expect(onAttach).not.toHaveBeenCalled();
  });

  /**
   * The close listener is registered before the await now, so it *does* fire
   * — and `onDetach` for a handle `onAttach` never added is a `Set.delete`
   * that removes nothing. That is what makes registering early safe rather
   * than merely earlier.
   */
  it('runs its detach anyway, which is a no-op for a handle never added', async () => {
    const { onDetach } = await closeDuringSnapshot();

    expect(onDetach).toHaveBeenCalledTimes(1);
  });
});

describe('the snapshot read budget (HIVE-144)', () => {
  /**
   * `SNAPSHOT_READ_BUDGET_MS`'s own doc comment (beside
   * `ATTACH_HANDSHAKE_TIMEOUT_MS` in `listener.ts`, HIVE-144 review) claims
   * 3 000 ms of margin — asserted here directly, against both real values,
   * rather than trusted to stay true because the two constants merely sit
   * next to each other in the source. A budget raised to or past the
   * handshake deadline is the same defect the deadline exists to prevent,
   * with a different constant at fault: `buildAttachSnapshot` would still be
   * waiting on a slow read when `ATTACH_HANDSHAKE_TIMEOUT_MS` fires and
   * terminates the socket with no frame sent at all.
   */
  it('leaves comfortable margin inside the handshake deadline', () => {
    expect(SNAPSHOT_READ_BUDGET_MS).toBeLessThan(ATTACH_HANDSHAKE_TIMEOUT_MS);
    expect(ATTACH_HANDSHAKE_TIMEOUT_MS - SNAPSHOT_READ_BUDGET_MS).toBeGreaterThanOrEqual(1_000);
  });
});
