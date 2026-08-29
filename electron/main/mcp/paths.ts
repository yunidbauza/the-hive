import { join } from 'node:path';

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
