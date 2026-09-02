import { describe, expect, it, vi } from 'vitest';

import type { LedgerSnapshot } from '@shared/ledger-contract';

import { ReceiverError, type ReceiverClient } from '../../../electron/mcp-host/client';
import { createToolHandlers } from '../../../electron/mcp-host/tools';

const emptySnapshot: LedgerSnapshot = { entries: [], openAsks: [], claims: {} };

const stub = (overrides: Partial<ReceiverClient> = {}): ReceiverClient => ({
  read: vi.fn(async () => emptySnapshot),
  post: vi.fn(async () => ({ id: 'id-1', ref: 'a1' })),
  // An empty directory rather than a refusal (HIVE-127): most tests here never
  // touch it, and "nobody else is here" is its honest resting state.
  agents: vi.fn(async () => ({ agents: [] })),
  ...overrides,
});

const textOf = (result: { content: { text: string }[] }): string =>
  result.content.map((part) => part.text).join('');

describe('createToolHandlers — listing', () => {
  /*
    Order is asserted, not just membership: the nine ledger tools first, then
    `agents` (HIVE-127), then `approve` last — the tools a model is meant to
    call ahead of the one only the CLI ever reaches, on its behalf.
  */
  it('lists the eleven shared definitions unchanged', () => {
    const handlers = createToolHandlers(stub());
    expect(handlers.listTools().map((tool) => tool.name)).toEqual([
      'ledger_read',
      'ledger_post',
      'ledger_ask',
      'ledger_answer',
      'ledger_claim',
      'ledger_release',
      'ledger_done',
      'ledger_failed',
      'ledger_handoff',
      'agents',
      'approve',
    ]);
  });

  it('reports an unknown tool as an error result, not a throw', async () => {
    const handlers = createToolHandlers(stub());
    const result = await handlers.callTool('ledger_nope', {});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/ledger_nope/);
  });
});

