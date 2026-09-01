// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { probeSlack } from '../../../../../electron/main/integrations/slack/probe';
import { SLACK_TOOL_GLOB } from '@shared/slack-contract';

const init = (servers: unknown) =>
  `${JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: servers })}\n`;

describe('probeSlack', () => {
  it('is connected when the run reports the server attached', () => {
    const run = () => ({ code: 0, stdout: init([{ name: 'slack', status: 'connected' }]), stderr: '' });

    expect(probeSlack('claude', run)).toEqual({ kind: 'connected' });
  });

  it('is needs-auth when the init event says so', () => {
    const run = () => ({ code: 0, stdout: init([{ name: 'slack', status: 'needs-auth' }]), stderr: '' });

    expect(probeSlack('claude', run)).toEqual({ kind: 'needs-auth' });
  });

  it('is pending-approval when the tool call reports the server unapproved', () => {
    const stdout = `${init([{ name: 'slack', status: 'connected' }])}${JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'The Slack MCP server has not been approved by a workspace admin.',
    })}\n`;
    const run = () => ({ code: 0, stdout, stderr: '' });

    expect(probeSlack('claude', run)).toEqual({ kind: 'pending-approval' });
  });

  it('is pending-approval when the raw refusal is buried in a tool-result event, even if the model paraphrases it blandly', () => {
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
    const run = () => ({ code: 0, stdout, stderr: '' });

    expect(probeSlack('claude', run)).toEqual({ kind: 'pending-approval' });
  });

  it('is an error when no init event arrives at all', () => {
    const run = () => ({ code: 1, stdout: '', stderr: 'boom' });

    expect(probeSlack('claude', run)).toEqual({ kind: 'error', message: 'boom' });
  });

  it('spends exactly one capped model turn scoped to slack tools only', () => {
    const calls: string[][] = [];
    const run = (_f: string, args: readonly string[]) => {
      calls.push([...args]);

      return { code: 0, stdout: init([{ name: 'slack', status: 'connected' }]), stderr: '' };
    };

    probeSlack('claude', run);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      '-p',
      '--strict-mcp-config',
      '--setting-sources', '',
      '--max-turns', '1',
      '--allowedTools', SLACK_TOOL_GLOB,
      '--output-format', 'stream-json',
      '--verbose',
      'Use ToolSearch to load the schema for a Slack tool that reports who I am, call it, and reply with one line. If any tool call fails, quote the error message verbatim in your reply.',
    ]);
  });
});
