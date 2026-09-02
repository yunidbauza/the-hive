import { describe, expect, it, vi } from 'vitest';

import { createHandlers, readEnvironment, readGrants } from '../../../electron/mcp-host/host';

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

describe('readGrants', () => {
  it('reads grants from the environment, and fences everything without them', () => {
    expect(readGrants({ HIVE_GRANTS: '["Read","Bash"]' })).toEqual(['Read', 'Bash']);
    expect(readGrants({ HIVE_GRANTS: 'not json' })).toEqual([]);
    expect(readGrants({ HIVE_GRANTS: '{"a":1}' })).toEqual([]);
    expect(readGrants({})).toEqual([]);
  });
});

describe('createHandlers without an environment', () => {
  /*
    Eleven since HIVE-127 added the peer directory. The count matters here
    rather than in prose: this is the unreachable path, and a tool list that
    differed depending on how the process was started would make `/mcp` report
    a different server than the one an agent actually gets.
  */
  it('still lists the eleven tools, so /mcp shows the server connected', () => {
    const handlers = createHandlers({}, vi.fn() as never);
    expect(handlers.listTools()).toHaveLength(11);
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
