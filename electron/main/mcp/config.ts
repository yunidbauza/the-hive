import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { MCP_SERVER_NAME } from '@shared/mcp-contract';

/**
 * The `--mcp-config` file every Hive session is launched with (HIVE-112).
 */

export interface McpConfigOptions {
  /**
   * The app's own binary — `process.execPath`.
   *
   * Not a system `node`, and not optional. The host is loaded out of
   * `app.asar` in a packaged build, and only Electron's patched `fs` can read
   * it; a plain `node` would fail to resolve the script at all.
   */
  execPath: string;
  /** Absolute path to the built `mcp-host.js`. */
  scriptPath: string;
}

export const mcpConfig = ({ execPath, scriptPath }: McpConfigOptions): string =>
  `${JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: execPath,
          args: [scriptPath],
          /*
            Without this the Electron binary boots Chromium and opens a window
            instead of running the script. Verified against the real CLI: an
            `env` block in this file does reach the server process.
          */
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
      },
    },
    null,
    2,
  )}\n`;

/** Write the config, creating its directory if needed. Overwrites. */
export async function writeMcpConfig(
  path: string,
  options: McpConfigOptions,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, mcpConfig(options), 'utf8');
}
