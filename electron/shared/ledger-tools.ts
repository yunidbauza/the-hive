/**
 * The nine ledger tools, as data (HIVE-112, `ledger_handoff` added by HIVE-122),
 * plus the two served beside them and deliberately outside that list:
 * {@link AGENTS_TOOL} (HIVE-127) and {@link APPROVE_TOOL} (HIVE-119).
 *
 * In `electron/shared` rather than beside the server that serves them, for one
 * reason: HIVE-115's agent preamble is the same text read by a different
 * audience, and a preamble that restated these descriptions would drift from
 * them the first time one was edited. The MCP host is fenced to `@shared`, so
 * this is also the only place both can reach.
 *
 * The descriptions are written **for a model**, not for a changelog: each says
 * when to reach for the tool, not merely what it does.
 */

import type { McpToolDefinition } from './mcp-contract';

const party = {
  type: 'string',
  description: 'A party id: a session id, an agent name, or "overmind".',
} as const;

const body = {
  type: 'string',
  description: 'Markdown. What you want the other party to read.',
} as const;

/**
 * Free-form, with one key the app actually reads.
 *
 * `slack.permalink` is named here because naming it is the only thing that
 * makes it happen (HIVE-123): `ledger/notify.ts` turns that exact path into the
 * card's "Open in Slack" link, and an agent told merely to "include the
 * permalink" writes it into the body, where nothing can find it. A described
 * key is the whole producer for that feature — the schema is the only place the
 * model is told the shape.
 */
const meta = {
  type: 'object',
  description:
    'Optional structured detail carried with the entry — a ticket key, a PR number, a Slack timestamp. Free-form, with one key The Hive reads: if you posted a message in Slack, put its permalink at `slack.permalink` — `{"slack": {"permalink": "https://…slack.com/archives/…"}}` — and the card gets an "Open in Slack" link straight to it. Naming it in your body text instead does nothing.',
} as const;

export const LEDGER_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'ledger_read',
    description:
      'Read your ledger inbox. Call this FIRST on any wake, before doing anything else — it is how you learn what was asked of you and what changed while you were away. With no arguments it returns what is addressed to you plus broadcasts, newest last, and only what is new since your last read.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { ...party, description: 'Only entries addressed to this party.' },
        from: { ...party, description: 'Only entries written by this party.' },
        kind: {
          type: 'string',
          description:
            'Only entries of this kind: post, ask, answer, claim, release, done, failed, event, handoff.',
        },
        thread: {
          type: 'string',
          description: 'Only entries in this thread — an ask id or its short ref.',
        },
        since: {
          type: 'string',
          description:
            'Only entries after this entry id. Overrides your saved cursor.',
        },
        limit: {
          type: 'number',
          description: 'At most this many entries, newest kept.',
        },
      },
      required: [],
    },
  },
  {
    name: 'ledger_post',
    description:
      'Leave a note on the ledger. Use it to tell other parties what you did or what you found. It wakes nobody — if you need an answer, use ledger_ask instead. Omit "to" to broadcast to everyone.',
    inputSchema: {
      type: 'object',
      properties: {
        to: party,
        body,
        thread: {
          type: 'string',
          description: 'The ask this continues, if it continues one.',
        },
        meta,
      },
      required: ['body'],
    },
  },
  {
    name: 'ledger_ask',
    description:
      'Ask another party a question and open a thread for the answer. Use it before any outward or irreversible action you were not explicitly told to take. Returns the ask id and a short ref. This ENDS YOUR TURN: stop after calling it and wait to be woken with the answer — do not poll for a reply.',
    inputSchema: {
      type: 'object',
      properties: {
        to: party,
        body,
        options: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The answers you will accept, if the question is closed. Offered to the human as buttons.',
        },
        quote: {
          type: 'string',
          description:
            'A draft you want approved before you act on it — the text of the message you would send. The overmind sees it quoted above the buttons and can edit it before approving.',
        },
        meta,
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'ledger_answer',
    description:
      'Answer an ask someone made of you, closing its thread. "thread" takes either the ask id or its short ref (for example "a12"). Refused if the thread is already closed or was never open.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: {
          type: 'string',
          description: 'The ask id, or its short ref such as "a12".',
        },
        body,
        meta,
      },
      required: ['thread', 'body'],
    },
  },
  {
    name: 'ledger_claim',
    description:
      'Claim a piece of work so other parties know you have it. Advisory, not a lock: if someone else already holds it you are told who, and your claim is still recorded — decide for yourself whether to continue or hand it back with ledger_release.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'What you are claiming — a ticket key, a file, a job name.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'ledger_release',
    description:
      'Give up a claim you hold, so someone else can take the work. Refused if you are not the current holder.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task you are releasing.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'ledger_done',
    description:
      'Report that you finished what you were woken to do. Post exactly one of these per wake that did something, and none at all when you found nothing to do.',
    inputSchema: {
      type: 'object',
      properties: {
        body,
        thread: {
          type: 'string',
          description: 'The ask this completes, if it completes one.',
        },
        meta,
      },
      required: ['body'],
    },
  },
  {
    name: 'ledger_failed',
    description:
      'Report that you could not finish, and why. Use it when you are blocked, denied, or out of options — a failure someone can read beats a turn that ends silently.',
    inputSchema: {
      type: 'object',
      properties: {
        body,
        thread: {
          type: 'string',
          description: 'The ask this abandons, if it abandons one.',
        },
        meta,
      },
      required: ['body'],
    },
  },
  {
    name: 'ledger_handoff',
    description:
      'Leave a handoff for the fresh copy of yourself that continues after this session ends. Write it when you are told this is your last turn: what you watch, which threads are open and their ids, the decisions and preferences you have learned, and anything a fresh copy of you must know to pick up where you left off. Your next session opens with it.',
    inputSchema: {
      type: 'object',
      properties: {
        body,
        meta,
      },
      required: ['body'],
    },
  },
];

