import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

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
});
