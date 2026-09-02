import { createInterface } from 'node:readline';

import {
  JSONRPC_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  type CallToolResult,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpToolDefinition,
} from '@shared/mcp-contract';

/**
 * The MCP transport, and nothing else (HIVE-112).
 *
 * Newline-delimited JSON-RPC 2.0 on stdin/stdout. This module knows what a
 * request is and what a reply looks like; it has never heard of a ledger. The
 * split is what lets the protocol be tested with no receiver in sight, and what
 * keeps "we framed a message wrong" and "we called the wrong route" from ever
 * being the same commit.
 *
 * ## The three rules that matter
 *
 * 1. **One message per line, no embedded newlines.** The spec frames on `\n`,
 *    so `JSON.stringify` without indentation is not a style choice.
 * 2. **A notification draws no reply.** `notifications/initialized` carries no
 *    `id`; answering it puts a response with `id: undefined` on the wire and
 *    the client is entitled to hang up.
 * 3. **stdout belongs to the protocol.** Diagnostics go to `log`, which the
 *    entry point points at stderr. A stray `console.log` here corrupts the
 *    stream in a way that looks like the server crashing.
 */

export interface RpcHandlers {
  listTools(): readonly McpToolDefinition[];
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

const failure = (
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
      return failure(id, RPC_INVALID_PARAMS, 'tools/call needs a tool name');
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

  return failure(id, RPC_METHOD_NOT_FOUND, `no method ${method}`);
}

export interface ServeOptions {
  input: NodeJS.ReadableStream;
  /** Where a reply goes. The entry point points this at stdout. */
  write: (line: string) => void;
  /** Where diagnostics go. The entry point points this at stderr. */
  log: (message: string) => void;
  handlers: RpcHandlers;
}

/** Read messages off `input` until it ends, replying on `write`. */
export function serve({ input, write, log, handlers }: ServeOptions): void {
  const reader = createInterface({ input });

  reader.on('line', (line) => {
    const text = line.trim();
    if (text === '') return;

    let message: JsonRpcRequest;
    try {
      message = JSON.parse(text) as JsonRpcRequest;
    } catch {
      /*
        Skipped, not fatal. A half-written line is a transport hiccup; killing
        the server would take the session's tools down with it for the rest of
        its life, since `claude` starts the host once.
      */
      log(`unparseable message, skipped: ${text.slice(0, 200)}`);
      return;
    }

    void handleMessage(message, handlers)
      .then((reply) => {
        if (reply !== null) write(`${JSON.stringify(reply)}\n`);
      })
      .catch((cause: unknown) => {
        // A handler that threw is a bug in this app, not a client error. Report
        // it where a developer can see it and leave the stream intact.
        log(`handler threw: ${String(cause)}`);

        /*
          A client that sent an `id` is owed a reply — silence here means it
          waits on an answer that will never come, all the way out to its own
          timeout, instead of failing fast with a message a model could act
          on. A notification (`id` absent or `null`) drew no reply from
          `handleMessage` either, so there is nothing to send back for it.
        */
        const { id } = message;
        if (id !== undefined && id !== null) {
          write(
            `${JSON.stringify(failure(id, RPC_INTERNAL_ERROR, `handler threw: ${String(cause)}`))}\n`,
          );
        }
      });
  });
}
