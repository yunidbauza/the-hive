import { join } from 'node:path';

import { writeMcpConfig } from './config';
import { MCP_CONFIG_FILE } from './paths';

/**
 * The MCP config runtime (HIVE-112).
 *
 * A sibling of the skills and hooks runtimes, and the smallest of the three:
 * its file's content depends only on where the app is installed and where its
 * own bundle sits, neither of which changes while the app runs. So it is
 * written **once at launch** rather than before every spawn the way the plugin
 * directory is — and a rewrite on every launch is already enough to overwrite a
 * stale path left by an older build.
 */

export interface McpRuntime {
  /** Write the config. Never rejects; a failure leaves the flag omitted. */
  start(): Promise<void>;
  /**
   * The `--mcp-config` argument, or `null` when the file has never been
   * written successfully.
   *
   * `null` is the honest answer rather than an optimistic path, exactly as
   * `pluginDirPath()` is: `bootstrap.ts` omits the flag for it, and a session
   * with no ledger tools is strictly better than one pointed at a file that is
   * not there — `claude` reports a missing `--mcp-config` as a startup error.
   */
  configPathFor(): string | null;
}

export interface McpRuntimeOptions {
  /** `app.getPath('userData')`, passed in so these tests need no Electron. */
  userDataPath: string;
  /** `process.execPath`. */
  execPath: string;
  /** Absolute path to `mcp-host.js`, resolved by the caller. */
  scriptPath: string;
}

export function createMcpRuntime({
  userDataPath,
  execPath,
  scriptPath,
}: McpRuntimeOptions): McpRuntime {
  const path = join(userDataPath, MCP_CONFIG_FILE);
  let written = false;

  return {
    async start(): Promise<void> {
      try {
        await writeMcpConfig(path, { execPath, scriptPath });
        written = true;
      } catch (cause) {
        /*
          Non-fatal, for the reason the skills runtime gives: a session that
          starts without its ledger tools works. A session that does not start
          because a file could not be written does not, and nothing on screen
          would connect the two.
        */
        written = false;
        console.info(
          `[hive] the MCP config could not be written — sessions start without ledger tools (${String(cause)})`,
        );
      }
    },

    configPathFor(): string | null {
      return written ? path : null;
    },
  };
}

export { mcpConfig, writeMcpConfig } from './config';
export { MCP_CONFIG_FILE } from './paths';