describe('ledger_read', () => {
  it('bounds a first read and returns compact JSON', async () => {
    const client = stub();
    const handlers = createToolHandlers(client);

    const result = await handlers.callTool('ledger_read', {});

    expect(client.read).toHaveBeenCalledWith({ limit: 50 });
    expect(result.isError).toBe(false);
    // Compact: no indentation, so no newline between keys.
    expect(textOf(result)).toBe(JSON.stringify(emptySnapshot));
  });

  /**
   * `structuredContent` carries the same snapshot as the text block, so the
   * model reading the first call the preamble mandates on every wake does not
   * have to parse a JSON string out of a text field to get at it. The text
   * stays exactly as it was — the MCP spec's backward-compatibility guidance
   * is that a structured result should *also* serialise into text, and this
   * still needs to work for a client that reads only `content`.
   */
  it('carries the snapshot as structuredContent, alongside the unchanged text', async () => {
    const snapshot: LedgerSnapshot = {
      entries: [{ id: 'e1', ts: 1, from: 'overmind', kind: 'post', body: 'one' }],
      openAsks: [],
      claims: { 'HIVE-9': 'sess-a' },
    };
    const client = stub({ read: vi.fn(async () => snapshot) });
    const handlers = createToolHandlers(client);

    const result = await handlers.callTool('ledger_read', {});

    expect(result.structuredContent).toEqual(snapshot);
    expect(textOf(result)).toBe(JSON.stringify(snapshot));
  });

  it('advances a cursor so the next read returns only what is new', async () => {
    const snapshot: LedgerSnapshot = {
      entries: [
        { id: 'e1', ts: 1, from: 'overmind', kind: 'post', body: 'one' },
        { id: 'e2', ts: 2, from: 'overmind', kind: 'post', body: 'two' },
      ],
      openAsks: [],
      claims: {},
    };
    const client = stub({ read: vi.fn(async () => snapshot) });
    const handlers = createToolHandlers(client);

    await handlers.callTool('ledger_read', {});
    await handlers.callTool('ledger_read', {});

    // Entries are newest-last, so the cursor is the last one returned.
    expect(client.read).toHaveBeenLastCalledWith({ since: 'e2' });
  });

  it('leaves the cursor alone when a read returned nothing', async () => {
    const client = stub();
    const handlers = createToolHandlers(client);

    await handlers.callTool('ledger_read', {});
    await handlers.callTool('ledger_read', {});

    expect(client.read).toHaveBeenLastCalledWith({ limit: 50 });
  });

  it('lets an explicit since override the cursor', async () => {
    const client = stub();
    const handlers = createToolHandlers(client);

    await handlers.callTool('ledger_read', { since: 'e9', limit: 3 });

    expect(client.read).toHaveBeenCalledWith({ since: 'e9', limit: 3 });
  });

  it('passes the filters through', async () => {
    const client = stub();
    const handlers = createToolHandlers(client);

    await handlers.callTool('ledger_read', { to: 'me', from: 'you', kind: 'ask', thread: 'a1' });

    expect(client.read).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'me', from: 'you', kind: 'ask', thread: 'a1' }),
    );
  });

  /**
   * The cursor only advances on the undirected inbox drain (HIVE-112
   * self-review).
   *
   * `snapshot.entries` is the *filtered and trimmed* set, not the whole log —
   * so moving the cursor to its last id after a targeted read moves the
   * high-water mark past entries the caller was never shown. A `kind`-filtered
   * read used to permanently skip every other kind older than its newest
   * match; these prove a call naming any filter leaves the cursor alone.
   */
  describe('the cursor moves only for the undirected drain', () => {
    it('does not move the cursor for a read filtered by kind', async () => {
      const snapshot: LedgerSnapshot = {
        entries: [{ id: 'e5', ts: 5, from: 'sess-a', kind: 'ask', body: 'ship?' }],
        openAsks: [],
        claims: {},
      };
      const client = stub({ read: vi.fn(async () => snapshot) });
      const handlers = createToolHandlers(client);

      await handlers.callTool('ledger_read', { kind: 'ask' });
      await handlers.callTool('ledger_read', {});

      // The default drain still falls back to the first-read bound, not
      // `since: e5` — the kind-filtered call never touched the cursor.
      expect(client.read).toHaveBeenLastCalledWith({ limit: 50 });
    });

    it('does not move the cursor for an explicit-limit read', async () => {
      const snapshot: LedgerSnapshot = {
        entries: [
          { id: 'e1', ts: 1, from: 'overmind', kind: 'post', body: 'one' },
          { id: 'e2', ts: 2, from: 'overmind', kind: 'post', body: 'two' },
        ],
        openAsks: [],
        claims: {},
      };
      const client = stub({ read: vi.fn(async () => snapshot) });
      const handlers = createToolHandlers(client);

      await handlers.callTool('ledger_read', { limit: 1 });
      await handlers.callTool('ledger_read', {});

      expect(client.read).toHaveBeenLastCalledWith({ limit: 50 });
    });

    it('leaves an established cursor untouched across a filtered read in between', async () => {
      const drained: LedgerSnapshot = {
        entries: [{ id: 'e1', ts: 1, from: 'overmind', kind: 'post', body: 'one' }],
        openAsks: [],
        claims: {},
      };
      const filtered: LedgerSnapshot = {
        entries: [{ id: 'e9', ts: 9, from: 'sess-a', kind: 'ask', body: 'ship?' }],
        openAsks: [],
        claims: {},
      };
      const client = stub({
        read: vi
          .fn()
          .mockResolvedValueOnce(drained)
          .mockResolvedValueOnce(filtered)
          .mockResolvedValue(emptySnapshot),
      });
      const handlers = createToolHandlers(client);

      await handlers.callTool('ledger_read', {}); // establishes the cursor at e1
      await handlers.callTool('ledger_read', { kind: 'ask' }); // must not move it to e9
      await handlers.callTool('ledger_read', {});

      expect(client.read).toHaveBeenLastCalledWith({ since: 'e1' });
    });

    // The plain default read is the drain, and still advances as today.
    it('still moves the cursor for the plain default read', async () => {
      const snapshot: LedgerSnapshot = {
        entries: [{ id: 'e3', ts: 3, from: 'overmind', kind: 'post', body: 'three' }],
        openAsks: [],
        claims: {},
      };
      const client = stub({ read: vi.fn(async () => snapshot) });
      const handlers = createToolHandlers(client);

      await handlers.callTool('ledger_read', {});
      await handlers.callTool('ledger_read', {});

      expect(client.read).toHaveBeenLastCalledWith({ since: 'e3' });
    });
  });
});

