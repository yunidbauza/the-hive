import { join } from 'node:path';

import { AGENTS_DIR } from '@shared/agent-contract';

/**
 * Where the generated MCP config lives inside userData (HIVE-112).
 *
 * A path *segment* rather than an absolute path, exactly like `PLUGIN_DIR` next
 * door: the absolute form needs `app.getPath`, which only the process that has
 * Electron can call, and keeping the constant relative is what lets this
 * module's tests run under plain Node.
 *
 * Beside the plugin directory and the hook settings, not inside the plugin:
 * the plugin is `--plugin-dir`'s and carries skills. This file is
 * `--mcp-config`'s, and the distinction is load-bearing — a server delivered
 * through the plugin is named `mcp__plugin_hive_hive__*` and one delivered
 * through `--mcp-config` is named `mcp__hive__*`, which is the name HIVE-115's
 * preamble and HIVE-119's permission tool both depend on.
 */
export const MCP_CONFIG_FILE = join('hive', 'hive.mcp.json');

/**
 * `<userData>/hive/agents/<name>.mcp.json` — an agent's own server set.
 *
 * Beside `<name>.system.md` rather than under `~/.hive/agents/`, and for the
 * same two reasons that file is: it is app-generated and rewritten every wake,
 * and `~/.hive/agents/` is watched recursively, so writing here would re-parse
 * every definition on every wake.
 *
 * Built from the same `AGENTS_DIR` `agents/paths.ts` builds `AGENT_PROMPT_DIR`
 * from. It is one directory holding both files, so it is one literal: a second
 * `'agents'` spelled here is a rename waiting to split them, and the pair would
 * still resolve — one to a folder nothing else writes to.
 */
export const AGENT_MCP_DIR = join('hive', AGENTS_DIR);

export const agentMcpConfigFile = (userDataPath: string, name: string): string =>
  join(userDataPath, AGENT_MCP_DIR, `${name}.mcp.json`);
