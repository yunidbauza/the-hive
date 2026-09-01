import { join } from 'node:path';

import type { McpServerSpec } from './agent-config';
import { hiveServerSpec, writeMcpConfig } from './config';
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
  /**
   * Write the config. Never rejects; a failure leaves the flag omitted.
   *
   * Memoised: the write happens once, and every call — the fire-and-forget
   * one at construction and any later `await` on the spawn path — shares the
   * same in-flight (or settled) promise rather than triggering a second write.
   */
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
  /**
   * The hive server descriptor, for a per-agent config (HIVE-123).
   *
   * `null` on exactly the same condition `configPathFor()` is: if the shared
   * file could not be written, this process cannot serve ledger tools at all
   * and a per-agent file naming it would be a lie.
   */
  hiveServerSpec(): McpServerSpec | null;
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
  /*
    The in-flight (or settled) write, shared by every caller — the same
    memoisation `login-env.ts` uses for the login-shell probe. `registerIpcHandlers`
    fires this once, unawaited, at construction so a slow write cannot delay the
    first window; the `ptySpawn` and `ptyRestart` handlers `await` it before a
    session can be spawned, so a session can never observe `configPathFor()`
    returning `null` merely because the write had not finished yet. Awaiting a
    second time here costs nothing and writes the file only once.
  */
  let inFlight: Promise<void> | null = null;

  const run = async (): Promise<void> => {
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
  };

  return {
    start(): Promise<void> {
      inFlight ??= run();
      return inFlight;
    },

    configPathFor(): string | null {
      return written ? path : null;
    },

    hiveServerSpec(): McpServerSpec | null {
      return written ? hiveServerSpec({ execPath, scriptPath }) : null;
    },
  };
}

export { mcpConfig, writeMcpConfig } from './config';
export { MCP_CONFIG_FILE, AGENT_MCP_DIR, agentMcpConfigFile } from './paths';
export { agentMcpConfig, type McpServerSpec } from './agent-config';
