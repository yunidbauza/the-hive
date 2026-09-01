import { MCP_SERVER_NAME } from '@shared/mcp-contract';
import { SLACK_SERVER_KEY, slackServerSpec } from '@shared/slack-contract';

/**
 * The `--mcp-config` file for an agent that names an integration (HIVE-123).
 *
 * HIVE-115 deliberately did not write one: it would have been byte-identical
 * to the shared `hive.mcp.json` for every agent. This is the story that gives
 * it something to differ by, so the rule it was deferred under is satisfied
 * rather than broken.
 *
 * `--strict-mcp-config` is on every wake, which makes this file the *entire*
 * set of servers the run can see. That is why the hive server is written here
 * unconditionally rather than merged in from anywhere: nothing else gets in.
 */

/** The stdio descriptor `mcp/config.ts` builds for the hive server. */
export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * An integration name from `def.mcp` → its server descriptor.
 *
 * An unknown name yields nothing rather than a placeholder. `parseAgent`
 * already refuses a definition naming an integration outside
 * `KNOWN_AGENT_MCP`, so an unknown name reaching here means the two lists
 * disagreed — and writing a malformed server would fail the whole run with an
 * error that names the file rather than the definition.
 */
const SPECS: Record<string, () => unknown> = {
  [SLACK_SERVER_KEY]: slackServerSpec,
};

export function agentMcpConfig(
  hive: McpServerSpec,
  integrations: readonly string[],
): string {
  const mcpServers: Record<string, unknown> = { [MCP_SERVER_NAME]: hive };

  for (const name of integrations) {
    const spec = SPECS[name];

    if (spec !== undefined) mcpServers[name] = spec();
  }

  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}