/** The tool names, in the order `tools/list` reports them. */
export const LEDGER_TOOL_NAMES: readonly string[] = LEDGER_TOOLS.map(
  (tool) => tool.name,
);

/**
 * Claude Code's permission handler — served beside the ledger tools, and not
 * one of them (HIVE-119).
 *
 * Deliberately outside {@link LEDGER_TOOLS}: that list is the ledger vocabulary
 * the agent preamble teaches, and this is a tool the model is never supposed to
 * call. The CLI reaches it by name through `--permission-prompt-tool`.
 */
export const APPROVE_TOOL: McpToolDefinition = {
  name: 'approve',
  description:
    "Claude Code's permission handler. You do not call this — the CLI does, on your behalf, when you reach for a tool your definition does not grant. It asks the overmind and denies the call, so a denial here means wait for an answer, not try another way.",
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: {
        type: 'string',
        description: 'The tool the model is asking to use.',
      },
      input: {
        type: 'object',
        description: "That tool's arguments, as the model supplied them.",
      },
      tool_use_id: {
        type: 'string',
        description: 'The id of the tool use being decided.',
      },
    },
    required: ['tool_name', 'input'],
  },
};

/**
 * The agents directory — served beside the ledger tools, and not one of them
 * (HIVE-127).
 *
 * Outside {@link LEDGER_TOOLS} for the reason {@link APPROVE_TOOL} is: that
 * list is the ledger vocabulary the agent preamble teaches, one entry per
 * ledger kind, and this writes no entry. Unlike `approve`, though, it *is* a
 * tool the model is meant to call, so `tools/list` reports it before that one.
 *
 * It takes no arguments on purpose. The caller's identity is the authenticated
 * `x-hive-session` header — which for an agent wake is that agent's own name —
 * so there is nothing to pass. A parameter naming who is asking is a parameter
 * a model can lie in.
 */
export const AGENTS_TOOL: McpToolDefinition = {
  name: 'agents',
  description:
    'List the other agents on this machine and what each is for. Use it before asking someone to do work you are not for: it gives you each peer\'s name, its own description of itself, whether it is awake, what it wakes on, and what tools it holds — so you can address a `ledger_ask` to a peer you were never told about. A peer whose "accepts" does not include "ledger" will not wake on an ask, and one listed with "invalid" cannot be reached at all.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};
