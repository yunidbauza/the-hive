// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createJira } from '../../../../../electron/main/integrations/jira';
import type {
  SecretFile,
  SecretStore,
} from '../../../../../electron/main/integrations/jira/auth';
import type {
  FetchLike,
  Sleep,
} from '../../../../../electron/main/integrations/jira/client';
import {
  DEFAULT_JIRA,
  emptySnapshot,
  type JiraConfig,
} from '../../../../../electron/shared/config-contract';

/**
 * The verbs main exposes (HIVE-67).
 *
 * Composition only — auth, client and config each have their own suite. What
 * this proves is that the composition does not leak, and that a verb *answers*
 * rather than throwing when the app is not configured.
 */

const TOKEN = 'ATATT-not-a-real-token-9f3c';

function store(available = true): SecretStore {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (cipher) => {
      const text = cipher.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('not ciphertext');
      return text.slice(4);
    },
  };
}

function file(): SecretFile {
  let bytes: Buffer | null = null;
  return {
    read: () => bytes,
    write: (next) => {
      bytes = next;
    },
    clear: () => {
      bytes = null;
    },
  };
}

/** A fetch that fails the test if it is reached at all. */
const never: FetchLike = () => {
  throw new Error('fetch must not be called');
};

/** No real waits: the retry path would otherwise cost half a second a case. */
const noSleep: Sleep = () => Promise.resolve();

const build = (options: {
  jira?: JiraConfig;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  available?: boolean;
}) =>
  createJira({
    store: store(options.available ?? true),
    file: file(),
    env: options.env ?? {},
    config: () => ({
      ...emptySnapshot('/tmp/config.json'),
      jira: options.jira ?? DEFAULT_JIRA,
    }),
    fetch: options.fetch ?? never,
    sleep: noSleep,
  });

const CONFIGURED: JiraConfig = {
  site: 'behiques.atlassian.net',
  email: 'me@example.com',
};

describe('status', () => {
  it('reports the configured site and email beside the credential state', () => {
    expect(build({ jira: CONFIGURED }).status()).toEqual({
      site: 'behiques.atlassian.net',
      email: 'me@example.com',
      credential: { kind: 'none' },
      encryptionAvailable: true,
    });
  });

  it('reports encryptionAvailable false beside an env credential', () => {
    const status = build({
      available: false,
      env: { JIRA_API_KEY: TOKEN },
    }).status();
    expect(status.credential).toEqual({
      kind: 'env',
      variable: 'JIRA_API_KEY',
    });
    expect(status.encryptionAvailable).toBe(false);
  });

  it('never contains the token, in any state', () => {
    const jira = build({ jira: CONFIGURED, env: { JIRA_API_KEY: TOKEN } });
    expect(JSON.stringify(jira.status())).not.toContain(TOKEN);
    expect(JSON.stringify(jira.setToken({ token: TOKEN }))).not.toContain(
      TOKEN,
    );
    expect(JSON.stringify(jira.clearToken())).not.toContain(TOKEN);
  });
});

describe('setToken', () => {
  it('answers with the fresh status rather than nothing', () => {
    const jira = build({ jira: CONFIGURED });
    expect(jira.setToken({ token: TOKEN }).credential).toEqual({
      kind: 'stored',
      email: 'me@example.com',
    });
  });

  it('reports rather than throws when encryption is unavailable', () => {
    const status = build({ available: false }).setToken({ token: TOKEN });
    expect(status.credential.kind).toBe('unavailable');
    expect(status.encryptionAvailable).toBe(false);
  });
});

describe('clearToken', () => {
  it('drops back to none and answers with it', () => {
    const jira = build({ jira: CONFIGURED });
    jira.setToken({ token: TOKEN });
    expect(jira.clearToken().credential).toEqual({ kind: 'none' });
  });
});

