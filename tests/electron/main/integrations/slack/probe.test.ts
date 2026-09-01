// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  probeSlack,
  SLACK_PROBE_MAX_TURNS,
  SLACK_PROBE_PROMPT,
  SLACK_PROBE_TIMEOUT_MS,
} from '../../../../../electron/main/integrations/slack/probe';
import { SILENT_FAILURE, TIMED_OUT } from '../../../../../electron/main/integrations/slack/outcome';
import { SLACK_TOOL_GLOB, slackOnlyMcpConfig } from '@shared/slack-contract';

const init = (servers: unknown) =>
  `${JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: servers })}\n`;

const attached = (status: string) => ({
  code: 0,
  stdout: init([{ name: 'slack', status }]),
  stderr: '',
  timedOut: false,
});

describe('probeSlack', () => {
  it('is connected when the run reports the server attached', async () => {
    const run = () => Promise.resolve(attached('connected'));

    await expect(probeSlack('claude', run)).resolves.toEqual({ kind: 'connected' });
  });

  it('is needs-auth when the init event says so', async () => {
    const run = () => Promise.resolve(attached('needs-auth'));

    await expect(probeSlack('claude', run)).resolves.toEqual({ kind: 'needs-auth' });
  });

  /**
   * A third status word, which is the point: this used to match `needs-auth`
   * and let **everything else** fall through to `connected` — so a server
   * answering `failed` was reported as a working connection, the one direction
   * the module comment calls dangerous. `agents/runs.ts` fixed the same hole on
   * its own side; the two readings of one server must not disagree.
   */
  it('does not call an unrecognised status connected', async () => {
    const run = () => Promise.resolve(attached('failed'));

    await expect(probeSlack('claude', run)).resolves.toEqual({
      kind: 'error',
      message: 'Slack\'s MCP server reported "failed".',
    });
  });

  it('is pending-approval when the tool call reports the server unapproved', async () => {
    const stdout = `${init([{ name: 'slack', status: 'connected' }])}${JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'The Slack MCP server has not been approved by a workspace admin.',
    })}\n`;
    const run = () => Promise.resolve({ code: 0, stdout, stderr: '', timedOut: false });

    await expect(probeSlack('claude', run)).resolves.toEqual({ kind: 'pending-approval' });
  });

  it('is pending-approval when the raw refusal is buried in a tool-result event, even if the model paraphrases it blandly', async () => {
    // Schema unmeasured — this is a plausible shape for a tool_result content
    // block, not a claim about the real one. The point is that probeSlack
    // must not depend on it: it should find the refusal by scanning raw text.
    const toolResult = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            is_error: true,
            content: 'Error: The Slack MCP server has not been approved by a workspace admin.',
          },
        ],
      },
    };
    const finalResult = {
      type: 'result',
      subtype: 'success',
      result: 'I could not complete that.',
    };
    const stdout = `${init([{ name: 'slack', status: 'connected' }])}${JSON.stringify(toolResult)}\n${JSON.stringify(finalResult)}\n`;
    const run = () => Promise.resolve({ code: 0, stdout, stderr: '', timedOut: false });

    await expect(probeSlack('claude', run)).resolves.toEqual({ kind: 'pending-approval' });
  });

  it('is an error when no init event arrives at all', async () => {
    const run = () =>
      Promise.resolve({ code: 1, stdout: '', stderr: 'boom', timedOut: false });

    await expect(probeSlack('claude', run)).resolves.toEqual({
      kind: 'error',
      message: 'boom',
    });
  });

  /**
   * The blank-caption case. A killed run prints nothing on either stream, and
   * the earlier `failure` handed the pane an empty red line.
   */
  it('says something when the run died silently', async () => {
    const run = () =>
      Promise.resolve({ code: -1, stdout: '', stderr: '', timedOut: false });

    await expect(probeSlack('claude', run)).resolves.toEqual({
      kind: 'error',
      message: SILENT_FAILURE,
    });
  });

  it('names the timeout rather than echoing the half-written stream', async () => {
    const run = () =>
      Promise.resolve({
        code: -1,
        stdout: '{"type":"stream_event"',
        stderr: '',
        timedOut: true,
      });

    await expect(probeSlack('claude', run)).resolves.toEqual({
      kind: 'error',
      message: TIMED_OUT,
    });
  });

  it('reports a binary that could not be executed rather than throwing', async () => {
    const run = () => Promise.reject(new Error('spawn ENOENT'));

    await expect(probeSlack('claude', run)).resolves.toEqual({
      kind: 'error',
      message: 'Could not run claude: spawn ENOENT',
    });
  });

  /**
   * The exact argv, because this is the one place a regression in it is caught.
   *
   * Two of these arguments were missing and the probe could not succeed
   * without them:
   *
   * - `--mcp-config` with a Slack-only server set. `--strict-mcp-config` makes
   *   the named set the **entire** set, so strict with no config is an empty
   *   set: the init event never lists `slack` and every probe returns `error`.
   * - `ToolSearch` in the grant. MCP tool schemas are deferred (`waker.ts`
   *   grants it on every wake for the same reason), so `mcp__slack__*` alone
   *   is a grant the model cannot act on — and this prompt opens by telling it
   *   to call `ToolSearch`.
   *
   * The timeout is pinned too: on the five-second synchronous runner this used
   * to share with `gh auth status`, a model turn was killed every time.
   *
   * And `--max-turns`, which shipped as `1`. Measured at 2.1.252, one turn is
   * spent entirely on the `ToolSearch` the prompt asks for first: the run ends
   * `error_max_turns` having called no Slack tool at all, so there is no
   * refusal to match and an unapproved workspace comes back `connected`. Three
   * is the arithmetic floor — search, call, answer — and the assertion is
   * written as a floor rather than as a number, because what must never come
   * back is a cap below it.
   */
  it('spends enough capped model turns to actually call a slack tool, against a server set it can load', async () => {
    const calls: { args: string[]; timeoutMs: number | undefined }[] = [];
    const run = (
      _f: string,
      args: readonly string[],
      options?: { timeoutMs?: number },
    ) => {
      calls.push({ args: [...args], timeoutMs: options?.timeoutMs });

      return Promise.resolve(attached('connected'));
    };

    await probeSlack('claude', run);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      '-p',
      '--mcp-config', slackOnlyMcpConfig(),
      '--strict-mcp-config',
      '--setting-sources', '',
      '--max-turns', String(SLACK_PROBE_MAX_TURNS),
      '--allowedTools', `${SLACK_TOOL_GLOB},ToolSearch`,
      '--output-format', 'stream-json',
      '--verbose',
      SLACK_PROBE_PROMPT,
    ]);
    expect(calls[0]?.timeoutMs).toBe(SLACK_PROBE_TIMEOUT_MS);
    expect(SLACK_PROBE_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(SLACK_PROBE_MAX_TURNS).toBeGreaterThanOrEqual(3);
  });
});
