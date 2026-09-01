// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { agentMcpConfig } from '../../../../electron/main/mcp/agent-config';
import { MCP_SERVER_NAME } from '@shared/mcp-contract';
import { SLACK_MCP_URL, SLACK_SERVER_KEY } from '@shared/slack-contract';

/**
 * The pure builder behind a per-agent `--mcp-config` (HIVE-123, task 2).
 *
 * `paths.test.ts` next door would cover `agentMcpConfigFile`; this file is the
 * content, which is what `--strict-mcp-config` makes the entire set of
 * servers a wake can see.
 */

const HIVE = { command: '/App', args: ['/host.js'], env: { ELECTRON_RUN_AS_NODE: '1' } };

describe('agentMcpConfig', () => {
  it('names the hive server and Slack, keyed so the tools are mcp__slack__*', () => {
    const parsed = JSON.parse(agentMcpConfig(HIVE, ['slack']));

    expect(Object.keys(parsed.mcpServers)).toEqual([MCP_SERVER_NAME, SLACK_SERVER_KEY]);
    expect(parsed.mcpServers[SLACK_SERVER_KEY].url).toBe(SLACK_MCP_URL);
    expect(parsed.mcpServers[MCP_SERVER_NAME]).toEqual(HIVE);
  });

  it('ignores an integration it does not know, rather than writing a broken server', () => {
    const parsed = JSON.parse(agentMcpConfig(HIVE, ['nope']));

    expect(Object.keys(parsed.mcpServers)).toEqual([MCP_SERVER_NAME]);
  });

  it('always carries the hive server — an agent reads its inbox first', () => {
    const parsed = JSON.parse(agentMcpConfig(HIVE, []));

    expect(parsed.mcpServers[MCP_SERVER_NAME]).toEqual(HIVE);
  });
});