describe('test', () => {
  it('refuses before a site is configured, without calling fetch', async () => {
    const result = await build({
      jira: { site: null, email: 'me@example.com' },
    }).test();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toMatch(/site/i);
  });

  it('refuses before an email is configured, without calling fetch', async () => {
    const result = await build({
      jira: { site: 'behiques.atlassian.net', email: null },
    }).test();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toMatch(/email/i);
  });

  it('refuses with no credential at all, without calling fetch', async () => {
    const result = await build({ jira: CONFIGURED }).test();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('unauthorized');
  });

  it('narrows /myself to display name and account id', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            displayName: 'Yunid Bauza',
            accountId: '712020:9f3c',
            emailAddress: 'private@example.com',
            avatarUrls: { '48x48': 'https://example.invalid/a.png' },
            locale: 'en_US',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const jira = build({ jira: CONFIGURED, fetch });
    jira.setToken({ token: TOKEN });

    const result = await jira.test();
    expect(result).toEqual({
      ok: true,
      value: { displayName: 'Yunid Bauza', accountId: '712020:9f3c' },
    });
    // The rest of the payload does not cross.
    expect(JSON.stringify(result)).not.toContain('private@example.com');
    expect(JSON.stringify(result)).not.toContain('avatarUrls');
  });

  it('reports an answer that has no account name', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response(JSON.stringify({ nothing: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const jira = build({ jira: CONFIGURED, fetch });
    jira.setToken({ token: TOKEN });
    const result = await jira.test();
    expect(!result.ok && result.error.kind).toBe('unknown');
  });

  it('does not clear a stored token when Jira answers 401', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(new Response('no', { status: 401 }));
    const jira = build({ jira: CONFIGURED, fetch });
    jira.setToken({ token: TOKEN });

    const result = await jira.test();
    expect(!result.ok && result.error.kind).toBe('unauthorized');
    // A transient 401 must not destroy the user's credential.
    expect(jira.status().credential.kind).toBe('stored');
  });

  it('uses the environment token when nothing is stored', async () => {
    let sent: string | undefined;
    const fetch: FetchLike = (_url, init) => {
      sent = new Headers(init.headers).get('authorization') ?? undefined;
      return Promise.resolve(
        new Response(
          JSON.stringify({ displayName: 'Env User', accountId: 'a1' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    };
    const result = await build({
      jira: CONFIGURED,
      env: { JIRA_API_KEY: TOKEN },
      fetch,
    }).test();

    expect(result.ok).toBe(true);
    expect(sent).toBe(
      `Basic ${Buffer.from(`me@example.com:${TOKEN}`).toString('base64')}`,
    );
  });

  it('reads the site fresh, so a config edit is picked up without a restart', async () => {
    let jiraConfig: JiraConfig = { site: 'first.atlassian.net', email: 'me@example.com' };
    const seen: string[] = [];
    const fetch: FetchLike = (url) => {
      seen.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ displayName: 'A', accountId: 'b' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const jira = createJira({
      store: store(),
      file: file(),
      env: { JIRA_API_KEY: TOKEN },
      config: () => ({ ...emptySnapshot('/tmp/config.json'), jira: jiraConfig }),
      fetch,
    });

    await jira.test();
    jiraConfig = { site: 'second.atlassian.net', email: 'me@example.com' };
    await jira.test();

    expect(seen[0]).toContain('first.atlassian.net');
    expect(seen[1]).toContain('second.atlassian.net');
  });
});

/**
 * A realistic search page. Carries the fields Jira sends that the app does not
 * ask for, so the deep scan below has something to fail on.
 */
const page = (
  keys: string[],
  nextPageToken?: string,
): Record<string, unknown> => ({
  ...(nextPageToken === undefined ? {} : { nextPageToken }),
  issues: keys.map((key) => ({
    id: '1',
    self: `https://${CONFIGURED.site}/rest/api/3/issue/1`,
    key,
    fields: {
      summary: `Summary for ${key}`,
      status: {
        name: 'In Progress',
        statusCategory: { key: 'indeterminate', colorName: 'yellow' },
      },
      issuetype: { name: 'Story' },
      priority: { name: 'Medium' },
      updated: '2026-08-07T00:00:00.000-0400',
      assignee: {
        displayName: 'Yunid Bauza',
        emailAddress: 'private@example.com',
        avatarUrls: { '48x48': 'https://example.invalid/a.png' },
      },
    },
  })),
});

const jsonOf = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** A fetch that answers from a queue and records every URL it was given. */
function pages(bodies: unknown[], seen: string[] = []): FetchLike {
  let at = 0;
  return (url) => {
    seen.push(url);
    const body = bodies[Math.min(at, bodies.length - 1)];
    at += 1;
    return Promise.resolve(jsonOf(body));
  };
}

const hundred = (prefix: string): string[] =>
  Array.from({ length: 100 }, (_, i) => `${prefix}-${i + 1}`);

describe('search - the query', () => {
  it('uses the epic default when none is given', async () => {
    const seen: string[] = [];
    await build({
      jira: CONFIGURED,
      env: { JIRA_API_KEY: TOKEN },
      fetch: pages([page(['HIVE-1'])], seen),
    }).search({});

    const url = new URL(seen[0] ?? '');
    expect(url.pathname).toBe('/rest/api/3/search/jql');
    expect(url.searchParams.get('jql')).toBe(
      'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
    );
  });

  it('replaces the default wholesale rather than appending to it', async () => {
    const seen: string[] = [];
    await build({
      jira: CONFIGURED,
      env: { JIRA_API_KEY: TOKEN },
      fetch: pages([page(['HIVE-1'])], seen),
    }).search({ jql: 'project = HIVE' });

    // A user who writes JQL expects their query to be *the* query.
    expect(new URL(seen[0] ?? '').searchParams.get('jql')).toBe(
      'project = HIVE',
    );
  });

  it('always asks for the six fields the card renders', async () => {
    const seen: string[] = [];
    await build({
      jira: CONFIGURED,
      env: { JIRA_API_KEY: TOKEN },
      fetch: pages([page([])], seen),
    }).search({});

    expect(new URL(seen[0] ?? '').searchParams.get('fields')).toBe(
      'summary,status,issuetype,priority,updated,assignee',
    );
  });

  it('refuses before a site is configured, without calling fetch', async () => {
    const result = await build({
      jira: { site: null, email: 'me@example.com' },
    }).search({});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toMatch(/site/i);
  });

  it('refuses with no credential, without calling fetch', async () => {
    const result = await build({ jira: CONFIGURED }).search({});
    expect(!result.ok && result.error.kind).toBe('unauthorized');
  });
});

describe('search - paging', () => {
  it('follows nextPageToken until it is absent', async () => {
    const seen: string[] = [];
    const result = await build({
      jira: CONFIGURED,
      env: { JIRA_API_KEY: TOKEN },
      fetch: pages(
        [page(['A-1', 'A-2'], 'tok-1'), page(['B-1'], 'tok-2'), page(['C-1'])],
        seen,
      ),
    }).search({});

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.issues.map((i) => i.key)).toEqual([
      'A-1',
      'A-2',
      'B-1',
      'C-1',
    ]);
    expect(result.ok && result.value.capped).toBe(false);
    expect(seen).toHaveLength(3);
    expect(new URL(seen[1] ?? '').searchParams.get('nextPageToken')).toBe(
      'tok-1',
    );
    expect(new URL(seen[2] ?? '').searchParams.get('nextPageToken')).toBe(
      'tok-2',
    );
  });

  it('sends no nextPageToken on the first request', async () => {
    const seen: string[] = [];
    await build({
      jira: CONFIGURED,
      env: { JIRA_API_KEY: TOKEN },
      fetch: pages([page(['A-1'])], seen),
    }).search({});

    expect(new URL(seen[0] ?? '').searchParams.has('nextPageToken')).toBe(
      false,
    );
  });

  it('stops at the 200 cap and says that it did', async () => {
    const seen: string[] = [];
    const result = await build({
      jira: CONFIGURED,
      env: { JIRA_API_KEY: TOKEN },
      // Three pages available; the cap stops us after two.
      fetch: pages(
        [
          page(hundred('A'), 'tok-1'),
          page(hundred('B'), 'tok-2'),
          page(hundred('C'), 'tok-3'),
        ],
        seen,
      ),
    }).search({});

    expect(result.ok && result.value.issues).toHaveLength(200);
    expect(result.ok && result.value.capped).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it('leaves capped false when Jira ran out exactly at the cap', async () => {
    const result = await build({
      jira: CONFIGURED,
      env: { JIRA_API_KEY: TOKEN },
      // The second page carries no token: that was all of them.
      fetch: pages([page(hundred('A'), 'tok-1'), page(hundred('B'))]),
    }).search({});

    expect(result.ok && result.value.issues).toHaveLength(200);
    // Not capped: the cap did not stop anything, Jira simply ended.
    expect(result.ok && result.value.capped).toBe(false);
  });

  it('never asks for more than the remaining budget', async () => {
    const seen: string[] = [];
    const fifty = Array.from({ length: 50 }, (_, i) => `B-${i + 1}`);

    await build({
      jira: CONFIGURED,
      env: { JIRA_API_KEY: TOKEN },
      fetch: pages([page(hundred('A'), 't1'), page(fifty, 't2'), page([])], seen),
    }).search({});

    expect(new URL(seen[0] ?? '').searchParams.get('maxResults')).toBe('100');
    expect(new URL(seen[1] ?? '').searchParams.get('maxResults')).toBe('100');
    // 150 collected, 50 of the budget left.
    expect(new URL(seen[2] ?? '').searchParams.get('maxResults')).toBe('50');
  });

  it('treats a missing issues array as an empty page rather than failing', async () => {
    const result = await build({
      jira: CONFIGURED,
      env: { JIRA_API_KEY: TOKEN },
      fetch: pages([{}]),
    }).search({});

    expect(result).toEqual({ ok: true, value: { issues: [], capped: false } });
  });

  it('skips a malformed entry rather than losing the page', async () => {
    const good = page(['A-1', 'A-2']);
    (good.issues as unknown[])[1] = { key: 'A-2' }; // no fields

    const result = await build({
      jira: CONFIGURED,
      env: { JIRA_API_KEY: TOKEN },
      fetch: pages([good]),
    }).search({});

    expect(result.ok && result.value.issues.map((i) => i.key)).toEqual(['A-1']);
  });

  it('reports a mid-paging failure rather than a partial result', async () => {
    let at = 0;
    const fetch: FetchLike = () => {
      at += 1;
      return Promise.resolve(
        at === 1
          ? jsonOf(page(['A-1'], 'tok-1'))
          : new Response('no', { status: 401 }),
      );
    };

    const result = await build({
      jira: CONFIGURED,
      env: { JIRA_API_KEY: TOKEN },
      fetch,
    }).search({});

    // A half-read backlog presented as complete is worse than an error.
    expect(!result.ok && result.error.kind).toBe('unauthorized');
  });
});

describe('search - nothing raw crosses', () => {
  it('drops every Jira field the app did not ask for', async () => {
    const result = await build({
      jira: CONFIGURED,
      env: { JIRA_API_KEY: TOKEN },
      fetch: pages([page(['A-1'])]),
    }).search({});

    const serialised = JSON.stringify(result);
    for (const leaked of [
      'avatarUrls',
      'emailAddress',
      'private@example.com',
      'colorName',
    ]) {
      expect(serialised).not.toContain(leaked);
    }
  });

  it('never contains the token', async () => {
    const result = await build({
      jira: CONFIGURED,
      env: { JIRA_API_KEY: TOKEN },
      fetch: pages([page(['A-1'])]),
    }).search({});

    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe('issue', () => {
  const one = (): unknown => (page(['HIVE-68']).issues as unknown[])[0];

  it('reads one issue by key and maps it', async () => {
    const seen: string[] = [];
    const result = await build({
      jira: CONFIGURED,
      env: { JIRA_API_KEY: TOKEN },
      fetch: pages([one()], seen),
    }).issue({ key: 'HIVE-68' });

    expect(new URL(seen[0] ?? '').pathname).toBe('/rest/api/3/issue/HIVE-68');
    expect(result.ok && result.value.key).toBe('HIVE-68');
    expect(result.ok && result.value.url).toBe(
      `https://${CONFIGURED.site}/browse/HIVE-68`,
    );
  });

  it('asks for the same six fields', async () => {
    const seen: string[] = [];
    await build({
      jira: CONFIGURED,
      env: { JIRA_API_KEY: TOKEN },
      fetch: pages([one()], seen),
    }).issue({ key: 'HIVE-68' });

    expect(new URL(seen[0] ?? '').searchParams.get('fields')).toBe(
      'summary,status,issuetype,priority,updated,assignee',
    );
  });

  it('reports an answer it cannot read, naming the key', async () => {
    const result = await build({
      jira: CONFIGURED,
      env: { JIRA_API_KEY: TOKEN },
      fetch: pages([{ nothing: true }]),
    }).issue({ key: 'HIVE-68' });

    expect(!result.ok && result.error.kind).toBe('unknown');
    expect(!result.ok && result.error.message).toContain('HIVE-68');
  });

  it('passes a 404 through as not-found', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(new Response('gone', { status: 404 }));

    const result = await build({
      jira: CONFIGURED,
      env: { JIRA_API_KEY: TOKEN },
      fetch,
    }).issue({ key: 'HIVE-99999' });

    expect(!result.ok && result.error.kind).toBe('not-found');
  });

  it('refuses before configuration, without calling fetch', async () => {
    const result = await build({ jira: { site: null, email: null } }).issue({
      key: 'HIVE-68',
    });
    expect(result.ok).toBe(false);
  });
});
