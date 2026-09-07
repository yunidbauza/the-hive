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

/**
 * The whole `--mcp-config` payload for a run that must see Slack and nothing
 * else — the Test probe's server set (HIVE-123).
 *
 * A JSON **string**, not a path: `--mcp-config <configs...>` is documented and
 * measured as "Load MCP servers from JSON files or strings", so the probe needs
 * no temp file, no directory to create and nothing to clean up. Measured
 * against `claude` 2.1.252: passed with `--strict-mcp-config`, the run's
 * `system`/`init` event reports `mcp_servers: [{ name: 'slack', status: … }]`.
 *
 * Load-bearing, not decoration. `--strict-mcp-config` makes the named set the
 * *entire* set of servers a run can see, so passing it **without** this leaves
 * the set empty: no `slack` entry ever reaches the init event and the probe
 * fails unconditionally, on a connection that is perfectly healthy.
 */
export const slackOnlyMcpConfig = (): string =>
  JSON.stringify({ mcpServers: { [SLACK_SERVER_KEY]: slackServerSpec() } });

/**
 * What the pane draws.
 *
 * `pending-approval` is deliberately separate from `connected`: the token is
 * real and refreshable, but every tool call fails until a workspace admin
 * approves the server, and only an actual tool call can tell the two apart.
 *
 * ## Why there is no identity here
 *
 * An earlier draft carried a `connection: { user, workspace }` rider so the
 * pane could say *as whom* you are signed in. Nothing could honestly produce
 * it. `claude mcp get` reports a status and a URL and no identity at all, and
 * the only other instrument is the probe — whose answer is a **model
 * paraphrase**, which this story already ruled out as an instrument once
 * (scanning the raw stream rather than trusting `result.result`). Parsing a
 * username out of a sentence the model chose the words for would reintroduce
 * exactly that mistake, in the one place where being wrong means naming the
 * wrong human.
 *
 * So the field is gone rather than left unpopulated: a rendered-but-unreachable
 * identity slot is worse than an absent one. A later story that reads identity
 * from a structured tool result can add it back with a real producer.
 */
export type SlackStatus =
  | { kind: 'not-added' }
  | { kind: 'needs-auth' }
  | { kind: 'connected' }
  | { kind: 'pending-approval' }
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

/* ---------------------------------------------------------------- HIVE-124 */

/**
 * The trigger name a Socket Mode wake reports (HIVE-124).
 *
 * Ranked between `manual` and `ledger` in `scheduler.ts`'s `triggerFor`: a
 * person pressing Run still wins, and `ledger` would name a route the entry
 * never took — there is no log line for `ledger_read` to find.
 */
export const SLACK_TRIGGER = 'slack';

/** A message in a channel an agent named with `slack.channel:#x`. */
export const SLACK_CHANNEL_KIND = 'slack.channel';
/** An `@hive` mention with no agent name in it — a wake, not an instruction. */
export const SLACK_MENTION_KIND = 'slack.app_mention';
/** An `@hive <agent> <task>` from an allow-listed author — a task run. */
export const SLACK_COMMAND_KIND = 'slack.command';

/** A burst inside this window becomes one wake. */
export const SLACK_EVENT_DEBOUNCE_MS = 3_000;

/**
 * The floor between two event wakes of the same agent.
 *
 * Push replaces a 5-minute tick, so without this a chatty channel spends a
 * day's model budget before lunch. Bounds the worst case at 1440 runs a day;
 * the agent's own `limits` remain the real backstop. A `@hive` command bypasses
 * it — see `bridge.ts`.
 */
export const SLACK_EVENT_MIN_GAP_MS = 60_000;

/** How much of a Slack message reaches the wake prompt. */
export const SLACK_EVENT_TEXT_MAX = 300;

/**
 * How many `(channel, ts, agent)` keys the dedupe cache holds.
 *
 * An `app_mention` also arrives as a `message` in the same channel, and one
 * Slack message must never wake **the same agent** twice. The agent is part of
 * the key rather than absent from it: a global `(channel, ts)` would let the
 * mention's delivery to its own subscriber consume the key and drop the channel
 * watcher's copy, so an agent watching that channel would silently stop seeing
 * every message that mentioned the app.
 *
 * The cost of that correctness is here: N agents watching one channel spend N
 * keys per message against this ceiling, so the window this bounds is "the last
 * 500 deliveries", not "the last 500 messages".
 */
export const SLACK_EVENT_DEDUPE_MAX = 500;

/** The encrypted file under `userData`, beside Jira's `jira-credential.bin`. */
export const SLACK_TOKENS_FILE = 'slack-tokens.bin';

/** One Slack message, as this app reads it. */
export interface SlackEvent {
  kind: typeof SLACK_CHANNEL_KIND | typeof SLACK_MENTION_KIND;
  /** The channel **id**, e.g. `C0123ABCD`. Slack events never carry the name. */
  channel: string;
  ts: string;
  /** The parent thread, or `ts` itself for a top-level message. */
  threadTs: string;
  user: string;
  text: string;
}

/** What the pane is told about the socket. Never carries a token. */
export type SlackSocketStatus =
  | { kind: 'off' }
  | { kind: 'connecting' }
  | {
      kind: 'connected';
      workspace: string | null;
      bot: string | null;
      /**
       * Channel names from `wake.on` that resolved to no Slack channel id.
       *
       * Carried on the status push rather than fetched by a verb of its own:
       * the pane has to report an unresolved name in its Wakes-on summary
       * ("never dropped in silence"), the resolution happens in the main
       * process, and this is the message the pane already receives.
       */
      unresolved: string[];
    }
  | { kind: 'failed'; message: string };

/** Presence, never values. This is what crosses IPC. */
export interface SlackTokensState {
  hasAppToken: boolean;
  hasBotToken: boolean;
  encryptionAvailable: boolean;
}

/** What `Test` answers with. */
export type SlackSocketTestResult =
  | { kind: 'ok'; workspace: string; bot: string }
  | { kind: 'error'; message: string };
