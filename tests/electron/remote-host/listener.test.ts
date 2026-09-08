import { randomBytes } from 'node:crypto';
import { createServer as createNetServer, connect, type Socket } from 'node:net';

import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRemoteListener } from '@remote-host/listener';
import { REMOTE_PROTOCOL_VERSION } from '@shared/remote-contract';
import type { ServerDevice } from '@shared/config-contract';

import { mintDevice } from '../../../electron/main/server/devices';

let listener: ReturnType<typeof createRemoteListener> | null = null;
afterEach(async () => {
  await listener?.stop();
  listener = null;
});

const start = async (devices: readonly ServerDevice[], allowedOrigins: string[] = []) => {
  listener = createRemoteListener({
    bind: { host: '127.0.0.1', port: 0, allowedOrigins },
    devices: () => devices,
    serverName: 'test-mini',
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
    });
    const result = await listener.start();
    expect(result).toBeNull();
    expect(listener.boundHost).toBeNull();

    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it('resolves stop() before start() was ever called', async () => {
    listener = createRemoteListener({
      bind: { host: '127.0.0.1', port: 0, allowedOrigins: [] },
      devices: () => [],
      serverName: 'test-mini',
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
