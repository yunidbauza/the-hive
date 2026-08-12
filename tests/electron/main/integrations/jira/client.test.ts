// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createJiraClient,
  type FetchLike,
  type Sleep,
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

/** A fetch that answers each call from a queue, and records the URLs it saw. */
function sequence(answers: (Response | Error)[], seen: string[] = []): FetchLike {
  let at = 0;
  return (url) => {
    seen.push(url);
    const answer = answers[Math.min(at, answers.length - 1)];
    at += 1;
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

/**
 * Every client here gets a no-op `sleep`.
 *
 * `CLAUDE.md` forbids real waits in unit tests, and the retry path would
 * otherwise add half a second per 429 or 5xx case — a cost that grows every
 * time someone adds a row to the error table.
 */
const waits: number[] = [];
const noSleep: Sleep = (ms) => {
  waits.push(ms);
  return Promise.resolve();
};

const client = (fetch: FetchLike, sleep: Sleep = noSleep) =>
  createJiraClient({
    fetch,
    site: 'behiques.atlassian.net',
    credential: CREDENTIAL,
    sleep,
  });

beforeEach(() => {
  waits.length = 0;
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

describe('query parameters (HIVE-68)', () => {
  it('URL-encodes them rather than appending a string', async () => {
    const seen: Seen[] = [];
    await client(responder(json({}), seen)).get('/rest/api/3/search/jql', {
      jql: 'assignee = currentUser() AND statusCategory != Done',
      fields: 'summary,status',
      maxResults: '100',
    });

    const url = new URL(seen[0]?.url ?? '');
    expect(url.origin).toBe('https://behiques.atlassian.net');
    expect(url.pathname).toBe('/rest/api/3/search/jql');
    expect(url.searchParams.get('jql')).toBe(
      'assignee = currentUser() AND statusCategory != Done',
    );
    expect(url.searchParams.get('fields')).toBe('summary,status');
    expect(url.searchParams.get('maxResults')).toBe('100');
  });

  it('treats & and = inside a query as a value, not as more parameters', async () => {
    const seen: Seen[] = [];
    // The whole reason params are a record rather than a string: this must be
    // one parameter, not three.
    await client(responder(json({}), seen)).get('/rest/api/3/search/jql', {
      jql: 'summary ~ "a&b=c" AND project = HIVE',
    });

    const url = new URL(seen[0]?.url ?? '');
    expect([...url.searchParams.keys()]).toEqual(['jql']);
    expect(url.searchParams.get('jql')).toBe('summary ~ "a&b=c" AND project = HIVE');
  });

  it('omits the query string entirely when there are no params', async () => {
    const seen: Seen[] = [];
    await client(responder(json({}), seen)).get('/rest/api/3/myself');
    expect(seen[0]?.url).toBe('https://behiques.atlassian.net/rest/api/3/myself');
  });
});

describe('one automatic retry (HIVE-68)', () => {
  it('retries a 429 once and succeeds', async () => {
    const seen: string[] = [];
    const result = await client(
      sequence(
        [new Response('slow', { status: 429 }), json({ displayName: 'Y' })],
        seen,
      ),
    ).get<{ displayName: string }>('/rest/api/3/myself');

    expect(result).toEqual({ ok: true, value: { displayName: 'Y' } });
    expect(seen).toHaveLength(2);
    expect(waits).toEqual([500]);
  });

  it('honours Retry-After when it is inside the cap', async () => {
    const seen: string[] = [];
    await client(
      sequence(
        [
          new Response('slow', {
            status: 429,
            headers: { 'retry-after': '3' },
          }),
          json({}),
        ],
        seen,
      ),
    ).get('/rest/api/3/myself');

    expect(waits).toEqual([3000]);
    expect(seen).toHaveLength(2);
  });

  it('reports immediately rather than waiting past the cap', async () => {
    const seen: string[] = [];
    const result = await client(
      sequence(
        [
          new Response('slow', {
            status: 429,
            headers: { 'retry-after': '180' },
          }),
        ],
        seen,
      ),
    ).get('/rest/api/3/myself');

    // Blocking an IPC call for three minutes is worse than reporting. The
    // number still reaches the pane, so it can say *when*.
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.retryAfter).toBe(180);
    expect(waits).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it('retries a 5xx once, with a backoff', async () => {
    const seen: string[] = [];
    const result = await client(
      sequence([new Response('boom', { status: 502 }), json({ ok: 1 })], seen),
    ).get('/rest/api/3/myself');

    expect(result.ok).toBe(true);
    expect(waits).toEqual([500]);
    expect(seen).toHaveLength(2);
  });

  it('reports a second failure rather than retrying again', async () => {
    const seen: string[] = [];
    const result = await client(
      sequence([new Response('boom', { status: 503 })], seen),
    ).get('/rest/api/3/myself');

    expect(!result.ok && result.error.kind).toBe('unknown');
    expect(seen).toHaveLength(2);
    expect(waits).toEqual([500]);
  });

  for (const status of [400, 401, 403, 404]) {
    it(`does not retry ${status}`, async () => {
      const seen: string[] = [];
      await client(sequence([new Response('no', { status })], seen)).get(
        '/rest/api/3/myself',
      );
      expect(seen).toHaveLength(1);
      expect(waits).toEqual([]);
    });
  }

  it('does not retry a rejected fetch', async () => {
    const seen: string[] = [];
    await client(sequence([new TypeError('fetch failed')], seen)).get(
      '/rest/api/3/myself',
    );
    expect(seen).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('does not retry a body it refused, or one that was not JSON', async () => {
    const tooBig = new Response('x'.repeat(300_000), { status: 200 });
    await client(sequence([tooBig])).get('/rest/api/3/myself');
    expect(waits).toEqual([]);

    const html = new Response('<html>nginx</html>', { status: 200 });
    await client(sequence([html])).get('/rest/api/3/myself');
    expect(waits).toEqual([]);
  });

  it('retries the same URL, params and all', async () => {
    const seen: string[] = [];
    await client(
      sequence([new Response('boom', { status: 500 }), json({})], seen),
    ).get('/rest/api/3/search/jql', { jql: 'project = HIVE' });

    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toContain('jql=project+%3D+HIVE');
  });
});

describe('post (HIVE-70)', () => {
  it('sends the body as JSON with a content-type', async () => {
    const seen: Seen[] = [];
    await client(responder(new Response(null, { status: 204 }), seen)).post(
      '/rest/api/3/issue/HIVE-70/transitions',
      { transition: { id: '31' } },
    );

    expect(seen[0]?.init.method).toBe('POST');
    expect(seen[0]?.init.body).toBe('{"transition":{"id":"31"}}');
    expect(new Headers(seen[0]?.init.headers).get('content-type')).toBe(
      'application/json',
    );
  });

  it('carries the same credential and timeout as a read', async () => {
    const seen: Seen[] = [];
    await client(responder(new Response(null, { status: 204 }), seen)).post(
      '/rest/api/3/issue/HIVE-70/transitions',
      {},
    );

    const headers = new Headers(seen[0]?.init.headers);
    expect(headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`${CREDENTIAL.email}:${TOKEN}`).toString('base64')}`,
    );
    expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('treats 204 No Content as success, not as a parse failure', async () => {
    const result = await client(
      responder(new Response(null, { status: 204 })),
    ).post('/rest/api/3/issue/HIVE-70/transitions', {});

    // Without this the one verb that writes would report "not JSON" every time
    // it worked.
    expect(result.ok).toBe(true);
  });

  /**
   * The rule HIVE-68's client header wrote down for whoever added the first
   * POST. This is that POST.
   */
  for (const status of [429, 500, 502, 503]) {
    it(`does NOT retry ${status} — a transition may already have applied`, async () => {
      const seen: string[] = [];
      const result = await client(
        sequence([new Response('no', { status })], seen),
      ).post('/rest/api/3/issue/HIVE-70/transitions', {});

      expect(result.ok).toBe(false);
      expect(seen).toHaveLength(1);
      expect(waits).toEqual([]);
    });
  }

  it('reports a 429 with its Retry-After rather than waiting', async () => {
    const result = await client(
      responder(
        new Response('slow', { status: 429, headers: { 'retry-after': '4' } }),
      ),
    ).post('/rest/api/3/issue/HIVE-70/transitions', {});

    expect(!result.ok && result.error.kind).toBe('rate-limited');
    expect(!result.ok && result.error.retryAfter).toBe(4);
    expect(waits).toEqual([]);
  });
});

describe('400 details (HIVE-70)', () => {
  const badRequest = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });

  it('names the field Jira asked for', async () => {
    const result = await client(
      responder(
        badRequest({
          errorMessages: [],
          errors: { resolution: 'Field \'resolution\' is required' },
        }),
      ),
    ).post('/rest/api/3/issue/HIVE-70/transitions', {});

    expect(!result.ok && result.error.kind).toBe('bad-query');
    expect(!result.ok && result.error.details).toEqual([
      "resolution: Field 'resolution' is required",
    ]);
  });

  it('carries errorMessages too', async () => {
    const result = await client(
      responder(badRequest({ errorMessages: ['Transition is not valid.'] })),
    ).post('/rest/api/3/issue/HIVE-70/transitions', {});

    expect(!result.ok && result.error.details).toEqual([
      'Transition is not valid.',
    ]);
  });

  it('reads nothing but those two keys', async () => {
    const result = await client(
      responder(
        badRequest({
          errorMessages: ['One'],
          errors: { field: 'Two' },
          warningMessages: ['SHOULD NOT APPEAR'],
          somethingElse: 'ALSO NOT',
        }),
      ),
    ).post('/rest/api/3/issue/HIVE-70/transitions', {});

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('SHOULD NOT APPEAR');
    expect(serialised).not.toContain('ALSO NOT');
    expect(serialised).not.toContain('warningMessages');
  });

  it('bounds the count and the length', async () => {
    const result = await client(
      responder(
        badRequest({
          errorMessages: Array.from({ length: 40 }, (_, i) => `msg ${i}`),
          errors: { long: 'x'.repeat(1000) },
        }),
      ),
    ).post('/rest/api/3/issue/HIVE-70/transitions', {});

    const details = (!result.ok && result.error.details) || [];
    expect(details.length).toBeLessThanOrEqual(10);
    for (const detail of details) expect(detail.length).toBeLessThanOrEqual(310);
  });

  it('strips control characters rather than dropping the message', async () => {
    const result = await client(
      responder(badRequest({ errorMessages: ['a\u0007b\u001bc'] })),
    ).post('/rest/api/3/issue/HIVE-70/transitions', {});

    expect(!result.ok && result.error.details).toEqual(['abc']);
  });

  it('leaves details absent when the body is not Jira-shaped', async () => {
    const result = await client(
      responder(new Response('<html>nope</html>', { status: 400 })),
    ).post('/rest/api/3/issue/HIVE-70/transitions', {});

    expect(!result.ok && result.error.details).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('html');
  });

  it('reads no body on any status but 400', async () => {
    const result = await client(
      responder(
        new Response(JSON.stringify({ errorMessages: ['LEAK'] }), {
          status: 403,
        }),
      ),
    ).post('/rest/api/3/issue/HIVE-70/transitions', {});

    expect(!result.ok && result.error.kind).toBe('forbidden');
    expect(JSON.stringify(result)).not.toContain('LEAK');
  });

});
