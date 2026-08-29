import { describe, expect, it, vi } from 'vitest';

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
