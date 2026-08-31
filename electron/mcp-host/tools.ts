import type { LedgerKind, LedgerReadQuery } from '@shared/ledger-contract';
import { APPROVE_TOOL, LEDGER_TOOLS } from '@shared/ledger-tools';
import {
  LEDGER_READ_DEFAULT_LIMIT,
  type CallToolResult,
  type McpToolDefinition,
} from '@shared/mcp-contract';
import {
  defaultRungFor,
  matches,
  PERMISSION_DENY_MESSAGE,
  rungsFor,
  summarise,
  type PermissionDecision,
} from '@shared/permission-rules';

import { ReceiverError, type ReceiverClient } from './client';
import type { RpcHandlers } from './rpc';

/**
 * The eight tools, as behaviour (HIVE-112).
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

export function createToolHandlers(
  client: ReceiverClient,
  grants: readonly string[] = [],
): RpcHandlers {
  /**
   * The read cursor: the id of the last entry this process was given.
   *
   * Per process, which is per session — `claude` starts one host per session
   * and keeps it for that session's life. It is deliberately **not** persisted:
   * a cursor that survived a restart would mean a session that came back after
   * a crash silently skipped whatever arrived while it was down.
   */
  let cursor: string | undefined;

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
      if (newest !== undefined) cursor = newest.id;
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
    const meta = {
      ...metaArg(args),
      ...(Array.isArray(options) ? { options } : {}),
      ...(typeof quote === 'string' ? { quote } : {}),
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

  /**
   * `meta.input` as it goes into the log, which is not the same thing as the
   * input the call runs with.
   *
   * The ledger is append-only JSONL that never rotates, and `store.all()`
   * holds every entry in memory; only `body` is capped. So a single denied
   * `Write` used to park the whole file — up to 64 KiB — in the log
   * permanently, and a busy agent parks one per denial.
   *
   * Nothing needs those fields. The card does not render them, `summarise`
   * does not read them, and both the ladder and the one-shot rule are
   * computed from the tool name and the specifier text alone
   * (`@shared/permission-rules`). The `updatedInput` on an *allow* is a
   * different value and is never trimmed — that one is what the model
   * actually runs.
   *
   * Replaced by a marker rather than deleted, so a reader of the log sees
   * that something was there and how big it was, instead of an input that
   * looks like it never had a body.
   */
  const BULK_FIELDS = ['content', 'new_string', 'old_string'];

  const forTheLedger = (input: Record<string, unknown>): Record<string, unknown> => {
    const trimmed: Record<string, unknown> = { ...input };

    for (const field of BULK_FIELDS) {
      const value = trimmed[field];
      if (typeof value === 'string') {
        trimmed[field] = `[omitted from the ledger: ${value.length} chars]`;
      }
    }

    return trimmed;
  };

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

    const rungs = rungsFor(tool, input);

    try {
      await client.post({
        to: 'overmind',
        kind: 'ask',
        body: `Allow ${tool}?\n${summarise(tool, input)}`,
        meta: {
          kind: 'permission',
          tool,
          input: forTheLedger(input),
          rungs,
          options: [...rungs.map((rung) => rung.id), 'deny'],
          default: defaultRungFor(rungs),
        },
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
    listTools: (): readonly McpToolDefinition[] => [...LEDGER_TOOLS, APPROVE_TOOL],

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
