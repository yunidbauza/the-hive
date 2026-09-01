import { SLACK_SERVER_KEY, SLACK_TOOL_GLOB, type SlackStatus } from '@shared/slack-contract';

import type { RunCommand } from '../gh';

/**
 * The Test button: the only thing here that spends a model turn (HIVE-123).
 *
 * It spends one because workspace-admin approval is not observable any other
 * way — `claude mcp get` reports a perfectly healthy connection right up until
 * a tool call comes back refused. One turn, capped, is the cheapest honest
 * answer, and it is the difference between the pane saying "connected" and the
 * user's agents silently failing every wake.
 *
 * The instrument is the first `stream-json` line, a `system`/`init` event
 * carrying `mcp_servers: [{ name, status }]`. Measured: asking the model what
 * tools it has answers "NONE" even with a server attached, because MCP tool
 * schemas are deferred — the model's self-report is the wrong instrument.
 */

/** Slack's refusal when the server is not approved for the workspace. */
const UNAPPROVED = /not been approved|not approved|admin approval/i;

export function probeSlack(claude: string, run: RunCommand): SlackStatus {
  let result: ReturnType<RunCommand>;

  try {
    result = run(claude, [
      '-p',
      '--strict-mcp-config',
      '--setting-sources', '',
      '--max-turns', '1',
      '--allowedTools', SLACK_TOOL_GLOB,
      '--output-format', 'stream-json',
      '--verbose',
      'Use ToolSearch to load the schema for a Slack tool that reports who I am, call it, and reply with one line. If any tool call fails, quote the error message verbatim in your reply.',
    ]);
  } catch (cause) {
    return {
      kind: 'error',
      message: `Could not run claude: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  let status: string | null = null;
  let text = '';
  // Every event's raw text, not just the model's final paraphrase. Slack's
  // refusal appears verbatim in whatever tool-result event carries it; the
  // model's own summary of that event is not a reliable place to look for it
  // (Finding 1, HIVE-123 review) — accumulating the raw line means this needs
  // no assumption about the tool-result event's shape, which has not been
  // measured.
  let accumulated = '';

  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue;

    let event: Record<string, unknown>;

    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    accumulated += line;

    if (event['type'] === 'system' && event['subtype'] === 'init') {
      const servers = event['mcp_servers'];

      if (Array.isArray(servers)) {
        const slack = servers.find(
          (s): s is { name: string; status: string } =>
            typeof s === 'object' && s !== null && (s as { name?: unknown }).name === SLACK_SERVER_KEY,
        );

        status = slack?.status ?? null;
      }
    }

    if (event['type'] === 'result' && typeof event['result'] === 'string') {
      text = event['result'];
    }
  }

  if (status === null) {
    return { kind: 'error', message: (result.stderr.trim() || result.stdout).trim() };
  }

  if (status === 'needs-auth') return { kind: 'needs-auth' };
  // The connection is real; whether the workspace allows it is what the turn
  // was spent to find out. Check the model's own reply first, but fall back
  // to the raw stream — the dangerous direction is a false "connected", so
  // the prose match is a fallback, never the sole instrument.
  if (UNAPPROVED.test(text) || UNAPPROVED.test(accumulated)) return { kind: 'pending-approval' };

  return { kind: 'connected' };
}
