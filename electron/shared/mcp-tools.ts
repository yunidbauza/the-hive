import type { AdfBlock, JiraError, JiraToolIssue } from './jira-contract';
import type { LedgerKind, LedgerReadQuery } from './ledger-contract';
import { asInbound } from './ledger-derive';
import {
  AGENTS_TOOL,
  APPROVE_TOOL,
  JIRA_COMMENT_TOOL,
  JIRA_GET_TOOL,
  JIRA_TRANSITION_TOOL,
  LEDGER_TOOLS,
  PR_TOOL,
  PROJECTS_TOOL,
} from './ledger-tools';
import {
  LEDGER_READ_DEFAULT_LIMIT,
  ReceiverError,
  type CallToolResult,
  type McpToolDefinition,
  type ReceiverClient,
} from './mcp-contract';
import type { RpcHandlers } from './mcp-protocol';
import {
  isToolName,
  matches,
  PERMISSION_DENY_MESSAGE,
  type PermissionDecision,
} from './permission-rules';

/**
 * The nine ledger tools, as behaviour (HIVE-112, `ledger_handoff` added by
 * HIVE-122), plus the two served beside them: `agents` (HIVE-127) and
 * `approve` (HIVE-119).
 *
 * Every one of them is the same three steps: read the arguments, make one
 * receiver call, turn the outcome into a `CallToolResult`. The interesting part
 * is what happens when that call is refused — see {@link failed}.
 */

const ok = (text: string, structuredContent?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text }],
  isError: false,
  ...(structuredContent === undefined ? {} : { structuredContent }),
});

/**
 * A failure the **model** reads, not one the protocol reports.
 *
 * The MCP spec draws this line and it matters here: a JSON-RPC error tells the
 * client the call was malformed, and the model never sees the text. A result
 * with `isError` is handed to the model, which is the whole point — "thread is
 * not open: a12" is something it can act on, and a protocol error is not.
 */
const failed = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

const stringArg = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

