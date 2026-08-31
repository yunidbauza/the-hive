import { describe, expect, it, vi } from 'vitest';

import type { LedgerSnapshot } from '@shared/ledger-contract';

import { ReceiverError, type ReceiverClient } from '../../../electron/mcp-host/client';
import { createToolHandlers } from '../../../electron/mcp-host/tools';

const emptySnapshot: LedgerSnapshot = { entries: [], openAsks: [], claims: {} };

const stub = (overrides: Partial<ReceiverClient> = {}): ReceiverClient =>
  ({
    read: vi.fn(async () => emptySnapshot),
    post: vi.fn(async () => ({ id: 'id-1', ref: 'a1' })),
    ...overrides,
  }) as unknown as ReceiverClient;

/** The decision the CLI reads, which lives in the text and nowhere else. */
const decisionOf = (result: { content: { text: string }[] }) =>
  JSON.parse(result.content[0]!.text) as Record<string, unknown>;

describe('approve', () => {
  it('allows a granted tool without writing an ask', async () => {
    const client = stub();
    const handlers = createToolHandlers(client, ['Read', 'mcp__hive__*']);

    const result = await handlers.callTool('approve', {
      tool_name: 'Read',
      input: { file_path: '/repo/a.ts' },
    });

    expect(decisionOf(result)).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/repo/a.ts' },
    });
    expect(client.post).not.toHaveBeenCalled();
  });

  /**
   * The widest rule in the grammar, and nothing pinned it. `'*'` is what a
   * hostile `meta.rungs` was trying to get written into `tools:`, so what it
   * does when it *is* there had better be written down: it allows every call
   * to every tool, unasked.
   */
  it('lets the blanket rule allow anything, unasked', async () => {
    const client = stub();
    const handlers = createToolHandlers(client, ['*']);

    for (const call of [
      { tool_name: 'Bash', input: { command: 'rm -rf /' } },
      { tool_name: 'WebFetch', input: { url: 'https://evil.test/x' } },
      { tool_name: 'SomeToolNobodyHasHeardOf', input: {} },
    ]) {
      expect(decisionOf(await handlers.callTool('approve', call))).toEqual({
        behavior: 'allow',
        updatedInput: call.input,
      });
    }
    expect(client.post).not.toHaveBeenCalled();
  });

  /**
   * The ledger is append-only JSONL that never rotates and `store.all()`
   * holds every entry in memory, so a denied `Write` used to park the whole
   * file — up to 64 KiB — in it permanently. Nothing reads those fields: the
   * card does not render them and both the ladder and the one-shot rule come
   * from the tool name and the specifier text.
   */
  it('does not park a denied call\'s file contents in the ledger', async () => {
    const client = stub();
    const handlers = createToolHandlers(client, []);

    await handlers.callTool('approve', {
      tool_name: 'Write',
      input: { file_path: '/repo/a.ts', content: 'x'.repeat(64_000) },
    });

    const post = vi.mocked(client.post).mock.calls[0]![0] as unknown as {
      meta: { input: Record<string, unknown> };
    };
    expect(post.meta.input['content']).toBe('[omitted from the ledger: 64000 chars]');
    // The specifier the grant is computed from survives untouched.
    expect(post.meta.input['file_path']).toBe('/repo/a.ts');
  });

  it('trims an Edit\'s old/new strings the same way', async () => {
    const client = stub();
    const handlers = createToolHandlers(client, []);

    await handlers.callTool('approve', {
      tool_name: 'Edit',
      input: { file_path: '/repo/a.ts', old_string: 'aaa', new_string: 'bbbb' },
    });

    const post = vi.mocked(client.post).mock.calls[0]![0] as unknown as {
      meta: { input: Record<string, unknown> };
    };
    expect(post.meta.input['old_string']).toBe('[omitted from the ledger: 3 chars]');
    expect(post.meta.input['new_string']).toBe('[omitted from the ledger: 4 chars]');
  });

  it('never trims the input an allowed call actually runs with', async () => {
    const handlers = createToolHandlers(stub(), ['Write']);
    const input = { file_path: '/repo/a.ts', content: 'the whole file' };

    expect(decisionOf(await handlers.callTool('approve', { tool_name: 'Write', input }))).toEqual({
      behavior: 'allow',
      updatedInput: input,
    });
  });

  it('allows the hive tools through the mcp glob', async () => {
    const handlers = createToolHandlers(stub(), ['mcp__hive__*']);
    const result = await handlers.callTool('approve', {
      tool_name: 'mcp__hive__ledger_read',
      input: {},
    });
    expect(decisionOf(result)['behavior']).toBe('allow');
  });

  it('never sets structuredContent, which the CLI rejects', async () => {
    const handlers = createToolHandlers(stub(), ['Read']);
    const result = await handlers.callTool('approve', {
      tool_name: 'Read',
      input: {},
    });
    expect(result).not.toHaveProperty('structuredContent');
  });

  it('writes a permission ask and denies an ungranted tool', async () => {
    const client = stub();
    const handlers = createToolHandlers(client, ['Read']);

    const result = await handlers.callTool('approve', {
      tool_name: 'Bash',
      input: { command: 'git push origin main' },
    });

    expect(client.post).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'overmind',
        kind: 'ask',
        body: 'Allow Bash?\ngit push origin main',
      }),
    );

    const meta = (client.post as ReturnType<typeof vi.fn>).mock.calls[0]![0]['meta'];
    expect(meta['kind']).toBe('permission');
    expect(meta['tool']).toBe('Bash');
    expect(meta['default']).toBe('allow-family');
    expect(meta['options']).toEqual(['allow-once', 'allow-family', 'allow-tool', 'deny']);

    const decision = decisionOf(result);
    expect(decision['behavior']).toBe('deny');
    expect(typeof decision['message']).toBe('string');
  });

  it('denies everything when no grants were configured', async () => {
    const client = stub();
    const handlers = createToolHandlers(client, []);
    const result = await handlers.callTool('approve', {
      tool_name: 'Read',
      input: {},
    });
    expect(decisionOf(result)['behavior']).toBe('deny');
    expect(client.post).toHaveBeenCalled();
  });

  it('denies rather than erroring when the receiver refuses', async () => {
    const handlers = createToolHandlers(
      stub({
        post: vi.fn(async () => {
          throw new ReceiverError(503, 'the ledger is closed');
        }),
      }),
      [],
    );

    const result = await handlers.callTool('approve', {
      tool_name: 'Bash',
      input: { command: 'ls' },
    });

    // A permission prompt tool must always answer with a decision. An
    // `isError` result is not one, and the CLI cannot act on it.
    expect(result.isError).not.toBe(true);
    const decision = decisionOf(result);
    expect(decision['behavior']).toBe('deny');
    expect(decision['message']).toContain('the ledger is closed');
  });

  it('denies a call with no tool_name', async () => {
    const handlers = createToolHandlers(stub(), ['*']);
    const result = await handlers.callTool('approve', { input: {} });
    expect(decisionOf(result)['behavior']).toBe('deny');
  });
});
