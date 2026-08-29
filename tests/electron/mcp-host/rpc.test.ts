import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  type CallToolResult,
} from '@shared/mcp-contract';

import { handleMessage, serve, type RpcHandlers } from '../../../electron/mcp-host/rpc';

const ok = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
  isError: false,
});

const handlers = (): RpcHandlers => ({
  listTools: () => [
    { name: 'ledger_read', description: 'd', inputSchema: { type: 'object', properties: {} } },
  ],
  callTool: vi.fn(async (name: string) => ok(`called ${name}`)),
});

describe('handleMessage', () => {
  it('answers initialize with the pinned protocol version and the server name', async () => {
    const reply = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      handlers(),
    );

    expect(reply).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: expect.any(String) },
      },
    });
  });

  it('draws no reply for a notification', async () => {
    // `notifications/initialized` has no id. Answering it corrupts the stream.
    const reply = await handleMessage(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      handlers(),
    );

    expect(reply).toBeNull();
  });

  /**
   * `id: null` is a notification too (HIVE-112 self-review).
   *
   * The spec permits a client to send `"id": null`; only checking
   * `id === undefined` would answer it with a reply carrying `id: null` that
   * nothing asked for.
   */
  it('draws no reply for a message whose id is null', async () => {
    const reply = await handleMessage(
      { jsonrpc: '2.0', id: null, method: 'notifications/initialized' },
      handlers(),
    );

    expect(reply).toBeNull();
  });

  it('lists the tools the handlers offer', async () => {
    const reply = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, handlers());

    expect(reply).toMatchObject({ id: 2, result: { tools: [{ name: 'ledger_read' }] } });
  });

  it('routes tools/call to the handler with its arguments', async () => {
    const set = handlers();
    const reply = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'ledger_post', arguments: { body: 'hi' } },
      },
      set,
    );

    expect(set.callTool).toHaveBeenCalledWith('ledger_post', { body: 'hi' });
    expect(reply).toMatchObject({ id: 3, result: { isError: false } });
  });

  it('defaults missing arguments to an empty object', async () => {
    const set = handlers();
    await handleMessage(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ledger_read' } },
      set,
    );

    expect(set.callTool).toHaveBeenCalledWith('ledger_read', {});
  });

  it('answers ping with an empty result, not a protocol error', async () => {
    // The spec requires an empty result. `claude` does not currently send
    // this, but a keepalive that did must not see an error back.
    const reply = await handleMessage({ jsonrpc: '2.0', id: 7, method: 'ping' }, handlers());

    expect(reply).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });

  it('returns a JSON-RPC error for an unknown method', async () => {
    const reply = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, handlers());

    expect(reply).toMatchObject({ id: 5, error: { code: RPC_METHOD_NOT_FOUND } });
  });

  it('returns a JSON-RPC error when tools/call names nothing', async () => {
    const reply = await handleMessage(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} },
      handlers(),
    );

    expect(reply).toMatchObject({ id: 6, error: { code: RPC_INVALID_PARAMS } });
  });
});

describe('serve', () => {
  const drive = async (lines: string[]) => {
    const input = new PassThrough();
    const written: string[] = [];
    const logged: string[] = [];

    serve({
      input,
      write: (line) => written.push(line),
      log: (message) => logged.push(message),
      handlers: handlers(),
    });

    for (const line of lines) input.write(`${line}\n`);
    input.end();
    // Let the readline listener and its promises settle.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    return { written, logged };
  };

  it('writes one newline-terminated JSON message per reply', async () => {
    const { written } = await drive([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })]);

    expect(written).toHaveLength(1);
    expect(written[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(written[0] as string)).toMatchObject({ id: 1 });
    // A message must not contain an embedded newline: the spec frames on them.
    expect((written[0] as string).trimEnd()).not.toContain('\n');
  });

  it('skips an unparseable line without dying', async () => {
    const { written, logged } = await drive([
      'not json at all',
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    ]);

    expect(logged.join(' ')).toMatch(/unparseable/i);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] as string)).toMatchObject({ id: 2 });
  });

  it('ignores a blank line', async () => {
    const { written } = await drive(['', '   ']);

    expect(written).toHaveLength(0);
  });

  /**
   * A rejected handler used to leave the request unanswered — logged to
   * stderr and nothing written, so a client waiting on that `id` hung all the
   * way to its own timeout (HIVE-112 self-review). It must instead draw a
   * JSON-RPC error carrying the request's `id`, and the reader must survive
   * to answer whatever comes next.
   */
  it('replies with a JSON-RPC error when a handler rejects, and keeps serving', async () => {
    const input = new PassThrough();
    const written: string[] = [];
    const logged: string[] = [];
    const set: RpcHandlers = {
      listTools: () => [],
      callTool: vi.fn(async (name: string) => {
        if (name === 'ledger_post') throw new Error('boom');
        return ok(`called ${name}`);
      }),
    };

    serve({
      input,
      write: (line) => written.push(line),
      log: (message) => logged.push(message),
      handlers: set,
    });

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'ledger_post', arguments: {} },
      })}\n`,
    );
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    input.end();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(written).toHaveLength(2);
    // Both replies land, but the two handler chains take a different number
    // of microtask turns to settle, so order between them is not guaranteed.
    const replies = written.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(replies).toContainEqual(
      expect.objectContaining({ id: 1, error: { code: RPC_INTERNAL_ERROR, message: expect.any(String) } }),
    );
    expect(logged.join(' ')).toMatch(/handler threw/i);

    // The reader is still alive: the second message got its own reply.
    expect(replies).toContainEqual(expect.objectContaining({ id: 2, result: { tools: [] } }));
  });
});