describe('the writing tools', () => {
  it('ledger_post broadcasts when no "to" is given', async () => {
    const client = stub();
    await createToolHandlers(client).callTool('ledger_post', { body: 'hello' });

    expect(client.post).toHaveBeenCalledWith({ kind: 'post', body: 'hello' });
  });

  it('ledger_post carries "to" and meta when given', async () => {
    const client = stub();
    await createToolHandlers(client).callTool('ledger_post', {
      to: 'overmind',
      body: 'hello',
      meta: { ticket: 'HIVE-112' },
    });

    expect(client.post).toHaveBeenCalledWith({
      kind: 'post',
      to: 'overmind',
      body: 'hello',
      meta: { ticket: 'HIVE-112' },
    });
  });

  it('ledger_ask folds options into meta and reports the ref', async () => {
    const client = stub();
    const result = await createToolHandlers(client).callTool('ledger_ask', {
      to: 'overmind',
      body: 'ship it?',
      options: ['ship', 'wait'],
    });

    expect(client.post).toHaveBeenCalledWith({
      kind: 'ask',
      to: 'overmind',
      body: 'ship it?',
      meta: { options: ['ship', 'wait'] },
    });
    expect(textOf(result)).toMatch(/a1/);
    // The model must stop after asking; the result says so.
    expect(textOf(result)).toMatch(/end your turn/i);
    // And the same id/ref as data, not just inside the sentence — HIVE-119
    // and HIVE-120 both need to answer this thread later.
    expect(result.structuredContent).toEqual({ id: 'id-1', ref: 'a1' });
  });

  it('ledger_ask folds quote into meta beside options (HIVE-118)', async () => {
    const client = stub();
    await createToolHandlers(client).callTool('ledger_ask', {
      to: 'overmind',
      body: 'Send this?',
      quote: 'the draft',
      options: ['approve', 'edit', 'reject'],
    });

    expect(client.post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ask',
        meta: { options: ['approve', 'edit', 'reject'], quote: 'the draft' },
      }),
    );
  });

  it('ledger_ask omits quote from meta when none was given', async () => {
    const client = stub();
    await createToolHandlers(client).callTool('ledger_ask', { to: 'overmind', body: 'ok?' });

    const call = client.post as ReturnType<typeof vi.fn>;
    expect(call.mock.calls[0][0]).not.toHaveProperty('meta');
  });

  it('ignores a non-string quote rather than writing it through', async () => {
    const client = stub();
    await createToolHandlers(client).callTool('ledger_ask', {
      to: 'overmind',
      body: 'ok?',
      quote: 42,
    });

    const call = client.post as ReturnType<typeof vi.fn>;
    expect(call.mock.calls[0][0]).not.toHaveProperty('meta');
  });

  it('ledger_ask omits ref from structuredContent when the receiver returned none', async () => {
    const client = stub({ post: vi.fn(async () => ({ id: 'id-1' })) });
    const result = await createToolHandlers(client).callTool('ledger_ask', {
      to: 'overmind',
      body: 'ship it?',
    });

    expect(result.structuredContent).toEqual({ id: 'id-1' });
    expect(result.structuredContent).not.toHaveProperty('ref');
  });

  it('ledger_answer sends the thread through untouched, ref or id', async () => {
    const client = stub();
    await createToolHandlers(client).callTool('ledger_answer', { thread: 'a12', body: 'yes' });

    expect(client.post).toHaveBeenCalledWith({ kind: 'answer', thread: 'a12', body: 'yes' });
  });

  it('ledger_done and ledger_failed carry an optional thread', async () => {
    const client = stub();
    const handlers = createToolHandlers(client);

    await handlers.callTool('ledger_done', { body: 'merged', thread: 'a2' });
    expect(client.post).toHaveBeenCalledWith({ kind: 'done', body: 'merged', thread: 'a2' });

    await handlers.callTool('ledger_failed', { body: 'blocked' });
    expect(client.post).toHaveBeenCalledWith({ kind: 'failed', body: 'blocked' });
  });

  it('writes a handoff entry', async () => {
    const client = stub();
    const handlers = createToolHandlers(client);

    const result = await handlers.callTool('ledger_handoff', {
      body: 'I watch #ops. Thread 42 is open.',
    });

    expect(result.isError).toBe(false);
    expect(client.post).toHaveBeenCalledWith({
      kind: 'handoff',
      body: 'I watch #ops. Thread 42 is open.',
    });
  });

  it('refuses a write with no body before troubling the receiver', async () => {
    const client = stub();
    const result = await createToolHandlers(client).callTool('ledger_post', {});

    expect(result.isError).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('surfaces a receiver refusal as the reason it gave', async () => {
    const client = stub({
      post: vi.fn(async () => {
        throw new ReceiverError(400, 'thread is not open: a12');
      }),
    });

    const result = await createToolHandlers(client).callTool('ledger_answer', {
      thread: 'a12',
      body: 'yes',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('thread is not open: a12');
  });
});

describe('ledger_claim and ledger_release', () => {
  it('claims a free task and says so', async () => {
    const client = stub();
    const result = await createToolHandlers(client).callTool('ledger_claim', { task: 'HIVE-112' });

    // `limit: 0` still gets the full claims map back — `claims` is derived
    // from the whole log regardless of the query's limit — without shipping
    // every entry back just to read one key.
    expect(client.read).toHaveBeenCalledWith({ limit: 0 });
    expect(client.post).toHaveBeenCalledWith({
      kind: 'claim',
      body: 'claimed HIVE-112',
      meta: { task: 'HIVE-112' },
    });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toMatch(/HIVE-112/);
  });

  it('reports the current holder instead of failing', async () => {
    const client = stub({
      read: vi.fn(async () => ({ ...emptySnapshot, claims: { 'HIVE-112': 'slack-watcher' } })),
    });

    const result = await createToolHandlers(client).callTool('ledger_claim', { task: 'HIVE-112' });

    expect(client.read).toHaveBeenCalledWith({ limit: 0 });
    // Not an error: the store records a second claim deliberately.
    expect(result.isError).toBe(false);
    expect(textOf(result)).toMatch(/slack-watcher/);
    expect(client.post).toHaveBeenCalled();
  });

  it('releases a task', async () => {
    const client = stub();
    await createToolHandlers(client).callTool('ledger_release', { task: 'HIVE-112' });

    expect(client.post).toHaveBeenCalledWith({
      kind: 'release',
      body: 'released HIVE-112',
      meta: { task: 'HIVE-112' },
    });
  });

  it('surfaces the receiver refusal when releasing something you do not hold', async () => {
    const client = stub({
      post: vi.fn(async () => {
        throw new ReceiverError(403, 'HIVE-112 is held by slack-watcher, not by sess-a');
      }),
    });

    const result = await createToolHandlers(client).callTool('ledger_release', { task: 'HIVE-112' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/held by slack-watcher/);
  });

  it('needs a task', async () => {
    const client = stub();
    const result = await createToolHandlers(client).callTool('ledger_claim', {});

    expect(result.isError).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
  });

  /**
   * The informational read names a previous holder; it does not authorize
   * the claim (HIVE-112 self-review). A transient receiver failure on that
   * read must not sink a claim the `post` below would otherwise have made.
   */
  it('still claims, unnamed, when the informational read fails', async () => {
    const client = stub({
      read: vi.fn(async () => {
        throw new ReceiverError(500, 'receiver unreachable');
      }),
    });

    const result = await createToolHandlers(client).callTool('ledger_claim', { task: 'HIVE-112' });

    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe('claimed HIVE-112');
    expect(client.post).toHaveBeenCalledWith({
      kind: 'claim',
      body: 'claimed HIVE-112',
      meta: { task: 'HIVE-112' },
    });
  });
});

/**
 * `ledger_read` and `ledger_ask` are deliberately the only two tools that gain
 * `structuredContent` — everything else stays byte-identical to what it
 * returned before HIVE-112's structured-content change.
 */
describe('structuredContent stays off everywhere else', () => {
  it('carries no structuredContent for ledger_post, ledger_answer, ledger_claim, ledger_release, ledger_done or ledger_failed', async () => {
    const client = stub();
    const handlers = createToolHandlers(client);

    const post = await handlers.callTool('ledger_post', { body: 'hello' });
    expect(post.structuredContent).toBeUndefined();

    const answer = await handlers.callTool('ledger_answer', { thread: 'a1', body: 'yes' });
    expect(answer.structuredContent).toBeUndefined();

    const claim = await handlers.callTool('ledger_claim', { task: 'HIVE-112' });
    expect(claim.structuredContent).toBeUndefined();

    const release = await handlers.callTool('ledger_release', { task: 'HIVE-112' });
    expect(release.structuredContent).toBeUndefined();

    const done = await handlers.callTool('ledger_done', { body: 'merged' });
    expect(done.structuredContent).toBeUndefined();

    const failed = await handlers.callTool('ledger_failed', { body: 'blocked' });
    expect(failed.structuredContent).toBeUndefined();
  });
});

/**
 * The peer directory (HIVE-127).
 *
 * The text is what the model actually attends to, so these assert the
 * *sentences* as much as the payload: a peer a caller cannot reach is worse
 * than no peer at all, and the only place that can be said is the prose.
 */
describe('createToolHandlers — agents', () => {
  const peer = {
    name: 'pr-reviewer',
    description: 'Reviews open PRs.',
    status: 'sleeping' as const,
    accepts: ['ledger' as const],
    tools: ['Read'],
  };

  it('returns the peers as readable text and as structured content', async () => {
    const handlers = createToolHandlers(stub({ agents: async () => ({ agents: [peer] }) }));

    const result = await handlers.callTool('agents', {});

    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('pr-reviewer');
    expect(textOf(result)).toContain('Reviews open PRs.');
    expect(result.structuredContent).toEqual({ agents: [peer] });
  });

  /*
    `wake.on` is a gate, not a preference. A peer listed without `ledger` will
    never wake on an ask, so the text has to say so — handing a model a name it
    cannot reach is worse than handing it nothing.
  */
  it('says when an ask cannot actually reach a peer', async () => {
    const handlers = createToolHandlers(
      stub({ agents: async () => ({ agents: [{ ...peer, accepts: [] }] }) }),
    );

    expect(textOf(await handlers.callTool('agents', {}))).toMatch(/does not wake on the ledger/i);
  });

  it('marks a broken peer unreachable, with its reason', async () => {
    const handlers = createToolHandlers(
      stub({
        agents: async () => ({
          agents: [
            { ...peer, accepts: [], tools: [], invalid: "wake.on: unknown event 'ledgr'" },
          ],
        }),
      }),
    );

    const text = textOf(await handlers.callTool('agents', {}));

    expect(text).toContain("unknown event 'ledgr'");
    expect(text).toMatch(/cannot be reached/i);
  });

  it('says so plainly when the caller is the only agent here', async () => {
    const handlers = createToolHandlers(stub({ agents: async () => ({ agents: [] }) }));

    const result = await handlers.callTool('agents', {});

    expect(result.isError).toBe(false);
    expect(textOf(result)).toMatch(/no other agents/i);
  });

  it('hands a refusal to the model rather than throwing a protocol error', async () => {
    const handlers = createToolHandlers(
      stub({
        agents: async () => {
          throw new ReceiverError(500, 'EACCES: permission denied');
        },
      }),
    );

    const result = await handlers.callTool('agents', {});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('EACCES');
  });

  it('is listed, so a model can find it', () => {
    expect(createToolHandlers(stub()).listTools().map((tool) => tool.name)).toContain('agents');
  });
});
