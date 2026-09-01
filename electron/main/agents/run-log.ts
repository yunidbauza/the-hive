import { formatRunCost, type RunLine } from '@shared/agent-contract';

/**
 * Folding a child's `stream-json` stdout into run-log lines (HIVE-115).
 *
 * ## Why a fold rather than a function over lines
 *
 * A pipe splits wherever it likes. `{"type":"assistant"` and the rest of that
 * object routinely arrive as two chunks, and a parser that treated each chunk
 * as whole lines would drop the event entirely. Carrying the unterminated tail
 * in the state is what makes the reading independent of how the OS sliced the
 * stream.
 *
 * ## Why nothing here throws
 *
 * This runs inside a stdout handler. A throw would take the rest of the run's
 * log with it, so an unparseable line is silently nothing — and lines that are
 * not events routinely share this pipe: warnings, and the `system` and
 * `rate_limit_event` noise the CLI emits between turns.
 */

/** What the `result` event told us. */
export interface RunResult {
  subtype: string;
  costUsd?: number;
  turns?: number;
  sessionUuid?: string;
}

/** One entry from the `init` event's `mcp_servers` array. */
export interface McpServerStatus {
  name: string;
  status: string;
}

export interface LogFold {
  /** Bytes after the last `\n`, carried into the next chunk. */
  partial: string;
  result: RunResult | null;
  /**
   * What the run's own first line said about its MCP servers (HIVE-123).
   *
   * Free: the `init` event is already on the wire, so an agent's Slack status
   * is observable on every wake without a probe. This is what lets the
   * scheduler say *why* a wake was skipped instead of letting the run fail on
   * its first tool call.
   */
  mcpServers: McpServerStatus[] | null;
}

export const NO_LOG: LogFold = { partial: '', result: null, mcpServers: null };

/** How much of a tool's arguments the log shows. */
const ARG_LIMIT = 60;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;

const shortArgs = (input: unknown): string => {
  const record = asRecord(input);

  if (record === null) return '';

  // The first string value is what a reader recognises the call by: a Bash
  // `command`, a Read `file_path`, a ledger `body`.
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value !== '') {
      return value.length > ARG_LIMIT
        ? `${value.slice(0, ARG_LIMIT)}…`
        : value;
    }
  }

  return '';
};

function readEvent(
  line: string,
): {
  lines: RunLine[];
  result: RunResult | null;
  mcpServers: McpServerStatus[] | null;
} {
  const text = line.trim();

  if (text === '') return { lines: [], result: null, mcpServers: null };

  let event: Record<string, unknown> | null;

  try {
    event = asRecord(JSON.parse(text));
  } catch {
    return { lines: [], result: null, mcpServers: null };
  }

  if (event === null) return { lines: [], result: null, mcpServers: null };

  if (event['type'] === 'system' && event['subtype'] === 'init') {
    const servers = event['mcp_servers'];

    const mcpServers = Array.isArray(servers)
      ? servers.filter(
          (server): server is McpServerStatus =>
            typeof server === 'object' &&
            server !== null &&
            typeof (server as { name?: unknown }).name === 'string' &&
            typeof (server as { status?: unknown }).status === 'string',
        )
      : null;

    return { lines: [], result: null, mcpServers };
  }

  if (event['type'] === 'assistant') {
    const message = asRecord(event['message']);
    const content = message === null ? null : message['content'];
    const lines: RunLine[] = [];

    if (Array.isArray(content)) {
      for (const raw of content) {
        const block = asRecord(raw);

        if (block === null) continue;

        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          const said = block['text'].trim();

          if (said !== '') lines.push({ text: said, color: 'ink' });
        }

        if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
          const name = block['name'];
          const args = shortArgs(block['input']);

          lines.push({
            text: args === '' ? name : `${name} ${args}`,
            // An ask is the one tool call that changes what the user must do.
            color: name === 'mcp__hive__ledger_ask' ? 'amber' : 'dim',
          });
        }
      }
    }

    return { lines, result: null, mcpServers: null };
  }

  if (event['type'] === 'result') {
    const subtype =
      typeof event['subtype'] === 'string' ? event['subtype'] : 'unknown';
    const costUsd =
      typeof event['total_cost_usd'] === 'number'
        ? event['total_cost_usd']
        : undefined;
    const turns =
      typeof event['num_turns'] === 'number' ? event['num_turns'] : undefined;
    const sessionUuid =
      typeof event['session_id'] === 'string' ? event['session_id'] : undefined;

    const result: RunResult = {
      subtype,
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(turns === undefined ? {} : { turns }),
      ...(sessionUuid === undefined ? {} : { sessionUuid }),
    };

    // The contract's formatter, not a second one: this line and the agent
    // row both show one run's cost, and two spellings of it on one screen is a
    // bug the reader has to reconcile.
    const formatted = formatRunCost(costUsd);
    const cost = formatted === undefined ? '' : ` · ${formatted}`;

    return {
      lines: [{ text: `● turn ended — ${subtype}${cost}`, color: 'cyan' }],
      result,
      mcpServers: null,
    };
  }

  /*
    `system`, `rate_limit_event`, `user` (tool results) and anything the CLI
    adds later: not the agent speaking, so not the run log's business.

    `null`, meaning "this line said nothing about the result" — not
    `state.result`, which is the result as it was when the *chunk* arrived. The
    accumulator in `foldRunLog` already starts there and only moves forward, so
    returning it here made a `result` line followed by a `system` line **in one
    chunk** revert to the earlier value — which is the ordering `claude` actually
    produces at the end of a turn.
  */
  return { lines: [], result: null, mcpServers: null };
}

export function foldRunLog(
  state: LogFold,
  chunk: string,
): { state: LogFold; lines: RunLine[] } {
  const parts = `${state.partial}${chunk}`.split('\n');
  // Whatever followed the final `\n` — empty when the chunk ended cleanly, an
  // unfinished event when it did not.
  const partial = parts.pop() ?? '';
  const lines: RunLine[] = [];
  let result = state.result;
  let mcpServers = state.mcpServers;

  for (const part of parts) {
    const read = readEvent(part);

    lines.push(...read.lines);
    if (read.result !== null) result = read.result;
    if (read.mcpServers !== null) mcpServers = read.mcpServers;
  }

  return { state: { partial, result, mcpServers }, lines };
}
