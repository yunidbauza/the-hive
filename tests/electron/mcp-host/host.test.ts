import { describe, expect, it, vi } from 'vitest';

import { createHandlers, readEnvironment } from '../../../electron/mcp-host/host';

describe('readEnvironment', () => {
  it('reads the three variables the host needs', () => {
    expect(
      readEnvironment({
        HIVE_SESSION_ID: 'sess-a',
        HIVE_HOOK_TOKEN: 'tok',
        HIVE_RECEIVER_URL: 'http://127.0.0.1:4100',
      }),
    ).toEqual({ session: 'sess-a', token: 'tok', url: 'http://127.0.0.1:4100' });
  });

  it('answers null when any of them is missing', () => {
    expect(readEnvironment({ HIVE_SESSION_ID: 'sess-a', HIVE_HOOK_TOKEN: 'tok' })).toBeNull();
    expect(readEnvironment({})).toBeNull();
  });
});

describe('createHandlers without an environment', () => {
  it('still lists the eight tools, so /mcp shows the server connected', () => {
    const handlers = createHandlers({}, vi.fn() as never);
    expect(handlers.listTools()).toHaveLength(8);
  });

  it('answers every call with a legible reason instead of hanging', async () => {
    const handlers = createHandlers({}, vi.fn() as never);
    const result = await handlers.callTool('ledger_read', {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not running|outside the Hive/i);
  });

  it('never calls fetch when it has no receiver to call', async () => {
    const fetchImpl = vi.fn();
    await createHandlers({}, fetchImpl as never).callTool('ledger_post', { body: 'x' });

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('createHandlers with an environment', () => {
  it('calls the receiver named in the environment', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ entries: [], openAsks: [], claims: {} }), { status: 200 }),
    );

    const handlers = createHandlers(
      {
        HIVE_SESSION_ID: 'sess-a',
        HIVE_HOOK_TOKEN: 'tok',
        HIVE_RECEIVER_URL: 'http://127.0.0.1:4100',
      },
      fetchImpl as never,
    );

    const result = await handlers.callTool('ledger_read', {});

    expect(result.isError).toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/ledger/read',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
