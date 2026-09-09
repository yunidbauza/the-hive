import { EventEmitter } from 'node:events';
import type { LookupFunction } from 'node:net';

import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CH, type Channel } from '@shared/ipc-contract';
import {
  CALL_DEADLINE_MS,
  CALL_GIVE_UP_MS,
  CALL_TIMEOUT_CODE,
  POST_ATTACH_FRAME_MAX_BYTES,
  REMOTE_PROTOCOL_VERSION,
  type AttachAccepted,
  type AttachRefused,
  type AttachRequest,
  type CallFrame,
  type ErrorFrame,
  type EventFrame,
  type NotifyFrame,
  type ResultFrame,
} from '@shared/remote-contract';

import {
  AttachRefusedError,
  PlaintextRefusedError,
  RemoteCallError,
  connectRemote,
  type RemoteClient,
} from '../../../electron/remote-client/socket';

/**
 * The client socket (HIVE-144).
 *
 * Two kinds of test live here on purpose.
 *
 * Everything about frames — the handshake, correlation, the give-up deadline,
 * the size ceiling — runs against an injected fake, because none of it needs a
 * socket and a real one would only add flake.
 *
 * The **resolved-address fence** does not, and cannot. Its whole subject is
 * what a real `ws` client does with a `lookup` it was handed, and `@types/ws`
 * does not even model that option — a fake ctor asserting "we passed a
 * `lookup`" would be a test of this file's own belief about `ws`. So the two
 * arms of that fence drive the real `ws` client against a real
 * `WebSocketServer` on loopback, with only the resolver's answer varying
 * between them: `127.0.0.1` connects, `203.0.113.7` is refused before a TCP
 * connection exists. Same host string, same server, same code path; one number
 * different.
 */

const CREDENTIAL = { deviceId: 'd_9f2c', token: 's3cret' };

/** An `attach-accepted` with a snapshot a test can tell apart from an empty one. */
function accepted(overrides: Partial<AttachAccepted> = {}): AttachAccepted {
  return {
    kind: 'attach-accepted',
    protocol: REMOTE_PROTOCOL_VERSION,
    serverName: 'mini',
    snapshot: { [CH.appInfo]: { version: '0.10.1' } },
    ...overrides,
  };
}

/**
 * The `ws` surface `connectRemote` actually uses, with the frames a test feeds
 * it delivered through the same `'message'` event a socket would.
 */
class FakeSocket extends EventEmitter {
  readonly sent: string[] = [];
  closeCalls = 0;
  readonly url: string;
  readonly options: { lookup?: LookupFunction; family?: number; maxPayload?: number };

  constructor(
    url: string,
    options: { lookup?: LookupFunction; family?: number; maxPayload?: number },
  ) {
    super();
    this.url = url;
    this.options = options;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.emit('close');
  }

  /** Delivers a server frame as a `Buffer`, which is what `ws` hands a listener. */
  deliver(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)));
  }

  /** The attach frame this client sent, parsed. */
  attachFrame(): AttachRequest {
    return JSON.parse(this.sent[0]) as AttachRequest;
  }

  /** Every frame sent after the attach, parsed. */
  clientFrames(): (CallFrame | NotifyFrame)[] {
    return this.sent.slice(1).map((text) => JSON.parse(text) as CallFrame | NotifyFrame);
  }
}

interface Dial {
  promise: Promise<RemoteClient>;
  ctor: ReturnType<typeof vi.fn>;
  /** `null` only when the string fence refused before construction. */
  socket: FakeSocket | null;
}

/** Starts a connection against a {@link FakeSocket}, capturing the instance. */
function dial(overrides: Partial<Parameters<typeof connectRemote>[0]> = {}): Dial {
  let made: FakeSocket | null = null;
  // A `function`, not an arrow: vitest 4 refuses to let an arrow implementation
  // be called with `new`, and this mock stands in for a constructor.
  const ctor = vi.fn(function fakeCtor(url: string, options: Record<string, unknown>) {
    made = new FakeSocket(url, options);
    return made;
  });

  const promise = connectRemote({
    host: '127.0.0.1',
    port: 7433,
    credential: CREDENTIAL,
    WebSocketCtor: ctor as unknown as typeof WebSocket,
    ...overrides,
  });
  // Swallowed here only so a rejection a test asserts on later is not an
  // unhandled rejection in the meantime; every test still awaits `promise`.
  promise.catch(() => undefined);

  return { promise, ctor, socket: made };
}

