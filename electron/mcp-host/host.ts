import {
  HOOK_ENV_GRANTS,
  HOOK_ENV_RECEIVER_URL,
  HOOK_ENV_RUN,
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
} from '@shared/hook-contract';
import { AGENTS_TOOL, APPROVE_TOOL, LEDGER_TOOLS } from '@shared/ledger-tools';
import type { CallToolResult } from '@shared/mcp-contract';

import { createReceiverClient } from './client';
import type { RpcHandlers } from './rpc';
import { createToolHandlers } from './tools';

/**
 * The Hive's MCP server, minus the process wiring (HIVE-112).
 *
 * Started by `claude`, not by the app: the Hive writes a config file naming
 * `electron/mcp-host/index.ts`'s build output, and every session it spawns is
 * launched with `--mcp-config` pointing at it. So the process has no arguments
 * worth reading and no window — everything it needs arrives in the
 * environment.
 *
 * Identity comes from the environment on purpose: none of this host's tools
 * accepts a `from`, so a model calling them has no argument through which to
 * name a different session. That used to be a property of the **MCP tool
 * surface** alone, not a transport-level guarantee: every session shared one
 * receiver-wide token (HIVE-111), so a model with shell access could `curl`
 * the receiver directly with another session's header value and be believed.
 * The receiver now binds each session's token to its own id — a token proves
 * only the session it was derived for (HIVE-112) — so that `curl` is refused
 * with a 403 at the transport itself, and this host's identity guarantee no
 * longer depends solely on its narrow tool surface.
 *
 * This module has no side effects at import: no `process.stdin`, no
 * `serve(...)` call. That is what lets it be imported directly in a test.
 * `index.ts` is the thin entry point that wires this to stdio.
 */

export interface HostEnvironment {
  session: string;
  token: string;
  url: string;
  /** The run this process belongs to, from `HIVE_RUN_ID` (HIVE-128). */
  run?: string;
}

/** The three variables, or `null` if any is missing. */
export function readEnvironment(env: NodeJS.ProcessEnv): HostEnvironment | null {
  const session = env[HOOK_ENV_SESSION];
  const token = env[HOOK_ENV_TOKEN];
  const url = env[HOOK_ENV_RECEIVER_URL];

  if (
    session === undefined ||
    session === '' ||
    token === undefined ||
    token === '' ||
    url === undefined ||
    url === ''
  ) {
    return null;
  }

  const run = env[HOOK_ENV_RUN];

  return {
    session,
    token,
    url,
    // Optional: a pty session has no run. Empty is the same as absent.
    ...(run === undefined || run === '' ? {} : { run }),
  };
}

/** `HIVE_GRANTS`, or an empty list — which fences everything, never nothing. */
export function readGrants(env: NodeJS.ProcessEnv): string[] {
  const raw = env[HOOK_ENV_GRANTS];
  if (raw === undefined || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((rule): rule is string => typeof rule === 'string' && rule !== '')
      : [];
  } catch {
    return [];
  }
}

const unreachable = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

/**
 * The handlers, with or without a Hive to talk to.
 *
 * ## Why a missing environment is not fatal
 *
 * A server that exited here would show in `/mcp` as a failed connection with no
 * explanation, and `claude` would keep retrying it. Listing the tools and
 * refusing each *call* with a sentence is strictly more useful: the user sees
 * the server connected, and the model is told why the ledger is out of reach
 * rather than watching a tool disappear.
 */
export function createHandlers(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof globalThis.fetch,
): RpcHandlers {
  const environment = readEnvironment(env);

  if (environment === null) {
    return {
      // The same list the reachable path serves, deliberately: a tool set that
      // differed by how the process was started would make `/mcp` report a
      // different server than the one an agent actually gets.
      listTools: () => [...LEDGER_TOOLS, AGENTS_TOOL, APPROVE_TOOL],
      callTool: async () =>
        unreachable(
          'The ledger is not reachable: this process was started outside The Hive, or the app is not running. Nothing was written.',
        ),
    };
  }

  return createToolHandlers(
    createReceiverClient({
      url: environment.url,
      session: environment.session,
      token: environment.token,
      ...(environment.run === undefined ? {} : { run: environment.run }),
      fetch: fetchImpl,
    }),
    readGrants(env),
  );
}
