/**
 * Slack's hosted MCP server, and the facts about reaching it (HIVE-123).
 *
 * Every value here was measured against the live server and `claude` 2.1.252,
 * because the ticket's originals were documentation and three of them were
 * wrong. See the `UPDATED SPECS — 2026-09-01` section on HIVE-123.
 */

export const SLACK_MCP_URL = 'https://mcp.slack.com/mcp';

/**
 * Slack's own registered app, taken from the official
 * `slack@claude-plugins-official` plugin's `.mcp.json`.
 *
 * Not a secret, and not the user's to supply. Slack's authorization server
 * publishes no `registration_endpoint`, so dynamic client registration is
 * impossible and a fixed client id is *required* — without this constant,
 * `claude mcp login slack` fails with "Dynamic client registration not
 * supported". The flow is a public client with PKCE, so there is no client
 * secret anywhere in this app.
 */
export const SLACK_CLIENT_ID = '1601185624273.8899143856786';

/** Slack registered this exact redirect port. A different port is refused. */
export const SLACK_CALLBACK_PORT = 3118;

/**
 * The server's key in every generated `--mcp-config`.
 *
 * Load-bearing: a server delivered through `--mcp-config` is named after its
 * key, so this is precisely what makes the tools `mcp__slack__*`. Renaming it
 * renames every tool and silently voids every `tools:` grant that spells them.
 */
export const SLACK_SERVER_KEY = 'slack';

export const SLACK_TOOL_PREFIX = `mcp__${SLACK_SERVER_KEY}__`;
export const SLACK_TOOL_GLOB = `${SLACK_TOOL_PREFIX}*`;

/** The descriptor `--mcp-config` expects under {@link SLACK_SERVER_KEY}. */
export interface SlackServerSpec {
  type: 'http';
  url: string;
  oauth: { clientId: string; callbackPort: number };
}

export const slackServerSpec = (): SlackServerSpec => ({
  type: 'http',
  url: SLACK_MCP_URL,
  oauth: { clientId: SLACK_CLIENT_ID, callbackPort: SLACK_CALLBACK_PORT },
});

/** Who the token belongs to, once a probe has read it back. */
export interface SlackConnection {
  /** `@yunid`, as Slack reports it. */
  user: string;
  /** `behiques.slack.com`. */
  workspace: string;
}

/**
 * What the pane draws.
 *
 * `pending-approval` is deliberately separate from `connected`: the token is
 * real and refreshable, but every tool call fails until a workspace admin
 * approves the server, and only an actual tool call can tell the two apart.
 */
export type SlackStatus =
  | { kind: 'not-added' }
  | { kind: 'needs-auth' }
  | { kind: 'connected'; connection?: SlackConnection }
  | { kind: 'pending-approval'; connection?: SlackConnection }
  | { kind: 'error'; message: string };

/**
 * Does this `tools:` list actually reach Slack?
 *
 * `mcp:` puts the server in the process; `tools:` is the grant, and HIVE-119
 * made that a real fence. An agent naming `mcp: [slack]` with no slack tool in
 * `tools:` is almost certainly a mistake — but it is a *well-formed*
 * definition, so it is a hint in the pane rather than a parse problem.
 */
export const grantsSlackTools = (tools: readonly string[]): boolean =>
  tools.some((tool) => tool.startsWith(SLACK_TOOL_PREFIX));