/** Dials, completes the handshake, and returns the attached client. */
async function attachedClient(
  overrides: Partial<Parameters<typeof connectRemote>[0]> = {},
  frame: AttachAccepted = accepted(),
): Promise<{ client: RemoteClient; socket: FakeSocket }> {
  const { promise, socket } = dial(overrides);
  if (socket === null) throw new Error('the string fence refused before a socket was built');
  socket.emit('open');
  socket.deliver(frame);
  return { client: await promise, socket };
}

/** What the fenced `lookup` handed back to `net`. */
interface LookupResult {
  error: Error | null;
  resolved: unknown;
}

/** A resolver that always answers `address`, in whichever shape `net` asked for. */
function resolverAnswering(address: string): LookupFunction {
  return ((_hostname, options, callback) => {
    const all = (options as { all?: boolean }).all === true;
    if (all) (callback as unknown as (e: null, a: unknown) => void)(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  }) as LookupFunction;
}

const servers: WebSocketServer[] = [];
const clients: RemoteClient[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

/**
 * A real `ws` server on loopback that accepts every handshake, so the fence
 * tests differ only in what the resolver answers.
 */
async function realServer(): Promise<{ port: number; connections: () => number }> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(server);
  let connections = 0;
  server.on('connection', (socket) => {
    connections += 1;
    socket.on('message', () => socket.send(JSON.stringify(accepted())));
  });
  await new Promise<void>((done) => server.on('listening', () => done()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { port: address.port, connections: () => connections };
}

describe('connectRemote — the string fence', () => {
  it('refuses a plaintext socket to a non-tailnet address before connecting', async () => {
    const { promise, ctor } = dial({ host: '203.0.113.7' });

    // The point is that no socket is opened at all — asserted before the await,
    // so a fence that stopped running fails here rather than as a five-second
    // timeout on a promise nothing will ever settle.
    expect(ctor).not.toHaveBeenCalled();
    await expect(promise).rejects.toBeInstanceOf(PlaintextRefusedError);
  });

  /**
   * The pass arm of the same fence, varying only the host. Without it the test
   * above would still pass against a `connectRemote` that refused everything.
   */
  it('opens a socket to a loopback address', () => {
    const { ctor, socket } = dial({ host: '127.0.0.1' });

    expect(ctor).toHaveBeenCalledTimes(1);
    expect(socket?.url).toBe('ws://127.0.0.1:7433/');
  });

  /**
   * `100.63.255.255` is one address below the CGNAT range and
   * `100.64.0.1` is inside it — the arithmetic `TAILNET_V4` documents, read
   * back through the fence rather than through the predicate directly.
   */
  it('refuses an address one below the tailnet range and accepts the first one inside it', async () => {
    const below = dial({ host: '100.63.255.255' });
    await expect(below.promise).rejects.toBeInstanceOf(PlaintextRefusedError);
    expect(below.ctor).not.toHaveBeenCalled();

    const inside = dial({ host: '100.64.0.1' });
    expect(inside.ctor).toHaveBeenCalledTimes(1);
  });
});

describe('connectRemote — the resolved-address fence', () => {
  it('connects to a tailnet name whose DNS answer is inside the fence', async () => {
    const { port, connections } = await realServer();

    const client = await connectRemote({
      host: 'mini.tail1234.ts.net',
      port,
      credential: CREDENTIAL,
      resolveAddress: resolverAnswering('127.0.0.1'),
    });
    clients.push(client);

    expect(client.serverName()).toBe('mini');
    expect(connections()).toBe(1);
  });

  it('refuses a tailnet name whose DNS answer is a public address', async () => {
    const { port, connections } = await realServer();

    const attempt = connectRemote({
      host: 'mini.tail1234.ts.net',
      port,
      credential: CREDENTIAL,
      // The only difference from the test above. A hostile local resolver
      // answering a `.ts.net` name with its own address is the attack; the
      // host string is identical and no string-level predicate can see it.
      resolveAddress: resolverAnswering('203.0.113.7'),
    });

    await expect(attempt).rejects.toBeInstanceOf(PlaintextRefusedError);
    await expect(attempt).rejects.toThrow('203.0.113.7');
    expect(connections()).toBe(0);
  });

  /**
   * The tailnet half of the same fence, which the two arms above cannot show:
   * a test cannot stand a real server up on a `100.64.0.0/10` address, so the
   * `lookup` the client handed `ws` is invoked directly instead.
   */
  it('passes a CGNAT answer through and refuses a public one, on the lookup itself', () => {
    /** What the fence handed back for a resolver answering `address`. */
    const graded = (address: string, options: object = { family: 4 }): LookupResult => {
      const { socket } = dial({
        host: 'mini.tail1234.ts.net',
        resolveAddress: resolverAnswering(address),
      });
      const lookup = socket?.options.lookup;
      if (lookup === undefined) throw new Error('no lookup was handed to the socket');

      let result: LookupResult | null = null;
      lookup(
        'mini.tail1234.ts.net',
        options as Parameters<LookupFunction>[1],
        ((error: Error | null, resolved: unknown) => {
          result = { error, resolved };
        }) as unknown as Parameters<LookupFunction>[2],
      );
      if (result === null) throw new Error('the lookup never called back');
      return result;
    };

    expect(graded('100.64.0.5')).toEqual({ error: null, resolved: '100.64.0.5' });
    expect(graded('100.127.255.255')).toEqual({ error: null, resolved: '100.127.255.255' });

    const outside = graded('100.128.0.0');
    expect(outside.error).toBeInstanceOf(PlaintextRefusedError);
    expect(outside.error?.message).toContain('100.128.0.0');

    // The `all: true` shape `dns.lookup` uses when no family is pinned reaches
    // the same verdict, and is passed through as the array `net` asked for.
    expect(graded('100.64.0.5', { all: true })).toEqual({
      error: null,
      resolved: [{ address: '100.64.0.5', family: 4 }],
    });
    expect(graded('203.0.113.7', { all: true }).error).toBeInstanceOf(PlaintextRefusedError);
  });

  it('pins the lookup to IPv4 so every answer it grades is a dotted quad', () => {
    const { socket } = dial({ host: 'mini.tail1234.ts.net' });

    expect(socket?.options.family).toBe(4);
  });
});

describe('connectRemote — the handshake', () => {
  it('sends an attach frame carrying the credential and the protocol version', async () => {
    const { socket } = await attachedClient();

    expect(socket.attachFrame()).toEqual({
      kind: 'attach',
      protocol: REMOTE_PROTOCOL_VERSION,
      deviceId: 'd_9f2c',
      token: 's3cret',
    });
  });

  it('carries resumeFrom when it was given one, and omits it otherwise', async () => {
    const withResume = await attachedClient({ resumeFrom: { s1: { gen: 3, seq: 12 } } });
    expect(withResume.socket.attachFrame().resumeFrom).toEqual({ s1: { gen: 3, seq: 12 } });

    const without = await attachedClient();
    expect('resumeFrom' in without.socket.attachFrame()).toBe(false);
  });

  it('resolves with the snapshot the server accepted with', async () => {
    const snapshot: Partial<Record<Channel, unknown>> = {
      [CH.appInfo]: { version: '9.9.9' },
      [CH.configGet]: { projects: ['one', 'two'] },
    };
    const { client } = await attachedClient({}, accepted({ serverName: 'studio', snapshot }));

    expect(client.snapshot()).toEqual(snapshot);
    expect(client.serverName()).toBe('studio');
  });

  it('rejects with the refusal code on protocol-mismatch', async () => {
    const { promise, socket } = dial();
    socket?.emit('open');
    const refusal: AttachRefused = {
      kind: 'attach-refused',
      code: 'protocol-mismatch',
      protocol: 99,
      message: 'This server speaks protocol 99.',
    };
    socket?.deliver(refusal);

    await expect(promise).rejects.toBeInstanceOf(AttachRefusedError);
    await expect(promise).rejects.toMatchObject({ code: 'protocol-mismatch' });
    expect(socket?.closeCalls).toBe(1);
  });

  /**
   * The other three refusal codes reach the caller as themselves too — a
   * mismatch-only branch would pass the test above and lose `revoked`, which
   * is the one a settings pane must act on differently.
   */
  it('rejects with the refusal code on revoked', async () => {
    const { promise, socket } = dial();
    socket?.emit('open');
    socket?.deliver({
      kind: 'attach-refused',
      code: 'revoked',
      protocol: REMOTE_PROTOCOL_VERSION,
      message: 'This device has been revoked.',
    } satisfies AttachRefused);

    await expect(promise).rejects.toMatchObject({ code: 'revoked' });
  });
});

describe('connectRemote — calls', () => {
  it('correlates a result frame back to its call', async () => {
    const { client, socket } = await attachedClient();

    const first = client.call(CH.appInfo, { which: 'first' });
    const second = client.call(CH.configGet, { which: 'second' });
    const [frameOne, frameTwo] = socket.clientFrames() as CallFrame[];

    expect(frameOne.id).not.toBe(frameTwo.id);
    // Answered out of order, with different payloads, so a client that simply
    // resolved the oldest outstanding call would fail this.
    socket.deliver({ kind: 'result', id: frameTwo.id, payload: 'second answer' } satisfies ResultFrame);
    socket.deliver({ kind: 'result', id: frameOne.id, payload: 'first answer' } satisfies ResultFrame);

    await expect(first).resolves.toBe('first answer');
    await expect(second).resolves.toBe('second answer');
  });

  it('rejects a call whose error frame arrives, preserving the code', async () => {
    const { client, socket } = await attachedClient();

    const pending = client.call(CH.fsReadFile, { path: '/etc/passwd' });
    const [frame] = socket.clientFrames() as CallFrame[];
    socket.deliver({
      kind: 'error',
      id: frame.id,
      code: 'EOUTSIDE',
      message: 'That path is outside every project.',
    } satisfies ErrorFrame);

    await expect(pending).rejects.toBeInstanceOf(RemoteCallError);
    await expect(pending).rejects.toMatchObject({ code: 'EOUTSIDE' });
  });

  it('rejects a call that outruns CALL_GIVE_UP_MS', async () => {
    vi.useFakeTimers();
    const { client } = await attachedClient();

    const pending = client.call(CH.agentsRun, { name: 'slow' });
    const settled = vi.fn();
    pending.then(settled, settled);

    // The server answers its own timeout at CALL_DEADLINE_MS. Giving up at or
    // before that instant would abandon a call the server is still going to
    // answer, which is the race the two constants exist as a pair to close.
    await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CALL_GIVE_UP_MS - CALL_DEADLINE_MS);
    await expect(pending).rejects.toMatchObject({ code: CALL_TIMEOUT_CODE });
  });

  /**
   * Counted at the instant the answer lands, **not** after advancing the clock
   * past the deadline (fix round). Advancing fires the timer and then reports
   * zero either way, so the first version of this assertion held whether or not
   * `clearTimeout` was ever called — a test that could not fail. What is
   * actually observable is a timer still armed one tick after the call settled.
   */
  it('clears the give-up timer when a result arrives', async () => {
    vi.useFakeTimers();
    const { client, socket } = await attachedClient();

    const pending = client.call(CH.appInfo, null);
    expect(vi.getTimerCount()).toBe(1);

    const [frame] = socket.clientFrames() as CallFrame[];
    socket.deliver({ kind: 'result', id: frame.id, payload: 'answered' } satisfies ResultFrame);

    expect(vi.getTimerCount()).toBe(0);
    await expect(pending).resolves.toBe('answered');
  });

  /** The sibling of the case above: the error branch settles a call too. */
  it('clears the give-up timer when an error frame arrives', async () => {
    vi.useFakeTimers();
    const { client, socket } = await attachedClient();

    const pending = client.call(CH.fsReadFile, { path: '/nope' });
    expect(vi.getTimerCount()).toBe(1);

    const [frame] = socket.clientFrames() as CallFrame[];
    socket.deliver({
      kind: 'error',
      id: frame.id,
      code: 'ENOENT',
      message: 'No such file.',
    } satisfies ErrorFrame);

    expect(vi.getTimerCount()).toBe(0);
    await expect(pending).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects every in-flight call when the socket closes', async () => {
    // Otherwise a detach leaves callers hanging forever.
    vi.useFakeTimers();
    const { client, socket } = await attachedClient();

    const first = client.call(CH.appInfo, null);
    const second = client.call(CH.configGet, null);
    expect(vi.getTimerCount()).toBe(2);

    socket.emit('close');

    await expect(first).rejects.toThrow(/closed/);
    await expect(second).rejects.toThrow(/closed/);
    // Each give-up timer goes with the call it was holding open. A rejection
    // that left the timers armed would fire two more times into an empty map.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a call made after the socket has closed', async () => {
    const { client, socket } = await attachedClient();
    socket.emit('close');

    await expect(client.call(CH.appInfo, null)).rejects.toThrow(/closed/);
  });
});

describe('connectRemote — the frame ceiling', () => {
  /** Comfortably past 8 MiB once inside a JSON string, and cheap to build. */
  const oversized = 'x'.repeat(POST_ATTACH_FRAME_MAX_BYTES + 1024);

  it('refuses to send a frame larger than POST_ATTACH_FRAME_MAX_BYTES', async () => {
    // 8 MiB, not 4. A larger frame is closed by the server rather than answered,
    // so bounding our own sends turns a dead socket into a rejected call.
    const { client, socket } = await attachedClient();

    const rejected = client.call(CH.fsWriteFile, { text: oversized });
    // Asserted before the await for the reason the string-fence test is: a
    // ceiling that stopped running sends the frame and hangs, and a timeout
    // says less than "it went out anyway" does.
    expect(socket.clientFrames()).toEqual([]);
    await expect(rejected).rejects.toMatchObject({ code: 'frame-too-large' });
  });

  /**
   * The sibling of the case above. A `notify` over the ceiling is refused by
   * the far end's `maxPayload` in exactly the same way — a 1009 close that
   * takes every unrelated in-flight correlation id with it — so bounding only
   * the kind that has a promise to reject would leave the cheaper-looking half
   * able to kill the connection. `pty:write` with a very large paste is how
   * that happens in practice.
   */
  it('refuses to send a notify frame larger than POST_ATTACH_FRAME_MAX_BYTES', async () => {
    const { client, socket } = await attachedClient();

    expect(() => client.notify(CH.ptyWrite, { id: 's1', data: oversized })).toThrow(
      /frame ceiling/,
    );
    expect(socket.clientFrames()).toEqual([]);
  });

  it('sends a frame that fits', async () => {
    const { client, socket } = await attachedClient();

    client.notify(CH.ptyWrite, { id: 's1', data: 'ls\n' });

    expect(socket.clientFrames()).toEqual([
      { kind: 'notify', channel: CH.ptyWrite, payload: { id: 's1', data: 'ls\n' } },
    ]);
  });

  it('asks ws for the same ceiling it enforces on its own sends', () => {
    const { socket } = dial();

    expect(socket?.options.maxPayload).toBe(POST_ATTACH_FRAME_MAX_BYTES);
  });
});

describe('connectRemote — events', () => {
  it('routes an event frame to every onEvent listener', async () => {
    const { client, socket } = await attachedClient();
    const first = vi.fn();
    const second = vi.fn();
    const dropped = vi.fn();

    client.onEvent(first);
    client.onEvent(second);
    const unsubscribe = client.onEvent(dropped);
    unsubscribe();

    socket.deliver({
      kind: 'event',
      channel: CH.ptyData,
      payload: { id: 's1', chunk: 'hello' },
    } satisfies EventFrame);

    expect(first).toHaveBeenCalledWith(CH.ptyData, { id: 's1', chunk: 'hello' });
    expect(second).toHaveBeenCalledWith(CH.ptyData, { id: 's1', chunk: 'hello' });
    expect(dropped).not.toHaveBeenCalled();
  });

  /**
   * The mirror of `isClientFrameAllowed`'s direction half, pointed the other
   * way: a server pushing an `event` that names a `call` channel is sending
   * something no honest server sends, and a subscriber has no way to tell it
   * from a real push. Derived from `FRAME_KIND`, so it cannot drift from the
   * table the server grades against.
   */
  it('drops an event frame naming a channel that is not an event channel', async () => {
    const { client, socket } = await attachedClient();
    const listener = vi.fn();
    client.onEvent(listener);

    socket.deliver({ kind: 'event', channel: CH.configGet, payload: 'no' });
    socket.deliver({ kind: 'event', channel: 'not:a:channel', payload: 'no' });
    expect(listener).not.toHaveBeenCalled();

    socket.deliver({ kind: 'event', channel: CH.ptyData, payload: 'yes' } satisfies EventFrame);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('survives a frame that is not JSON', async () => {
    const { client, socket } = await attachedClient();
    const listener = vi.fn();
    client.onEvent(listener);

    socket.emit('message', Buffer.from('{not json'));

    expect(listener).not.toHaveBeenCalled();
  });
});
