import {
  JSONRPC_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  type CallToolResult,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpToolDefinition,
} from './mcp-contract';

/**
 * The MCP data layer: one message in, one reply out (HIVE-112, moved HIVE-130).
 *
 * This module knows what a request is and what a reply looks like; it has never
 * heard of a ledger, and it has never heard of a *transport* either. That
 * second property is why it lives here rather than beside the stdio host it was
 * written for: `electron/mcp-host/rpc.ts` frames these messages on newlines over
 * stdin, and `electron/main/hooks/receiver.ts` frames the same messages as JSON
 * bodies on `POST /mcp`. Both call {@link handleMessage}, so a session in a
 * container and a session on this machine are answered by the same code rather
 * than by two implementations that agree until they don't.
 *
 * It is pure — JSON in, JSON out, no Node APIs and no I/O — which is what makes
 * it admissible in `electron/shared/`. The stdio framing, and its
 * `node:readline` import, stayed behind in `mcp-host/rpc.ts`.
 */

export interface RpcHandlers {
  listTools(): readonly McpToolDefinition[];
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

/**
 * A JSON-RPC error reply.
 *
 * Exported because the stdio transport needs it too: `serve()` answers a
 * handler that threw with an `RPC_INTERNAL_ERROR`, and a second copy of this
 * three-line builder is how the two transports start returning subtly
 * different error envelopes.
 */
export const rpcFailure = (
  id: string | number,
  code: number,
  message: string,
): JsonRpcResponse => ({ jsonrpc: JSONRPC_VERSION, id, error: { code, message } });

const success = (id: string | number, result: unknown): JsonRpcResponse => ({
  jsonrpc: JSONRPC_VERSION,
  id,
  result,
});

/**
 * Turn one client message into one reply, or `null` for a notification.
 *
 * Exported for the tests: driving this directly is how the protocol is
 * asserted without a stream in the way.
 */
export async function handleMessage(
  message: JsonRpcRequest,
  handlers: RpcHandlers,
): Promise<JsonRpcResponse | null> {
  const { id, method, params } = message;

  /*
    A notification. Act on nothing, answer nothing.

    `id === null` is included on purpose: the spec permits a client to send
    `"id": null` on what is nominally a request, and answering it would put a
    reply with `id: null` on the wire that nothing asked for. The `ping`
    comment below already argues for tolerating whatever a later CLI sends;
    this is the same stance applied to `id` itself.

    Over HTTP this `null` is also what the transport keys on: the spec requires
    a POST carrying only a notification to be answered `202 Accepted` with no
    body, and "no reply to send" is exactly that case.
  */
  if (id === undefined || id === null) return null;

  if (method === 'initialize') {
    /*
      We answer with the version we implement rather than echoing the client's.
      Echoing would be a promise we cannot keep: there is no SDK behind this to
      absorb a version whose shapes we have never seen.
    */
    return success(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }

  if (method === 'tools/list') {
    // No pagination: eleven tools fit in one page, so no `nextCursor`.
    return success(id, { tools: handlers.listTools() });
  }

  if (method === 'tools/call') {
    const name = params?.['name'];
    if (typeof name !== 'string' || name === '') {
      return rpcFailure(id, RPC_INVALID_PARAMS, 'tools/call needs a tool name');
    }

    const raw = params?.['arguments'];
    const args =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};

    return success(id, await handlers.callTool(name, args));
  }

  if (method === 'ping') {
    /*
      The spec requires an empty result, not a protocol error. `claude` 2.1.251
      does not currently send this, but a keepalive is exactly the kind of
      thing a later CLI adds without warning, and falling through to
      `RPC_METHOD_NOT_FOUND` for it would make an idle connection look broken.
    */
    return success(id, {});
  }

  return rpcFailure(id, RPC_METHOD_NOT_FOUND, `no method ${method}`);
}
