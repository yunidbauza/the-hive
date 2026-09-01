import {
  SLACK_SERVER_KEY,
  SLACK_TOOL_GLOB,
  slackOnlyMcpConfig,
  type SlackStatus,
} from '@shared/slack-contract';

import type { RunAsync, RunResult } from '../github/run';

import { couldNotRun, failure } from './outcome';

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
 *
 * ## The two flags that make it a real probe
 *
 * `--mcp-config` carries {@link slackOnlyMcpConfig}, an inline JSON string
 * naming Slack and nothing else. `--strict-mcp-config` beside it makes that the
 * *entire* server set the run can see — which is the point (no hive server, no
 * user config, nothing but the thing under test), and which is also why strict
 * **without** a config is a bug rather than a tightening: the set is then
 * empty, no `slack` entry ever reaches the init event, and the probe reports an
 * error on a healthy connection every single time.
 *
 * `ToolSearch` is granted alongside `mcp__slack__*` for the reason
 * `agents/waker.ts` grants it on every wake: MCP tool schemas are **deferred**,
 * so the model sees `mcp__slack__*` by name but must call the built-in
 * `ToolSearch` to fetch a schema before it can invoke anything. Granting the
 * Slack glob without it grants nothing callable — and this prompt opens by
 * telling the model to use `ToolSearch`.
 *
 * ## Why this run is outside HIVE-119's permission fence, deliberately
 *
 * It is the one model run in the repo that grants tools without a
 * `--permission-prompt-tool` behind it, and that is a choice rather than an
 * oversight. `--setting-sources ''` is what makes the probe an *instrument*:
 * with the user's settings loaded, a `permissions.ask` rule of theirs would
 * stall a headless turn nobody is watching, and their `allow` rules would let
 * the probe answer about a server set that is not the one under test. An
 * instrument that reads differently on every machine measures nothing.
 *
 * What keeps that safe is the three flags around it, and each one is
 * load-bearing:
 *
 * - `--strict-mcp-config` with a Slack-only `--mcp-config` means the run sees
 *   **no hive server** — no ledger tools, no permission tool, nothing that can
 *   write to this app's state.
 * - `--allowedTools` is the complete grant, and it is two entries: Slack's own
 *   glob and `ToolSearch`. No Bash, no file tools, no network tool. Anything
 *   the model tried outside that list would be denied for want of a grant,
 *   not merely unprompted.
 * - {@link SLACK_PROBE_MAX_TURNS} bounds the run whatever it does.
 *
 * So the worst case is a handful of Slack tool calls made as the signed-in
 * user — which is precisely what the Test button exists to attempt, on a
 * prompt that asks only who they are. Adding a fence here would mean loading
 * settings the probe is defined by not loading; the honest form is this
 * comment and a grant narrow enough to read in one line.
 */

/** Slack's refusal when the server is not approved for the workspace. */
const UNAPPROVED = /not been approved|not approved|admin approval/i;

/**
 * Three minutes.
 *
 * A model turn, plus an HTTP MCP handshake, plus a tool round-trip to Slack.
 * Tens of seconds is the normal case; this is the backstop for a run that has
 * stopped making progress, not a budget anyone should be near.
 */
export const SLACK_PROBE_TIMEOUT_MS = 3 * 60_000;

/**
 * Five turns, and one is not enough.
 *
 * Measured against `claude` 2.1.252 with `--max-turns 1`: the run went
 * `tool_use` → `tool_result` → `result` with subtype `error_max_turns`, and
 * stopped there. The cap was spent on the `ToolSearch` this prompt's first
 * sentence asks for, so **no `mcp__slack__*` tool was ever called** — which
 * made the whole probe a lie in the one direction the module comment calls
 * dangerous: with no tool call there is no refusal to match, so a workspace
 * that has *not* approved the server was reported `connected`.
 *
 * Three is the arithmetic minimum — search, call, answer. Five leaves room for
 * a second `ToolSearch` or one retry without turning a slow answer into a
 * false one, and is still far under the eight the live agent scenarios in this
 * same story allow themselves. It is a real cost: a click on Test can now
 * spend up to five model turns rather than one.
 */
export const SLACK_PROBE_MAX_TURNS = 5;

/**
 * What the model is asked to do.
 *
 * "Quote the error message verbatim" is load-bearing: the accumulator below
 * reads the raw stream, but the model's own reply is the fallback instrument
 * and a bland paraphrase makes it useless.
 */
export const SLACK_PROBE_PROMPT =
  'Use ToolSearch to load the schema for a Slack tool that reports who I am, call it, and reply with one line. If any tool call fails, quote the error message verbatim in your reply.';

export async function probeSlack(
  claude: string,
  run: RunAsync,
): Promise<SlackStatus> {
  let result: RunResult;

  try {
    result = await run(
      claude,
      [
        '-p',
        '--mcp-config', slackOnlyMcpConfig(),
        '--strict-mcp-config',
        '--setting-sources', '',
        '--max-turns', String(SLACK_PROBE_MAX_TURNS),
        '--allowedTools', `${SLACK_TOOL_GLOB},ToolSearch`,
        '--output-format', 'stream-json',
        '--verbose',
        SLACK_PROBE_PROMPT,
      ],
      { timeoutMs: SLACK_PROBE_TIMEOUT_MS },
    );
  } catch (cause) {
    return couldNotRun(cause);
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

  // No init event, or one that never named the server: the run did not get far
  // enough to answer the question. `failure` rather than a hand-rolled message
  // so a run that died silently — a timeout kills stdout mid-stream — still
  // says something.
  if (status === null) return failure(result);

  if (status === 'needs-auth') return { kind: 'needs-auth' };

  /*
    Matched exactly, never "anything that is not needs-auth".

    The init event can report other words — `failed` is the one a broken
    endpoint gives — and falling through to `connected` claimed a working
    connection this run had not observed, in the direction the module comment
    calls dangerous. `agents/runs.ts` fixed exactly this on its own side and
    wrote down why; this is the same server read through a different
    instrument, and the two halves of one story must not disagree about it.
  */
  if (status !== 'connected') {
    return {
      kind: 'error',
      message: `Slack's MCP server reported "${status}".`,
    };
  }

  // The connection is real; whether the workspace allows it is what the turns
  // were spent to find out. Check the model's own reply first, but fall back
  // to the raw stream — the dangerous direction is a false "connected", so
  // the prose match is a fallback, never the sole instrument.
  if (UNAPPROVED.test(text) || UNAPPROVED.test(accumulated)) return { kind: 'pending-approval' };

  return { kind: 'connected' };
}
