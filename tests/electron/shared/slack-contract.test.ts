import { describe, expect, it } from 'vitest';

import {
  SLACK_CALLBACK_PORT,
  SLACK_CLIENT_ID,
  SLACK_MCP_URL,
  SLACK_SERVER_KEY,
  SLACK_TOOL_GLOB,
  grantsSlackTools,
  slackOnlyMcpConfig,
  slackServerSpec,
} from '@shared/slack-contract';

describe('slackServerSpec', () => {
  it('is the http server descriptor `--mcp-config` expects', () => {
    expect(slackServerSpec()).toEqual({
      type: 'http',
      url: SLACK_MCP_URL,
      oauth: { clientId: SLACK_CLIENT_ID, callbackPort: SLACK_CALLBACK_PORT },
    });
  });

  it('keys on `slack`, because that is what names the tools', () => {
    expect(SLACK_SERVER_KEY).toBe('slack');
    expect(SLACK_TOOL_GLOB).toBe('mcp__slack__*');
  });
});

/**
 * The probe's server set (HIVE-123).
 *
 * A JSON **string**, not a path: `--mcp-config` takes "JSON files or strings"
 * (measured, `claude` 2.1.252), so the Test button needs no temp file. It is
 * what makes `--strict-mcp-config` a scoping flag rather than a bug — strict
 * with no config names an *empty* server set, so the run's init event never
 * lists `slack` and the probe fails on a healthy connection every time.
 */
describe('slackOnlyMcpConfig', () => {
  it('names slack and nothing else', () => {
    const parsed = JSON.parse(slackOnlyMcpConfig()) as {
      mcpServers: Record<string, unknown>;
    };

    expect(Object.keys(parsed.mcpServers)).toEqual([SLACK_SERVER_KEY]);
    expect(parsed.mcpServers[SLACK_SERVER_KEY]).toEqual(slackServerSpec());
  });

  it('is a single argv-safe line, not a path', () => {
    expect(slackOnlyMcpConfig()).not.toContain('\n');
    expect(() => JSON.parse(slackOnlyMcpConfig())).not.toThrow();
  });
});

describe('grantsSlackTools', () => {
  it('is true for the glob and for any single slack tool', () => {
    expect(grantsSlackTools(['mcp__slack__*'])).toBe(true);
    expect(grantsSlackTools(['Read', 'mcp__slack__search'])).toBe(true);
  });

  it('is false when nothing names a slack tool', () => {
    expect(grantsSlackTools([])).toBe(false);
    expect(grantsSlackTools(['Read', 'Grep'])).toBe(false);
    // A near miss must not count — this is what the pane's hint depends on.
    expect(grantsSlackTools(['mcp__hive__*'])).toBe(false);
  });
});
