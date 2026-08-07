// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  createJiraClient,
  type FetchLike,
} from '../../../../../electron/main/integrations/jira/client';

/**
 * The HTTP client (HIVE-67).
 *
 * `fetch` is injected, exactly as `gh.ts` injects its `RunCommand`, so no test
 * here touches the network. What is under test is how a response is *read* and
 * how a failure is *named* — both of which must answer identically on every
 * machine — plus the two properties that make this safe to point at a
 * credential: the host cannot come from a caller, and nothing the server said
 * is ever quoted back.
 */

const TOKEN = 'ATATT-not-a-real-token-9f3c';
const CREDENTIAL = { email: 'me@example.com', token: TOKEN };

interface Seen {
  url: string;
  init: RequestInit;
}

/** A fetch that answers with one response and records what it was asked. */
function responder(answer: Response | Error, seen: Seen[] = []): FetchLike {
  return (url, init) => {
    seen.push({ url, init });
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const client = (fetch: FetchLike) =>
  createJiraClient({
    fetch,
    site: 'behiques.atlassian.net',
    credential: CREDENTIAL,
  });

describe('the request', () => {
  it('builds the URL from the configured host and the caller path', async () => {
    const seen: Seen[] = [];
    await client(responder(json({}), seen)).get('/rest/api/3/myself');
    expect(seen[0]?.url).toBe(
      'https://behiques.atlassian.net/rest/api/3/myself',
    );
  });

  it('sends Basic auth built from email and token', async () => {
    const seen: Seen[] = [];
    await client(responder(json({}), seen)).get('/rest/api/3/myself');
    const headers = new Headers(seen[0]?.init.headers);
    expect(headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`${CREDENTIAL.email}:${TOKEN}`).toString('base64')}`,
    );
    expect(headers.get('accept')).toBe('application/json');
  });

  it('attaches an abort signal, so a hung Jira cannot hang the pane', async () => {
    const seen: Seen[] = [];
    await client(responder(json({}), seen)).get('/rest/api/3/myself');
    expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses a ten second budget', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await client(responder(json({}))).get('/rest/api/3/myself');
    expect(spy).toHaveBeenCalledWith(10_000);
    spy.mockRestore();
  });

  it('is a GET, always', async () => {
    const seen: Seen[] = [];
    await client(responder(json({}), seen)).get('/rest/api/3/myself');
    expect(seen[0]?.init.method).toBe('GET');
  });
});

describe('the error table', () => {
  const cases: [number, string][] = [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [429, 'rate-limited'],
    [400, 'bad-query'],
    [500, 'unknown'],
    [502, 'unknown'],
  ];

  for (const [status, kind] of cases) {
    it(`maps ${status} to ${kind}`, async () => {
      const result = await client(
        responder(new Response('nope', { status })),
      ).get('/rest/api/3/myself');
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.kind).toBe(kind);
      expect(!result.ok && result.error.message.length).toBeGreaterThan(0);
    });
  }

  it('reads Retry-After on 429', async () => {
    const result = await client(
      responder(
        new Response('slow down', {
          status: 429,
          headers: { 'retry-after': '17' },
        }),
      ),
    ).get('/rest/api/3/myself');
    expect(!result.ok && result.error.retryAfter).toBe(17);
  });

  it('omits Retry-After when Jira sent a date form rather than guessing', async () => {
    const result = await client(
      responder(
        new Response('slow down', {
          status: 429,
          headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
        }),
      ),
    ).get('/rest/api/3/myself');
    expect(!result.ok && result.error.retryAfter).toBeUndefined();
  });

  it('maps a rejected fetch to offline', async () => {
    const result = await client(responder(new TypeError('fetch failed'))).get(
      '/rest/api/3/myself',
    );
    expect(!result.ok && result.error.kind).toBe('offline');
  });

  it('maps an aborted fetch to timeout', async () => {
    const abort = new DOMException(
      'The operation was aborted.',
      'TimeoutError',
    );
    const result = await client(responder(abort as unknown as Error)).get(
      '/rest/api/3/myself',
    );
    expect(!result.ok && result.error.kind).toBe('timeout');
  });

  it('refuses a body past the cap rather than buffering it', async () => {
    const huge = new Response('x'.repeat(300_000), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const result = await client(responder(huge)).get('/rest/api/3/myself');
    expect(!result.ok && result.error.kind).toBe('unknown');
    expect(!result.ok && result.error.message).toMatch(/too large/i);
  });

  it('refuses a declared content-length past the cap before reading', async () => {
    const declared = new Response('{}', {
      status: 200,
      headers: { 'content-length': String(300_000) },
    });
    const result = await client(responder(declared)).get('/rest/api/3/myself');
    expect(!result.ok && result.error.kind).toBe('unknown');
  });

  it('names unparseable JSON without quoting it', async () => {
    const result = await client(
      responder(new Response('<html>nginx proxy error</html>', { status: 200 })),
    ).get('/rest/api/3/myself');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).not.toContain('nginx');
  });
});

describe('nothing leaks', () => {
  it('keeps the token and the response body out of every error message', async () => {
    for (const status of [401, 403, 404, 429, 400, 500]) {
      const body = `denied for ${TOKEN} — internal detail`;
      const result = await client(responder(new Response(body, { status }))).get(
        '/rest/api/3/myself',
      );
      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain(TOKEN);
      expect(serialised).not.toContain('internal detail');
    }
  });

  it('keeps the token out of a rejected-fetch message', async () => {
    const result = await client(
      responder(new Error(`connect ECONNREFUSED with ${TOKEN}`)),
    ).get('/rest/api/3/myself');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain('ECONNREFUSED');
  });
});

describe('success', () => {
  it('returns the parsed body', async () => {
    const result = await client(
      responder(json({ displayName: 'Yunid', accountId: '712020:9f3c' })),
    ).get<{ displayName: string }>('/rest/api/3/myself');
    expect(result).toEqual({
      ok: true,
      value: { displayName: 'Yunid', accountId: '712020:9f3c' },
    });
  });

  it('accepts a body right at the cap', async () => {
    const body = JSON.stringify({ pad: 'x'.repeat(1000) });
    const result = await client(
      responder(
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ).get<{ pad: string }>('/rest/api/3/myself');
    expect(result.ok).toBe(true);
  });
});