const metaArg = (args: Record<string, unknown>): Record<string, unknown> | undefined => {
  const value = args['meta'];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

/**
 * Where the read cursor lives, so its lifetime can outlive one handler set.
 *
 * Over stdio the two are the same thing — `claude` starts one host per session
 * and keeps it — so the default store below is closure-local and nothing has to
 * think about it. Over `POST /mcp` they are not: a request is not a process, so
 * a handler set built per request would carry a cursor that is `undefined` on
 * arrival and discarded on reply, turning every undirected drain into a re-read
 * of the newest page (HIVE-130).
 *
 * The fix is to inject the *cursor* rather than to reuse the handlers, and that
 * is deliberate. Memoising a whole handler set per session would capture the
 * first request's headers in its client, and `handleMessage` awaits — so a
 * second request from the same session could interleave and be answered against
 * the first one's identity. A cursor is the only thing that should outlive the
 * request; everything else is rebuilt from the headers actually presented.
 */
export interface CursorStore {
  get(): string | undefined;
  set(id: string): void;
}

/** A store with the stdio host's lifetime: this closure, and no longer. */
export const createCursorStore = (): CursorStore => {
  /**
   * Deliberately **not** persisted: a cursor that survived a restart would mean
   * a session that came back after a crash silently skipped whatever arrived
   * while it was down.
   */
  let cursor: string | undefined;
  return {
    get: () => cursor,
    set: (id: string) => {
      cursor = id;
    },
  };
};

export function createToolHandlers(
  client: ReceiverClient,
  grants: readonly string[] = [],
  /**
   * The read cursor: the id of the last entry this caller was given.
   *
   * Defaulted, so the stdio host and every existing test get exactly the
   * per-process cursor they had before. `POST /mcp` passes one keyed by session.
   */
  cursorStore: CursorStore = createCursorStore(),
): RpcHandlers {

  /** One write, with the refusal turned into text the model can read. */
  const write = async (
    kind: LedgerKind,
    args: Record<string, unknown>,
    extra: { body?: string; meta?: Record<string, unknown> } = {},
  ): Promise<CallToolResult> => {
    const body = extra.body ?? stringArg(args, 'body');
    if (body === undefined) return failed(`${kind} needs a body`);

    const to = stringArg(args, 'to');
    const thread = stringArg(args, 'thread');
    const meta = extra.meta ?? metaArg(args);

    const { id, ref } = await client.post({
      ...(to === undefined ? {} : { to }),
      kind,
      ...(thread === undefined ? {} : { thread }),
      body,
      ...(meta === undefined ? {} : { meta }),
    });

    return ok(ref === undefined ? `posted ${id}` : `posted ${id} (ref ${ref})`);
  };

  const read = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const query: LedgerReadQuery = {};

    for (const key of ['to', 'from', 'thread'] as const) {
      const value = stringArg(args, key);
      if (value !== undefined) query[key] = value;
    }

    const kind = stringArg(args, 'kind');
    if (kind !== undefined) query.kind = kind as LedgerKind;

    const since = stringArg(args, 'since');
    const limit = typeof args['limit'] === 'number' ? args['limit'] : undefined;

    /*
      Whether this call is the undirected inbox drain the preamble mandates
      first on every wake, or a targeted lookup — and only the drain may move
      the cursor. `snapshot.entries` below is the *filtered and trimmed* set,
      not the whole log, so advancing the cursor to its last id after a
      targeted read would move the high-water mark past entries the caller
      was never shown: a `kind`-filtered read would permanently skip every
      other kind older than its newest match, a `limit`-bounded read would
      lose whatever it discarded past that limit, and a `since` older than the
      cursor could walk the cursor *backwards*, re-delivering entries already
      seen on the next default read. A call naming none of these is the plain
      drain, and behaves exactly as before.
    */
    const isTargetedLookup =
      query.to !== undefined ||
      query.from !== undefined ||
      query.kind !== undefined ||
      query.thread !== undefined ||
      since !== undefined ||
      limit !== undefined;

    /*
      An explicit `since` wins over the cursor, and the cursor wins over the
      default bound. The bound only exists for the very first read of a process:
      without it, a session opened against a months-old ledger would be handed
      all of it at once.
    */
    const cursor = cursorStore.get();
    if (since !== undefined) query.since = since;
    else if (cursor !== undefined) query.since = cursor;
    if (limit !== undefined) query.limit = limit;
    else if (query.since === undefined) query.limit = LEDGER_READ_DEFAULT_LIMIT;

    const snapshot = await client.read(query);

    /*
      Advanced only for the undirected drain, and only when something came
      back. Entries are newest-last, so the last one is the high-water mark. A
      read that returned nothing leaves the cursor where it was — moving it to
      `undefined` would re-bound the next read as if the process had just
      started.
    */
    if (!isTargetedLookup) {
      const newest = snapshot.entries.at(-1);
      if (newest !== undefined) cursorStore.set(newest.id);
    }

    /*
      Compact JSON, not a rendered digest. `meta` is an arbitrary map that
      HIVE-119 (permission asks) and HIVE-123 (Slack timestamps) both read keys
      out of, so anything lossy here breaks a story that has not been written
      yet — and a digest that kept `meta` would give back the tokens it saved.

      The same snapshot also rides along as `structuredContent`: this call is
      the one the preamble mandates first on every wake, so it is the one
      place a model would otherwise have to parse a JSON string out of a text
      field before it could do anything with it.
    */
    return ok(JSON.stringify(snapshot), { ...snapshot });
  };

  /**
   * Who else is here (HIVE-127).
   *
   * The shortest handler in this file, and the only one that reads no
   * arguments at all: the caller is the authenticated `x-hive-session` header,
   * so there is nothing on `args` to look at.
   *
   * Prose *and* `structuredContent`, like `ledger_read` above. The text is
   * what the model actually attends to, and it is the only place two things
   * can be said that the raw fields cannot: whether an ask will reach this
   * peer at all, and — for a broken definition — that it will not. Handing a
   * model a name it cannot reach is worse than handing it nothing.
   */
  const agents = async (): Promise<CallToolResult> => {
    const directory = await client.agents();

    if (directory.agents.length === 0) {
      return ok(
        'There are no other agents on this machine — you are the only one. Do the work yourself, or report that there is nobody to delegate it to.',
        { agents: [] },
      );
    }

    const lines = directory.agents.map((agent) => {
      /*
        A broken definition is not a known party, so nothing can wake it and
        nothing may write to the ledger as it. Saying only "invalid" would
        leave a caller to discover that by being ignored.
      */
      if (agent.invalid !== undefined) {
        return `- ${agent.name} — cannot be reached: its definition does not parse (${agent.invalid})`;
      }

      const reach = agent.accepts.includes('ledger')
        ? 'reachable with ledger_ask'
        : 'does not wake on the ledger, so an ask will not reach it';
      const tools = agent.tools.length === 0 ? 'no tool grants' : agent.tools.join(', ');

      return `- ${agent.name} (${agent.status}) — ${agent.description} [${reach}; ${tools}]`;
    });

    return ok(
      `${directory.agents.length} other agent(s) on this machine:\n${lines.join('\n')}`,
      /*
        A fresh literal rather than `directory` itself: `ok` takes a
        `Record<string, unknown>`, an interface has no implicit index
        signature, and the cast that would paper over that also silences any
        genuine shape error.
      */
      { agents: directory.agents },
    );
  };

  /**
   * A Jira refusal as a tool error: the kind, the sentence, and the app's own
   * diagnosis when it has one (a missing field, an ADF rule). `details` is
   * composed and bounded in `client.ts`, never a quoted server body.
   */
  const jiraFailed = (tool: string, error: JiraError): CallToolResult => {
    const notes = [
      ...(error.details ?? []),
      ...(error.retryAfter === undefined ? [] : [`retry after ${error.retryAfter}s`]),
    ];
    return failed(
      `${tool}: ${error.message} (${error.kind})${notes.length === 0 ? '' : `; ${notes.join('; ')}`}`,
    );
  };

  /** The ticket, rendered for a model (HIVE-174): prose first, the record beside it. */
  const jiraGet = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const key = stringArg(args, 'key');
    if (key === undefined) return failed('jira_get needs key');

    const result = await client.jiraGet({ key });
    if (!result.ok) return jiraFailed('jira_get', result.error);

    return ok(jiraIssueText(result.value), { ...result.value });
  };

  const jiraTransition = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const key = stringArg(args, 'key');
    const status = stringArg(args, 'status');
    const from = stringArg(args, 'from');
    if (key === undefined || status === undefined) {
      return failed('jira_transition needs key and status');
    }

    const result = await client.jiraTransition({
      key,
      status,
      ...(from === undefined ? {} : { from }),
    });
    if (!result.ok) return jiraFailed('jira_transition', result.error);

    const { issue, transition, skipped } = result.value;
    return ok(
      transition === null
        ? `${issue.key}: ${skipped ?? 'nothing was changed'}.`
        : `${issue.key} is now ${issue.status} (transition "${transition.name}").`,
      { issue, transition, ...(skipped === undefined ? {} : { skipped }) },
    );
  };

  const jiraComment = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const key = stringArg(args, 'key');
    const markdown = stringArg(args, 'markdown');
    if (key === undefined || markdown === undefined) {
      return failed('jira_comment needs key and markdown');
    }

    const result = await client.jiraComment({ key, markdown });
    if (!result.ok) return jiraFailed('jira_comment', result.error);

    const comment = result.value;
    return ok(`Commented on ${key}: comment ${comment.id} by ${comment.author} at ${comment.created}.`, {
      comment,
    });
  };

  /** The projects directory (HIVE-173), prose and structured, like `agents`. */
  const projects = async (): Promise<CallToolResult> => {
    const directory = await client.projects();

    if (directory.projects.length === 0) {
      return ok(
        'No projects are configured in The Hive. Ask for an absolute checkout path instead of a project name.',
        { projects: [] },
      );
    }

    const lines = directory.projects.map((project) => {
      const where = project.path === null ? `not on this machine (${project.status})` : project.path;
      const notes = [
        `${project.status}, ${project.origin}`,
        project.autoMerge ? 'auto-merge on' : 'auto-merge off',
        ...(project.container === undefined
          ? []
          : [`in a container, checkout mounted at ${project.container.workspace}`]),
      ];
      return `- ${project.id} (key ${project.key}, "${project.name}") — ${where} [${notes.join('; ')}]`;
    });

    return ok(`${directory.projects.length} project(s) configured:\n${lines.join('\n')}`, {
      projects: directory.projects,
    });
  };

  /** One PR record (HIVE-173). A missing record is an answer, not an error. */
  const pr = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const repo = stringArg(args, 'repo');
    const number = args['number'];
    if (
      repo === undefined ||
      typeof number !== 'number' ||
      !Number.isInteger(number) ||
      number < 1
    ) {
      return failed('pr needs repo (owner/name) and number (a positive integer)');
    }

    const reply = await client.pr({ repo, number });
    if (reply.pr === null) {
      const reason = reply.reason ?? 'not in the sweep';
      return ok(
        `No record of ${repo}#${number}: ${reason}. The sweep lists PRs you authored, open or merged in the last day, on configured projects only.`,
        { pr: null, reason },
      );
    }

    const record = reply.pr;
    return ok(
      `${repo}#${number} "${record.title}" — ${record.state}; ${record.findings} unresolved review thread(s); checks ${record.checks}; branch ${record.branch}; updated ${record.updatedAt}; ${record.url}`,
      { pr: record },
    );
  };

  const claim = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const task = stringArg(args, 'task');
    if (task === undefined) return failed('ledger_claim needs a task');

    /*
      Read first, so the answer can name a holder. The store deliberately does
      not guard `claim` — a second claim is a fact worth recording, and the
      caller does hold the task afterwards — so this reports rather than
      refuses, and says plainly what changed.

      `limit: 0` asks for zero entries in the reply. The receiver strips
      `limit` out of the query before it ever reaches `Ledger.read`
      (`electron/main/hooks/receiver.ts`'s `handleLedgerRead`), so `claims` —
      always derived from the whole log inside `Ledger.read`, per
      `electron/main/ledger/index.ts` — is unaffected either way; what the
      receiver does with the limit is trim the *visible* entries down to it
      after filtering, right before shipping the reply back over the socket.
      Asking for zero means the full claims map still comes back and no entry
      does.

      This read is purely informational — it names a *previous* holder in the
      reply, it does not authorize the claim below. A transient failure here
      must not sink a claim the `post` would otherwise have made, so it
      degrades to an unnamed claim instead of failing the whole call; `post`
      still surfaces its own failures normally.
    */
    let before: string | undefined;
    try {
      before = (await client.read({ limit: 0 })).claims[task];
    } catch {
      before = undefined;
    }

    await client.post({ kind: 'claim', body: `claimed ${task}`, meta: { task } });

    return ok(
      before === undefined
        ? `claimed ${task}`
        : `claimed ${task}, which ${before} was holding. You hold it now — release it if that was not what you meant.`,
    );
  };

  const release = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const task = stringArg(args, 'task');
    if (task === undefined) return failed('ledger_release needs a task');

    await client.post({ kind: 'release', body: `released ${task}`, meta: { task } });
    return ok(`released ${task}`);
  };

  const ask = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const options = args['options'];
    const quote = args['quote'];
    /*
      Validated as it is written, not merely as it is read, so a half-filled
      message is dropped at the door rather than drawn with a blank where the
      author goes.

      `inbound` is taken out of the `meta` passthrough first, and that order
      is the whole point. `metaArg` is spread ahead of the named arguments, so
      a caller writing `meta: { inbound: <anything> }` slipped its own shape
      past this line untouched — the conditional spread below only overwrites
      when `args.inbound` was *also* present. The card revalidates and so the
      damage was nil, but a guarantee that holds only because somebody
      downstream repeats the work is not the guarantee this comment claimed.
    */
    const { inbound: _passthrough, ...rest } = metaArg(args) ?? {};
    const inbound = asInbound(args['inbound']);
    const meta = {
      ...rest,
      ...(Array.isArray(options) ? { options } : {}),
      ...(typeof quote === 'string' ? { quote } : {}),
      ...(inbound === undefined ? {} : { inbound }),
    };

    const body = stringArg(args, 'body');
    if (body === undefined) return failed('ask needs a body');
    const to = stringArg(args, 'to');
    if (to === undefined) return failed('ask needs a party to ask');

    const { id, ref } = await client.post({
      to,
      kind: 'ask',
      body,
      ...(Object.keys(meta).length === 0 ? {} : { meta }),
    });

    return ok(
      `asked ${to}: ${ref ?? id}. Now end your turn and wait — you will be woken with the answer.`,
      // The same id/ref, as data — HIVE-119 and HIVE-120 both need to answer
      // this thread later, and today that means extracting the ref out of a
      // sentence rather than reading a field.
      { id, ...(ref === undefined ? {} : { ref }) },
    );
  };

  /**
   * The permission fence (HIVE-119).
   *
   * Three rules this cannot break, all of them measured against the real CLI:
   * the decision travels as JSON **text only** — a `structuredContent` twin
   * makes the CLI reject the result; the answer is always a decision, never an
   * `isError`, because the CLI cannot act on an error; and anything not
   * matched is asked, so an empty grant list fences everything rather than
   * nothing.
   */
  const decision = (result: PermissionDecision): CallToolResult => ({
    content: [{ type: 'text', text: JSON.stringify(result) }],
    // Never `true`: a `deny` here is a business decision the model reads out
    // of the JSON text, not a protocol failure — see `CallToolResult`'s
    // `isError` doc. `structuredContent` is never set either, deliberately
    // absent rather than merely unset: the real CLI was observed rejecting a
    // permission-prompt-tool result that carried one alongside the text.
    isError: false,
  });

  const approve = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const tool = stringArg(args, 'tool_name');
    if (tool === undefined) {
      return decision({ behavior: 'deny', message: 'approve needs a tool_name.' });
    }

    const raw = args['input'];
    const input =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};

    if (grants.some((rule) => matches(rule, tool, input))) {
      return decision({ behavior: 'allow', updatedInput: input });
    }

    /*
      Never post an ask that cannot be described. `Ledger.append` downgrades a
      permission ask whose `tool` is not a tool name to an ordinary one, and
      this tool's body is empty, so the result would be a card that says
      nothing — a control with no question above it.

      **Below the grants check, not above it.** A grant is a decision the user
      already made, and `matches` compares the name literally, so a rule can
      name a tool this predicate rejects. Above the check this denied calls
      the fence was configured to allow — and it is not hypothetical: MCP tool
      names carry hyphens, which `isToolName` did not admit until this story
      widened it. Ordering it this way means a name the predicate cannot
      describe can still be *granted*, and only the road that needs to render
      a card requires a describable name.

      `PERMISSION_DENY_MESSAGE` rather than a bespoke line, because that text
      is what tells the model to end its turn instead of retrying; a terse
      status here reads as a transient error and invites a loop.
    */
    if (!isToolName(tool)) {
      return decision({ behavior: 'deny', message: PERMISSION_DENY_MESSAGE });
    }

    try {
      await client.post({
        to: 'overmind',
        kind: 'ask',
        /*
          Empty on purpose. `Ledger.append` composes the body from `meta.tool`
          and `meta.input` (HIVE-125), so composing one here would be a second
          copy of the same computation — and the copy that does *not* govern,
          since an agent posting through `ledger_ask` never reaches this code.
          The ladder, the default and the options arrive the same way.
        */
        body: '',
        meta: { kind: 'permission', tool, input },
      });
    } catch (cause) {
      /*
        The ask could not be written, so nobody will ever answer it. Deny
        anyway and say why: allowing here would turn an unreachable app into
        an open fence, which is the one failure this design does not accept.
      */
      return decision({
        behavior: 'deny',
        message: `Could not ask for permission: ${
          cause instanceof ReceiverError ? cause.message : String(cause)
        }. Nothing was written. End your turn.`,
      });
    }

    return decision({ behavior: 'deny', message: PERMISSION_DENY_MESSAGE });
  };

  return {
    // `approve` stays last: the tools a model is meant to call come first, and
    // that one is only ever reached by the CLI on its behalf.
    listTools: (): readonly McpToolDefinition[] => [
      ...LEDGER_TOOLS,
      AGENTS_TOOL,
      PROJECTS_TOOL,
      PR_TOOL,
      JIRA_GET_TOOL,
      JIRA_TRANSITION_TOOL,
      JIRA_COMMENT_TOOL,
      APPROVE_TOOL,
    ],

    async callTool(name, args): Promise<CallToolResult> {
      // `approve` must never surface as `isError` or throw — the CLI can only
      // act on a decision, so its own try/catch stays out of the shared one
      // below, which produces `isError` results that are not decisions.
      if (name === 'approve') {
        try {
          return await approve(args);
        } catch (cause) {
          return decision({
            behavior: 'deny',
            message: `approve failed: ${String(cause)}. Nothing was written. End your turn.`,
          });
        }
      }

      try {
        switch (name) {
          case 'agents':
            return await agents();
          case 'projects':
            return await projects();
          case 'pr':
            return await pr(args);
          case 'jira_get':
            return await jiraGet(args);
          case 'jira_transition':
            return await jiraTransition(args);
          case 'jira_comment':
            return await jiraComment(args);
          case 'ledger_read':
            return await read(args);
          case 'ledger_post':
            return await write('post', args);
          case 'ledger_ask':
            return await ask(args);
          case 'ledger_answer':
            return stringArg(args, 'thread') === undefined
              ? failed('ledger_answer needs the thread it answers')
              : await write('answer', args);
          case 'ledger_claim':
            return await claim(args);
          case 'ledger_release':
            return await release(args);
          case 'ledger_done':
            return await write('done', args);
          case 'ledger_failed':
            return await write('failed', args);
          case 'ledger_handoff':
            return await write('handoff', args);
          default:
            return failed(`no such tool: ${name}`);
        }
      } catch (cause) {
        /*
          Every receiver refusal lands here and becomes readable text. Anything
          else that threw is a bug in this file, and the model still gets a
          sentence rather than a dead turn.
        */
        return failed(
          cause instanceof ReceiverError ? cause.message : `the tool failed: ${String(cause)}`,
        );
      }
    },
  };
}

