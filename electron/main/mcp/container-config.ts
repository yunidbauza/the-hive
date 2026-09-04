import type { ContainerFreshness } from '@shared/config-contract';
import {
  HOOK_ENV_RECEIVER_URL,
  HOOK_ENV_RUN,
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  HOOK_HEADER_RUN,
  HOOK_HEADER_SESSION,
  HOOK_HEADER_TOKEN,
} from '@shared/hook-contract';
import { MCP_PATH, MCP_SERVER_NAME } from '@shared/mcp-contract';

/**
 * The container-flavoured `--mcp-config` (HIVE-132).
 *
 * Beside `hiveServerSpec` in `config.ts` on purpose: the shared stdio file and
 * this one must never define the hive server two different ways. The server
 * name stays {@link MCP_SERVER_NAME} because delivery decides tool naming —
 * `--mcp-config` yields `mcp__hive__*`, which the agent preamble (HIVE-115) and
 * the permission tool (HIVE-119) both depend on (`paths.ts:14-18`).
 *
 * HTTP rather than stdio because a container has no path to the app's own
 * binary. The route it speaks to is HIVE-130's `POST /mcp`.
 *
 * `--strict-mcp-config` is passed on every wake (`agents/waker.ts:234`), which
 * makes this file the *entire* server set a run can see. It is therefore
 * emitted complete, never as something to merge.
 */

/** The HTTP descriptor, the counterpart to `config.ts`'s stdio one. */
export interface HttpServerSpec {
  type: 'http';
  url: string;
  headers: Record<string, string>;
}

/** What `rewrite` bakes in place of the `${VAR}` references. */
export interface ResolvedIdentity {
  /** The receiver's origin as the *container* must address it. */
  receiverUrl: string;
  session: string;
  token: string;
  /** Absent for a pty session, which has no run. */
  run?: string;
}

const shellRef = (name: string, fallback = ''): string =>
  `\${${name}${fallback}}`;

export function containerHiveServerSpec(
  freshness: ContainerFreshness,
  resolved?: ResolvedIdentity,
): HttpServerSpec {
  if (freshness === 'rewrite') {
    if (resolved === undefined) {
      throw new Error(
        'containerHiveServerSpec: rewrite needs resolved values — its whole purpose is that the container environment cannot be trusted',
      );
    }

    return {
      type: 'http',
      url: `${resolved.receiverUrl}${MCP_PATH}`,
      headers: {
        [HOOK_HEADER_SESSION]: resolved.session,
        [HOOK_HEADER_TOKEN]: resolved.token,
        /*
          Empty rather than omitted, matching what `:-` collapses to below. The
          route reads an empty run as absent (`receiver.ts:1026`), so the two
          modes agree on what a pty session sends.
        */
        [HOOK_HEADER_RUN]: resolved.run ?? '',
      },
    };
  }

  return {
    type: 'http',
    url: `${shellRef(HOOK_ENV_RECEIVER_URL)}${MCP_PATH}`,
    headers: {
      [HOOK_HEADER_SESSION]: shellRef(HOOK_ENV_SESSION),
      [HOOK_HEADER_TOKEN]: shellRef(HOOK_ENV_TOKEN),
      /*
        Present with a default, and that is the whole trick. A pty session has
        no run, and `${VAR}` with nothing to substitute is sent as the literal
        text `${HIVE_RUN_ID}`; `:-` collapses it to empty. Without this line a
        containerised agent run loses `meta.run`, and its asks become
        indistinguishable from a concurrent neighbour's (HIVE-128).
      */
      [HOOK_HEADER_RUN]: shellRef(HOOK_ENV_RUN, ':-'),
    },
  };
}

export const containerMcpConfig = (
  freshness: ContainerFreshness,
  resolved?: ResolvedIdentity,
): string =>
  `${JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: containerHiveServerSpec(freshness, resolved),
      },
    },
    null,
    2,
  )}\n`;
