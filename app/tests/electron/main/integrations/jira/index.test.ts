// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createJira } from '../../../../../electron/main/integrations/jira';
import type {
  SecretFile,
  SecretStore,
} from '../../../../../electron/main/integrations/jira/auth';
import type { FetchLike } from '../../../../../electron/main/integrations/jira/client';
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