/** The longest `jira_get` text a model is handed; the record beside it is whole. */
export const JIRA_TEXT_MAX = 24_000;

/**
 * ADF blocks as the plain text a model reads (HIVE-174). Marks are dropped,
 * structure is kept in the markdown-ish shape a model already knows.
 */
export function adfBlocksToText(blocks: readonly AdfBlock[]): string {
  return blocks
    .map((block) => {
      const text = block.runs.map((run) => run.text).join('');
      const indent = '  '.repeat(block.depth ?? 0);
      switch (block.kind) {
        case 'heading':
          return `${'#'.repeat(Math.min(6, Math.max(1, block.level ?? 1)))} ${text}`;
        case 'code':
          return `\`\`\`${block.language ?? ''}\n${text}\n\`\`\``;
        case 'quote':
          return `> ${text}`;
        case 'bullet':
          return `${indent}- ${text}`;
        case 'ordered':
          return `${indent}1. ${text}`;
        case 'rule':
          return '---';
        default:
          return text;
      }
    })
    .join('\n');
}

/** One ticket as prose (HIVE-174), bounded by {@link JIRA_TEXT_MAX}. */
export function jiraIssueText(value: JiraToolIssue): string {
  const { issue, detail, comments, links, partial } = value;
  const lines = [
    `${issue.key} "${issue.summary}"`,
    `status: ${issue.status} (${issue.statusCategory}); type: ${issue.issueType}; priority: ${issue.priority ?? 'none'}; assignee: ${issue.assignee ?? 'unassigned'}; updated: ${issue.updated}`,
    issue.url,
  ];
  if (detail?.parent) lines.push(`parent: ${detail.parent.key} "${detail.parent.summary}"`);
  lines.push('', '## Description', detail === null ? '(not read)' : adfBlocksToText(detail.description) || '(none)');
  lines.push('', `## Comments (${comments.length})`);
  for (const comment of comments) {
    lines.push(`- ${comment.author}, ${comment.created}:`, adfBlocksToText(comment.body).replace(/^/gm, '  '));
  }
  lines.push('', `## Links (${links.length})`);
  for (const link of links) {
    const notes = [link.relationship, link.status].filter((note) => note !== undefined).join('; ');
    lines.push(`- [${link.kind}] ${link.title}${notes === '' ? '' : ` (${notes})`} ${link.url}`);
  }
  if (partial.length > 0) lines.push('', `Could not be read: ${partial.join('; ')}.`);

  const text = lines.join('\n');
  return text.length <= JIRA_TEXT_MAX
    ? text
    : `${text.slice(0, JIRA_TEXT_MAX)}\n… (${text.length - JIRA_TEXT_MAX} more characters; the record beside this text is whole)`;
}
