import { describe, expect, it, vi } from 'vitest';

import type { LedgerSnapshot } from '@shared/ledger-contract';

import { ReceiverError, type ReceiverClient } from '../../../electron/mcp-host/client';
import { createToolHandlers } from '../../../electron/mcp-host/tools';

const emptySnapshot: LedgerSnapshot = { entries: [], openAsks: [], claims: {} };

const stub = (overrides: Partial<ReceiverClient> = {}): ReceiverClient => ({
  read: vi.fn(async () => emptySnapshot),
  post: vi.fn(async () => ({ id: 'id-1', ref: 'a1' })),
  ...overrides,
});

const textOf = (result: { content: { text: string }[] }): string =>
  result.content.map((part) => part.text).join('');

describe('createToolHandlers — listing', () => {
  it('lists the eight shared definitions unchanged', () => {
    const handlers = createToolHandlers(stub());
    expect(handlers.listTools().map((tool) => tool.name)).toEqual([
      'ledger_read',
      'ledger_post',
      'ledger_ask',
      'ledger_answer',
      'ledger_claim',
      'ledger_release',
      'ledger_done',
      'ledger_failed',
    ]);
  });

  it('reports an unknown tool as an error result, not a throw', async () => {
    const handlers = createToolHandlers(stub());
    const result = await handlers.callTool('ledger_nope', {});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/ledger_nope/);
  });
});

describe('ledger_read', () => {
  it('bounds a first read and returns compact JSON', async () => {
    const client = stub();
    const handlers = createToolHandlers(client);

    const result = await handlers.callTool('ledger_read', {});

    expect(client.read).toHaveBeenCalledWith({ limit: 50 });
    expect(result.isError).toBe(false);
    // Compact: no indentation, so no newline between keys.
    expect(textOf(result)).toBe(JSON.stringify(emptySnapshot));
  });

  it('advances a cursor so the next read returns only what is new', async () => {
    const snapshot: LedgerSnapshot = {
      entries: [
        { id: 'e1', ts: 1, from: 'overmind', kind: 'post', body: 'one' },
        { id: 'e2', ts: 2, from: 'overmind', kind: 'post', body: 'two' },
      ],
      openAsks: [],
      claims: {},
    };
    const client = stub({ read: vi.fn(async () => snapshot) });
    const handlers = createToolHandlers(client);

    await handlers.callTool('ledger_read', {});
    await handlers.callTool('ledger_read', {});

    // Entries are newest-last, so the cursor is the last one returned.
    expect(client.read).toHaveBeenLastCalledWith({ since: 'e2' });
  });

  it('leaves the cursor alone when a read returned nothing', async () => {
    const client = stub();
    const handlers = createToolHandlers(client);

    await handlers.callTool('ledger_read', {});
    await handlers.callTool('ledger_read', {});

    expect(client.read).toHaveBeenLastCalledWith({ limit: 50 });
  });

  it('lets an explicit since override the cursor', async () => {
    const client = stub();
    const handlers = createToolHandlers(client);

    await handlers.callTool('ledger_read', { since: 'e9', limit: 3 });

    expect(client.read).toHaveBeenCalledWith({ since: 'e9', limit: 3 });
  });

  it('passes the filters through', async () => {
    const client = stub();
    const handlers = createToolHandlers(client);

    await handlers.callTool('ledger_read', { to: 'me', from: 'you', kind: 'ask', thread: 'a1' });

    expect(client.read).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'me', from: 'you', kind: 'ask', thread: 'a1' }),
    );
  });
});

