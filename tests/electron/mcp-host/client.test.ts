import { describe, expect, it, vi } from 'vitest';

import { AGENTS_PATH } from '@shared/agent-contract';
import { HOOK_HEADER_SESSION, HOOK_HEADER_TOKEN } from '@shared/hook-contract';
import {
  LEDGER_POST_PATH,
  LEDGER_READ_PATH,
  type LedgerPostRequest,
} from '@shared/ledger-contract';

import {
  createReceiverClient,
  ReceiverError,
} from '../../../electron/mcp-host/client';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const client = (fetchImpl: typeof globalThis.fetch) =>
  createReceiverClient({
    url: 'http://127.0.0.1:4100',
    session: 'sess-a',
    token: 'tok-1',
    fetch: fetchImpl,
  });

describe('createReceiverClient', () => {
  it('posts a read to /ledger/read with the identity headers', async () => {
    const snapshot = { entries: [], openAsks: [], claims: {} };
    const fetchImpl = vi.fn(async () => jsonResponse(200, snapshot));

    const result = await client(fetchImpl as never).read({ limit: 5 });

    expect(result).toEqual(snapshot);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:4100${LEDGER_READ_PATH}`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)[HOOK_HEADER_SESSION]).toBe('sess-a');
    expect((init.headers as Record<string, string>)[HOOK_HEADER_TOKEN]).toBe('tok-1');
    expect(JSON.parse(init.body as string)).toEqual({ limit: 5 });
  });

  it('posts a write to /ledger and returns the id and ref', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: '20260829-1', ref: 'a3' }));

    const result = await client(fetchImpl as never).post({ kind: 'ask', body: 'ship?' });

    expect(result).toEqual({ id: '20260829-1', ref: 'a3' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:4100${LEDGER_POST_PATH}`);
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'ask', body: 'ship?' });
  });

  it('never sends a "from" — identity is the header, not the body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: 'x' }));

    // A caller that tries to name itself is ignored by the receiver anyway;
    // this asserts we do not even offer it the chance. `Omit<..., 'from'>`
    // rejects `from` at the call site, so a value carrying one anyway is
    // built out-of-band and cast in — proving the client strips it even when
    // the type system is bypassed, not merely that it is well-typed.
    const request = {
      kind: 'post',
      body: 'hi',
      from: 'overmind',
    } as unknown as Omit<LedgerPostRequest, 'from'>;

    await client(fetchImpl as never).post(request);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).from).toBeUndefined();
  });

  it('stamps every write with the run it came from, over anything the model said (HIVE-128)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: 'x' }));
    const stamped = createReceiverClient({
      url: 'http://127.0.0.1:4100',
      session: 'pr-reviewer',
      token: 'tok-1',
      run: 'run-9',
      fetch: fetchImpl as never,
    });

    await stamped.post({ kind: 'done', body: 'reviewed', meta: { pr: 166, run: 'a lie' } });
    await stamped.post({ kind: 'post', body: 'note' });

    const bodies = fetchImpl.mock.calls.map(
      (call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string) as unknown,
    );
    expect(bodies[0]).toEqual({ kind: 'done', body: 'reviewed', meta: { pr: 166, run: 'run-9' } });
    expect(bodies[1]).toEqual({ kind: 'post', body: 'note', meta: { run: 'run-9' } });
  });

  it('leaves meta alone when the process has no run', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: 'x' }));

    await client(fetchImpl as never).post({ kind: 'post', body: 'note' });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'post', body: 'note' });
  });

  it('raises the receiver reason on a refusal', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { reason: 'thread is not open: a12' }));

    await expect(client(fetchImpl as never).post({ kind: 'answer', thread: 'a12', body: 'yes' }))
      .rejects.toThrow('thread is not open: a12');
  });

  it('carries the status on the error so callers can tell a 403 from a 500', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { reason: 'held by someone else' }));

    await expect(client(fetchImpl as never).post({ kind: 'release', body: 'x' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(client(fetchImpl as never).post({ kind: 'release', body: 'x' })).rejects.toBeInstanceOf(
      ReceiverError,
    );
  });

  it('falls back to the status when the body carries no reason', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));

    await expect(client(fetchImpl as never).read({})).rejects.toThrow(/404/);
  });

  it('reports a transport failure in words a model can act on', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(client(fetchImpl as never).read({})).rejects.toThrow(/could not reach the Hive/i);
  });

  it('gives up after the timeout', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      // Prove a signal was supplied and that it is what aborts the call.
      expect(init.signal).toBeDefined();
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    });

    await expect(client(fetchImpl as never).read({})).rejects.toThrow(/could not reach the Hive/i);
  });
});

/**
 * The peer directory (HIVE-127).
 *
 * A third route on the same client, sharing its timeout, its identity headers
 * and its refusal handling — which is most of the argument for adding a method
 * here rather than a second client.
 */
describe('agents()', () => {
  const directory = {
    agents: [
      {
        name: 'pr-reviewer',
        description: 'Reviews open PRs.',
        status: 'working',
        accepts: ['ledger'],
        tools: ['Read'],
      },
    ],
  };

  it('posts to the agents route with the identity headers and no arguments', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, directory));

    await client(fetchImpl as never).agents();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:4100${AGENTS_PATH}`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      [HOOK_HEADER_SESSION]: 'sess-a',
      [HOOK_HEADER_TOKEN]: 'tok-1',
    });
    /*
      An empty body, not an absent one: `call` always sends JSON. There is
      nothing to put in it — the caller is the header, which is the whole
      reason the tool publishes no arguments.
    */
    expect(init.body).toBe('{}');
  });

  it('parses the directory the receiver returns', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, directory));

    expect(await client(fetchImpl as never).agents()).toEqual(directory);
  });

  it("raises the receiver's own reason on a refusal", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { reason: 'EACCES: permission denied' }));

    await expect(client(fetchImpl as never).agents()).rejects.toThrow('EACCES: permission denied');
  });
});
