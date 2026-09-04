import { describe, expect, it, vi } from 'vitest';

import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  type CallToolResult,
} from '@shared/mcp-contract';
import { handleMessage, type RpcHandlers } from '@shared/mcp-protocol';

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
