/**
 * The MCP wire protocol, as this app speaks it (HIVE-112).
 *
 * Types and constants only — `electron/shared` is compiled into the renderer,
 * main, and the MCP host alike, so nothing here may have a runtime import.
 *
 * ## Why these values are pinned rather than negotiated
 *
 * Every constant below was **observed**, not read off a doc page: a throwaway
 * stdio server was run against real `claude` 2.1.251 and its `initialize`
 * params recorded. That matters because the whole server is hand-rolled — there
 * is no SDK to absorb a protocol change, so the version we claim to speak has
 * to be the version we were actually handed.
 */

/** The protocol version Claude Code negotiates. Observed, not assumed. */
export const MCP_PROTOCOL_VERSION = '2025-11-25';

/**
 * The server's key in the generated config, and therefore the middle segment of
 * every tool name the model sees: `mcp__hive__ledger_read`.
 *
 * Load-bearing across stories. A server delivered through `--plugin-dir`
 * instead would be `mcp__plugin_hive_hive__ledger_read`, and HIVE-115's
 * preamble and HIVE-119's `--permission-prompt-tool` both name the short form.
 */
export const MCP_SERVER_NAME = 'hive';

/** Reported in `initialize`. Not the app's version: the protocol surface's. */
export const MCP_SERVER_VERSION = '1.0.0';

/**
 * How many entries a first `ledger_read` returns when the caller names no
 * `since` and the process has no cursor yet.
 *
 * A bound rather than "everything": the first read of a long-lived ledger would
 * otherwise put months of history into one tool result.
 */
export const LEDGER_READ_DEFAULT_LIMIT = 50;

/** How long a receiver call may take before the tool reports a failure. */
export const RECEIVER_TIMEOUT_MS = 5_000;

/** The only JSON-RPC version MCP uses. */
export const JSONRPC_VERSION = '2.0';

/** Standard JSON-RPC: the method is not one this server implements. */
export const RPC_METHOD_NOT_FOUND = -32601;

/** Standard JSON-RPC: the params were the wrong shape, or named no such tool. */
export const RPC_INVALID_PARAMS = -32602;

/** Standard JSON-RPC: a handler threw instead of producing a result. */
export const RPC_INTERNAL_ERROR = -32603;

/**
 * A message from the client. A request has an `id`; a notification does not.
 *
 * `id` is typed `null` as well as absent because the spec allows a client to
 * send `"id": null` on a genuine request — but this server treats a `null` id
 * exactly like a missing one: both draw no reply, per `handleMessage`.
 */
export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string | number;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string | number;
  error: { code: number; message: string };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** One tool, as `tools/list` reports it. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * What `tools/call` answers with.
 *
 * A tool **failure is a result**, not a JSON-RPC error: `isError: true` with the
 * reason as text, so the model can read what went wrong and choose differently.
 * A JSON-RPC error is reserved for the protocol failing — an unknown method or
 * an unknown tool name — which the model cannot act on.
 */
export interface CallToolResult {
  content: { type: 'text'; text: string }[];
  isError: boolean;
  /**
   * The same payload as the text block, as data rather than a string to parse.
   *
   * Observed against real `claude` 2.1.251: the client reads this field and
   * **prefers it over `content`'s text** when both are present and disagree.
   * It does that without the tool having declared an `outputSchema` — so this
   * is additive, not a contract. `outputSchema` is deliberately never declared
   * on any tool here: it would oblige every successful result to validate
   * against it, which is a sharp edge for an `isError` result that carries no
   * payload at all. Optional, and present on only the two tools where a model
   * would otherwise have to parse a JSON string or a sentence to get at it.
   */
  structuredContent?: Record<string, unknown>;
}