describe('the writing tools', () => {
  it('ledger_post broadcasts when no "to" is given', async () => {
    const client = stub();
    await createToolHandlers(client).callTool('ledger_post', { body: 'hello' });

    expect(client.post).toHaveBeenCalledWith({ kind: 'post', body: 'hello' });
  });

  it('ledger_post carries "to" and meta when given', async () => {
    const client = stub();
    await createToolHandlers(client).callTool('ledger_post', {
      to: 'overmind',
      body: 'hello',
      meta: { ticket: 'HIVE-112' },
    });

    expect(client.post).toHaveBeenCalledWith({
      kind: 'post',
      to: 'overmind',
      body: 'hello',
      meta: { ticket: 'HIVE-112' },
    });
  });

  it('ledger_ask folds options into meta and reports the ref', async () => {
    const client = stub();
    const result = await createToolHandlers(client).callTool('ledger_ask', {
      to: 'overmind',
      body: 'ship it?',
      options: ['ship', 'wait'],
    });

    expect(client.post).toHaveBeenCalledWith({
      kind: 'ask',
      to: 'overmind',
      body: 'ship it?',
      meta: { options: ['ship', 'wait'] },
    });
    expect(textOf(result)).toMatch(/a1/);
    // The model must stop after asking; the result says so.
    expect(textOf(result)).toMatch(/end your turn/i);
  });

  it('ledger_answer sends the thread through untouched, ref or id', async () => {
    const client = stub();
    await createToolHandlers(client).callTool('ledger_answer', { thread: 'a12', body: 'yes' });

    expect(client.post).toHaveBeenCalledWith({ kind: 'answer', thread: 'a12', body: 'yes' });
  });

  it('ledger_done and ledger_failed carry an optional thread', async () => {
    const client = stub();
    const handlers = createToolHandlers(client);

    await handlers.callTool('ledger_done', { body: 'merged', thread: 'a2' });
    expect(client.post).toHaveBeenCalledWith({ kind: 'done', body: 'merged', thread: 'a2' });

    await handlers.callTool('ledger_failed', { body: 'blocked' });
    expect(client.post).toHaveBeenCalledWith({ kind: 'failed', body: 'blocked' });
  });

  it('refuses a write with no body before troubling the receiver', async () => {
    const client = stub();
    const result = await createToolHandlers(client).callTool('ledger_post', {});

    expect(result.isError).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('surfaces a receiver refusal as the reason it gave', async () => {
    const client = stub({
      post: vi.fn(async () => {
        throw new ReceiverError(400, 'thread is not open: a12');
      }),
    });

    const result = await createToolHandlers(client).callTool('ledger_answer', {
      thread: 'a12',
      body: 'yes',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('thread is not open: a12');
  });
});

describe('ledger_claim and ledger_release', () => {
  it('claims a free task and says so', async () => {
    const client = stub();
    const result = await createToolHandlers(client).callTool('ledger_claim', { task: 'HIVE-112' });

    // `limit: 0` still gets the full claims map back — `claims` is derived
    // from the whole log regardless of the query's limit — without shipping
    // every entry back just to read one key.
    expect(client.read).toHaveBeenCalledWith({ limit: 0 });
    expect(client.post).toHaveBeenCalledWith({
      kind: 'claim',
      body: 'claimed HIVE-112',
      meta: { task: 'HIVE-112' },
    });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toMatch(/HIVE-112/);
  });

  it('reports the current holder instead of failing', async () => {
    const client = stub({
      read: vi.fn(async () => ({ ...emptySnapshot, claims: { 'HIVE-112': 'slack-watcher' } })),
    });

    const result = await createToolHandlers(client).callTool('ledger_claim', { task: 'HIVE-112' });

    expect(client.read).toHaveBeenCalledWith({ limit: 0 });
    // Not an error: the store records a second claim deliberately.
    expect(result.isError).toBe(false);
    expect(textOf(result)).toMatch(/slack-watcher/);
    expect(client.post).toHaveBeenCalled();
  });

  it('releases a task', async () => {
    const client = stub();
    await createToolHandlers(client).callTool('ledger_release', { task: 'HIVE-112' });

    expect(client.post).toHaveBeenCalledWith({
      kind: 'release',
      body: 'released HIVE-112',
      meta: { task: 'HIVE-112' },
    });
  });

  it('surfaces the receiver refusal when releasing something you do not hold', async () => {
    const client = stub({
      post: vi.fn(async () => {
        throw new ReceiverError(403, 'HIVE-112 is held by slack-watcher, not by sess-a');
      }),
    });

    const result = await createToolHandlers(client).callTool('ledger_release', { task: 'HIVE-112' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/held by slack-watcher/);
  });

  it('needs a task', async () => {
    const client = stub();
    const result = await createToolHandlers(client).callTool('ledger_claim', {});

    expect(result.isError).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
  });
});
