# HIVE-67 — Jira settings and stored credential: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the app a Jira connection (site, account email) and its first stored secret (an API token held by `safeStorage`), surfaced as two groups in the Integrations settings pane with a working connection test.

**Architecture:** A new `electron/main/integrations/jira/` package — `auth.ts` (the only module that sees the token), `client.ts` (HTTP, injected `fetch`), `index.ts` (the verbs). Site and email are ordinary config and ride the existing guarded config write path; the token is ciphertext in a file under `userData`. The renderer gets four verbs that can write and clear a token and none that reads one.

**Tech Stack:** Electron 43 (`safeStorage`), Node ≥22 (global `fetch`, `AbortSignal.timeout`), TypeScript strict, React 19, Tailwind v4, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-07-hive-67-jira-settings-credential-design.md`

## Global Constraints

- `pnpm lint` and `pnpm type-check` must both pass before any task is done. No rule may be disabled inline.
- `pnpm verify:boundaries` must stay green. `electron/main/**` may not import `src/**`; `src/**` may not import `electron/main/**`; the renderer imports `@shared/*` **type-only**.
- `electron/shared/**` is types and constants only — no runtime imports, no Node APIs, no DOM APIs.
- kebab-case for every file and folder under `src/` and `electron/`.
- Absolute `@/`, `@shared/`, `@components/`, `@features/`, `@lib/`, `@hooks/`, `@stores/` imports. Never `../` parent imports in `src/`. `electron/main/**` uses relative imports to `../../shared/*` (existing convention — see `gh.ts:3`).
- Import order: builtin → external → internal → parent → sibling → index, alphabetised, blank lines between groups.
- `tests/` mirrors the source tree exactly.
- Raw hex literals in component code are banned; colour comes from `--cc-*`-backed Tailwind utilities (`text-ink`, `text-muted`, `text-subtle`, `text-amber`, `text-green`, `text-red`, `bg-panel-2`, `border-border-soft`).
- Icons come from `@phosphor-icons/react` only.
- The environment variable name is exactly `JIRA_API_KEY`.
- The timeout is exactly 10 000 ms. The response-size cap is exactly 256 KiB.
- The config file is `~/.hive/config.json` (overridable by `HIVE_CONFIG_PATH`). Never call it `hive.config.json`.
- No `CONFIG_VERSION` bump. The `jira` block is a new optional top-level key.
- **The token must never appear in any value returned by any IPC verb.** This is the invariant Task 2's deep-scan test exists to guard.

---

### Task 1: The shared contracts and their guards

Everything else in the plan compiles against this task. It ships the type surface and the three input guards, with no behaviour.

**Files:**
- Create: `app/electron/shared/jira-contract.ts`
- Modify: `app/electron/shared/config-contract.ts` (add `JiraConfig`, `DEFAULT_JIRA`, `JIRA_KEYS`, `SetJiraRequest`; add `jira` to `ConfigSnapshot` and `emptySnapshot`)
- Modify: `app/electron/shared/guards.ts` (add `assertJiraSite`, `assertJiraEmail`, `assertJiraToken`, `parseSetJiraRequest`, `parseSetJiraTokenRequest`)
- Test: `app/tests/electron/shared/guards.jira.test.ts`

**Interfaces:**
- Consumes: `assertShape`, `fail`, `describe` (module-private in `guards.ts`).
- Produces: `JiraCredentialState`, `JiraStatus`, `JiraIdentity`, `JiraError`, `JiraResult<T>`, `JIRA_TOKEN_ENV`, `JiraConfig`, `DEFAULT_JIRA`, `JIRA_KEYS`, `SetJiraRequest`, `SetJiraTokenRequest`, and the five guard functions.

- [ ] **Step 1: Write `electron/shared/jira-contract.ts`**

```typescript
/**
 * The Jira integration's contract (HIVE-67).
 *
 * Separate from `ipc-contract.ts` because the epic adds four more stories'
 * worth of Jira types and folding them into the channel registry would make
 * that file about Jira rather than about IPC. Same rules apply: types and
 * constants only, importable from both processes.
 */

/**
 * The variable consulted when nothing is stored.
 *
 * The Linux fallback, and the escape hatch on any machine: `safeStorage`
 * cannot encrypt without an OS keyring, and writing a base64 blob and calling
 * it encrypted would be worse than storing nothing.
 */
export const JIRA_TOKEN_ENV = 'JIRA_API_KEY';

/**
 * Where the credential comes from — never what it is.
 *
 * A discriminated union rather than a bag of booleans because the four cases
 * are mutually exclusive and each one has different copy and different
 * controls. `stored` carries the email so the pane can say whose token it is
 * without a second read.
 */
export type JiraCredentialState =
  | { kind: 'none' }
  | { kind: 'stored'; email: string }
  | { kind: 'env'; variable: typeof JIRA_TOKEN_ENV }
  | { kind: 'unavailable'; reason: string };

/** What `jira:status` answers with. Contains no secret, by construction. */
export interface JiraStatus {
  /** The configured host, or `null`. Never a URL. */
  site: string | null;
  email: string | null;
  credential: JiraCredentialState;
  /**
   * Whether this machine can encrypt at all.
   *
   * Reported beside the union rather than folded into it, because the two
   * answer different questions and can disagree: a Linux box with no keyring
   * but `JIRA_API_KEY` set is `{ kind: 'env' }` *and* cannot store anything.
   */
  encryptionAvailable: boolean;
}

/** Answer to `jira:test` — `GET /rest/api/3/myself`, narrowed to two fields. */
export interface JiraIdentity {
  displayName: string;
  accountId: string;
}

export type JiraErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'offline'
  | 'timeout'
  | 'bad-query'
  | 'unknown';

export interface JiraError {
  kind: JiraErrorKind;
  /** Safe to show. Never contains the token or a raw response body. */
  message: string;
  /** Seconds, from `Retry-After`. Only on `rate-limited`. */
  retryAfter?: number;
}

/**
 * Every Jira verb answers with this rather than throwing across IPC.
 *
 * `gh.ts:166-172`'s rule: the pane must render either way. A section that
 * throws because an external service misbehaved tells the user this app is
 * broken, when the truth is that Jira is unreachable.
 */
export type JiraResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: JiraError };
```

- [ ] **Step 2: Add the config types to `electron/shared/config-contract.ts`**

Insert after the `NOTIFICATION_KEYS` block (around line 168):

```typescript
/**
 * The Jira connection, as the config file declares it (HIVE-67).
 *
 * Site and email only. The API token is a secret and lives in `safeStorage`
 * under `userData` — this file is explicitly hand-editable, which is what
 * makes it the wrong home for a credential.
 */
export interface JiraConfig {
  /**
   * The Atlassian host, e.g. `behiques.atlassian.net`.
   *
   * A bare hostname, never a URL: `client.ts` builds `https://<site>/...` and
   * nothing else, so a scheme or a path stored here would produce a malformed
   * request rather than a cleverer one.
   */
  site: string | null;
  /** The account the API token belongs to. Half of the Basic credential. */
  email: string | null;
}

/** Nothing configured. Both halves are needed before a request can be made. */
export const DEFAULT_JIRA: JiraConfig = { site: null, email: null };

/** The block's keys, for the parser's exact-key check. */
export const JIRA_KEYS: readonly (keyof JiraConfig)[] = ['site', 'email'];
```

Add to `ConfigSnapshot`, after `notifications`:

```typescript
  /**
   * The Jira connection, always fully resolved (HIVE-67).
   *
   * Defaulted here for the same reason `notifications` is: a consumer that had
   * to remember to apply defaults is one that will eventually forget on one
   * branch.
   */
  jira: JiraConfig;
```

Add to `emptySnapshot`'s returned object, after `notifications`:

```typescript
    jira: { ...DEFAULT_JIRA },
```

Add near the other request types:

```typescript
/**
 * Payload of `config:set-jira` (HIVE-67).
 *
 * `null` clears a field and is distinct from absent, following
 * {@link SetProjectRuntimeRequest}: without it the UI could set a site but
 * never take it back, and an emptied field would have to be stored as `""`.
 */
export interface SetJiraRequest {
  site?: string | null;
  email?: string | null;
}

/** Payload of `jira:set-token` (HIVE-67). The one verb that carries a secret. */
export interface SetJiraTokenRequest {
  token: string;
}
```

- [ ] **Step 3: Write the failing guard tests**

Create `app/tests/electron/shared/guards.jira.test.ts`:

```typescript
// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  IpcValidationError,
  parseSetJiraRequest,
  parseSetJiraTokenRequest,
} from '../../../electron/shared/guards';

/**
 * The Jira payload guards (HIVE-67).
 *
 * The site guard is the only thing standing between a renderer payload and the
 * URL a credential is attached to, so its rejections are tested as carefully as
 * its acceptances.
 */

const refuses = (run: () => unknown, match: RegExp): void => {
  expect(run).toThrow(IpcValidationError);
  expect(run).toThrow(match);
};

describe('parseSetJiraRequest — site', () => {
  it('accepts a bare hostname', () => {
    expect(parseSetJiraRequest({ site: 'behiques.atlassian.net' })).toEqual({
      site: 'behiques.atlassian.net',
    });
  });

  it('strips a pasted https:// prefix and a trailing slash', () => {
    expect(
      parseSetJiraRequest({ site: 'https://behiques.atlassian.net/' }),
    ).toEqual({ site: 'behiques.atlassian.net' });
  });

  it('lower-cases the host, so two configs cannot differ by case alone', () => {
    expect(parseSetJiraRequest({ site: 'Behiques.Atlassian.NET' })).toEqual({
      site: 'behiques.atlassian.net',
    });
  });

  it('refuses http://, which would downgrade the transport', () => {
    refuses(
      () => parseSetJiraRequest({ site: 'http://behiques.atlassian.net' }),
      /https/,
    );
  });

  it('refuses a path — the client appends its own', () => {
    refuses(
      () => parseSetJiraRequest({ site: 'behiques.atlassian.net/rest' }),
      /site/,
    );
  });

  it('refuses a port', () => {
    refuses(
      () => parseSetJiraRequest({ site: 'behiques.atlassian.net:8080' }),
      /site/,
    );
  });

  it('refuses userinfo, which is how a host gets impersonated', () => {
    refuses(
      () => parseSetJiraRequest({ site: 'evil.example@behiques.atlassian.net' }),
      /site/,
    );
  });

  it('refuses whitespace and a single label', () => {
    refuses(() => parseSetJiraRequest({ site: 'a b.net' }), /site/);
    refuses(() => parseSetJiraRequest({ site: 'localhost' }), /site/);
  });

  it('accepts null, which clears the field', () => {
    expect(parseSetJiraRequest({ site: null })).toEqual({ site: null });
  });
});

describe('parseSetJiraRequest — email', () => {
  it('accepts an ordinary address', () => {
    expect(parseSetJiraRequest({ email: 'a@b.co' })).toEqual({
      email: 'a@b.co',
    });
  });

  it('refuses a colon, which would move the Basic-auth separator', () => {
    refuses(() => parseSetJiraRequest({ email: 'a:b@c.co' }), /email/);
  });

  it('refuses whitespace, no @, and two @', () => {
    refuses(() => parseSetJiraRequest({ email: 'a b@c.co' }), /email/);
    refuses(() => parseSetJiraRequest({ email: 'abc.co' }), /email/);
    refuses(() => parseSetJiraRequest({ email: 'a@b@c.co' }), /email/);
  });

  it('accepts null', () => {
    expect(parseSetJiraRequest({ email: null })).toEqual({ email: null });
  });
});

describe('parseSetJiraRequest — shape', () => {
  it('refuses an unknown key', () => {
    refuses(() => parseSetJiraRequest({ token: 'x' }), /unexpected key/);
  });

  it('refuses an empty request', () => {
    refuses(() => parseSetJiraRequest({}), /nothing to change/);
  });

  it('refuses a forbidden key', () => {
    refuses(
      () => parseSetJiraRequest(JSON.parse('{"__proto__": {}}')),
      /forbidden key/,
    );
  });

  it('keeps absent distinct from null', () => {
    expect(parseSetJiraRequest({ site: 'a.b.co' })).not.toHaveProperty('email');
  });
});

describe('parseSetJiraTokenRequest', () => {
  it('accepts a printable token', () => {
    expect(parseSetJiraTokenRequest({ token: 'ATATT3xFfGF0=abc' })).toEqual({
      token: 'ATATT3xFfGF0=abc',
    });
  });

  it('refuses empty, oversized, whitespace and control characters', () => {
    refuses(() => parseSetJiraTokenRequest({ token: '' }), /token/);
    refuses(
      () => parseSetJiraTokenRequest({ token: 'x'.repeat(1025) }),
      /token/,
    );
    refuses(() => parseSetJiraTokenRequest({ token: 'ab cd' }), /token/);
    refuses(() => parseSetJiraTokenRequest({ token: 'ab\ncd' }), /token/);
  });

  it('never echoes the value it refused', () => {
    const secret = 'sup3rsecret!'.repeat(200);
    try {
      parseSetJiraTokenRequest({ token: secret });
      expect.unreachable('should have refused');
    } catch (cause) {
      expect(String(cause)).not.toContain('sup3rsecret');
    }
  });

  it('requires the key', () => {
    refuses(() => parseSetJiraTokenRequest({}), /missing key/);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm vitest run tests/electron/shared/guards.jira.test.ts`
Expected: FAIL — `parseSetJiraRequest` is not exported.

- [ ] **Step 5: Add the guards to `electron/shared/guards.ts`**

Import the new types at the top (`JIRA_KEYS` is not needed here; `SetJiraRequest` and `SetJiraTokenRequest` are). Add near `parseSetNotificationsRequest`:

```typescript
/** RFC-1123 label. No leading or trailing hyphen. */
const HOST_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** The DNS limit. Generous for an Atlassian host, and finite, which is the point. */
const MAX_HOST = 253;

/**
 * The Atlassian host, as a bare hostname (HIVE-67).
 *
 * **The one guard whose output is interpolated into a URL a credential is
 * attached to.** A host taken from a payload unchecked is the difference
 * between an integration and a credential-exfiltration primitive, so this
 * rejects rather than encodes: no scheme survives, no path, no port, no
 * userinfo, no whitespace.
 *
 * A pasted `https://…/` is stripped rather than refused, because copying the
 * URL out of the browser is what everyone will actually do and refusing it
 * teaches nothing. `http://` is refused outright — silently upgrading it would
 * accept a request the user did not make, and honouring it would downgrade the
 * transport a credential rides on.
 *
 * The result is lower-cased. Hostnames are case-insensitive, and normalising
 * here means two configs cannot differ only by case.
 */
export function assertJiraSite(value: unknown, label: string): string {
  const raw = assertString(value, label).trim();
  if (raw.length === 0) return fail(`${label}: must not be empty`);
  if (/^http:\/\//i.test(raw)) {
    return fail(`${label}: must be https — drop the http:// prefix`);
  }

  const stripped = raw.replace(/^https:\/\//i, '').replace(/\/+$/, '');
  if (stripped.length === 0 || stripped.length > MAX_HOST) {
    return fail(`${label}: expected a hostname`);
  }

  const labels = stripped.split('.');
  if (labels.length < 2) {
    return fail(`${label}: expected a hostname like example.atlassian.net`);
  }
  for (const part of labels) {
    if (!HOST_LABEL.test(part)) {
      return fail(
        `${label}: expected a hostname — no scheme, path, port or credentials`,
      );
    }
  }
  return stripped.toLowerCase();
}

/** The address half of a Basic credential. Bounded, and colon-free. */
const MAX_EMAIL = 320;

/**
 * The account email (HIVE-67).
 *
 * Deliberately not an RFC-5322 parser — this checks the properties that matter
 * where the value is used, and lets Jira be the authority on whether the
 * address exists. A **colon is refused** because this string appears before the
 * separator in `email:token`, and one inside it would silently move the
 * boundary of the credential.
 */
export function assertJiraEmail(value: unknown, label: string): string {
  const email = assertText(value, label);
  if (email.length > MAX_EMAIL) return fail(`${label}: too long`);
  if (email.includes(':')) return fail(`${label}: must not contain a colon`);
  if (/\s/.test(email)) return fail(`${label}: must not contain whitespace`);

  const parts = email.split('@');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return fail(`${label}: expected an address like you@example.com`);
  }
  return email;
}

/** Atlassian tokens are ~192 characters. This is generous and finite. */
const MAX_TOKEN = 1024;

/**
 * The API token (HIVE-67).
 *
 * Printable ASCII with no space, which is what a base64-ish Atlassian token
 * is. The refusal names the field and **never echoes the value** — a guard
 * whose error message contains the secret it rejected has leaked it into every
 * log that catches the throw.
 */
export function assertJiraToken(value: unknown, label: string): string {
  const token = assertString(value, label);
  if (token.length === 0) return fail(`${label}: must not be empty`);
  if (token.length > MAX_TOKEN) return fail(`${label}: too long`);
  for (const char of token) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x21 || code > 0x7e) {
      return fail(`${label}: expected printable ASCII with no spaces`);
    }
  }
  return token;
}

/**
 * The Jira connection settings (HIVE-67).
 *
 * `null` is accepted and distinct from absent — it clears the field — the same
 * three-state shape {@link parseSetProjectRuntimeRequest} uses and for the same
 * reason.
 */
export function parseSetJiraRequest(input: unknown): SetJiraRequest {
  const raw = assertShape(input, [], 'setJira', ['site', 'email']);

  const request: SetJiraRequest = {
    ...(raw.site !== undefined
      ? {
          site:
            raw.site === null ? null : assertJiraSite(raw.site, 'setJira.site'),
        }
      : {}),
    ...(raw.email !== undefined
      ? {
          email:
            raw.email === null
              ? null
              : assertJiraEmail(raw.email, 'setJira.email'),
        }
      : {}),
  };

  if (Object.keys(request).length === 0) {
    return fail('setJira: nothing to change');
  }
  return request;
}

/** The token, on its way to `safeStorage`. The only payload carrying a secret. */
export function parseSetJiraTokenRequest(
  input: unknown,
): SetJiraTokenRequest {
  const raw = assertShape(input, ['token'], 'setJiraToken');
  return { token: assertJiraToken(raw.token, 'setJiraToken.token') };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run tests/electron/shared/guards.jira.test.ts`
Expected: PASS, all cases.

- [ ] **Step 7: Type-check, lint, boundaries**

Run: `pnpm type-check && pnpm lint && pnpm verify:boundaries`
Expected: `ConfigSnapshot.jira` is now required, so every place that builds a snapshot literal fails to compile. Fix each by adding `jira: { ...DEFAULT_JIRA }` — `emptySnapshot` covers most, and test fixtures that hand-assemble a snapshot are the rest. Search with `rg -l 'notifications: \{' app/tests app/src app/electron`.

- [ ] **Step 8: Commit**

```bash
git add electron/shared/jira-contract.ts electron/shared/config-contract.ts electron/shared/guards.ts tests/electron/shared/guards.jira.test.ts
git commit -m "feat(jira): the shared contract and its input guards (HIVE-67)"
```

---

### Task 2: `auth.ts` — the only module that sees the token

**Files:**
- Create: `app/electron/main/integrations/jira/auth.ts`
- Test: `app/tests/electron/main/integrations/jira/auth.test.ts`

**Interfaces:**
- Consumes: `JiraCredentialState`, `JIRA_TOKEN_ENV` from Task 1.
- Produces: `SecretStore`, `SecretFile`, `JiraAuth`, `createJiraAuth`, `fileSecretStore(path)`.

- [ ] **Step 1: Write the failing test**

Create `app/tests/electron/main/integrations/jira/auth.test.ts`:

```typescript
// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  createJiraAuth,
  type SecretFile,
  type SecretStore,
} from '../../../../../electron/main/integrations/jira/auth';

/**
 * The credential (HIVE-67).
 *
 * Both dependencies are injected — `safeStorage` because a test that touched a
 * real keychain would answer differently on every machine and prompt on some,
 * and the file because what is worth testing is the decision logic, not
 * `writeFileSync`.
 */

const TOKEN = 'ATATT-not-a-real-token-9f3c';

/** A store that "encrypts" by tagging, so a test can tell cipher from plain. */
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

/** An in-memory ciphertext file. */
function file(initial: Buffer | null = null): SecretFile & { bytes: Buffer | null } {
  const seam = {
    bytes: initial,
    read: () => seam.bytes,
    write: (next: Buffer) => {
      seam.bytes = next;
    },
    clear: () => {
      seam.bytes = null;
    },
  };
  return seam;
}

describe('credential state', () => {
  it('is none with nothing stored, no env var and working encryption', () => {
    const auth = createJiraAuth({ store: store(), file: file(), env: {} });
    expect(auth.state(null)).toEqual({ kind: 'none' });
    expect(auth.encryptionAvailable()).toBe(true);
  });

  it('is stored, carrying the configured email, once a token is saved', () => {
    const auth = createJiraAuth({ store: store(), file: file(), env: {} });
    auth.save(TOKEN);
    expect(auth.state('me@example.com')).toEqual({
      kind: 'stored',
      email: 'me@example.com',
    });
  });

  it('is env when JIRA_API_KEY is set and nothing is stored', () => {
    const auth = createJiraAuth({
      store: store(),
      file: file(),
      env: { JIRA_API_KEY: TOKEN },
    });
    expect(auth.state(null)).toEqual({ kind: 'env', variable: 'JIRA_API_KEY' });
  });

  it('treats an exported-but-empty variable as unset', () => {
    const auth = createJiraAuth({
      store: store(),
      file: file(),
      env: { JIRA_API_KEY: '   ' },
    });
    expect(auth.state(null)).toEqual({ kind: 'none' });
  });

  it('prefers a stored token over the environment', () => {
    const auth = createJiraAuth({
      store: store(),
      file: file(),
      env: { JIRA_API_KEY: 'from-env' },
    });
    auth.save(TOKEN);
    expect(auth.state('me@example.com').kind).toBe('stored');
    expect(auth.token()).toBe(TOKEN);
  });

  it('is unavailable, with a reason, when encryption is off and no env var is set', () => {
    const auth = createJiraAuth({
      store: store(false),
      file: file(),
      env: {},
    });
    const state = auth.state(null);
    expect(state.kind).toBe('unavailable');
    expect(state.kind === 'unavailable' && state.reason).toMatch(/keyring/i);
    expect(auth.encryptionAvailable()).toBe(false);
  });

  it('is env — not unavailable — when encryption is off but the variable is set', () => {
    const auth = createJiraAuth({
      store: store(false),
      file: file(),
      env: { JIRA_API_KEY: TOKEN },
    });
    expect(auth.state(null)).toEqual({ kind: 'env', variable: 'JIRA_API_KEY' });
    expect(auth.encryptionAvailable()).toBe(false);
    expect(auth.token()).toBe(TOKEN);
  });

  it('is none, not stored, when the ciphertext will not decrypt', () => {
    const auth = createJiraAuth({
      store: store(),
      file: file(Buffer.from('garbage', 'utf8')),
      env: {},
    });
    expect(auth.state('me@example.com')).toEqual({ kind: 'none' });
    expect(auth.token()).toBeNull();
  });
});

describe('writing and clearing', () => {
  it('refuses to write when encryption is unavailable, storing nothing', () => {
    const seam = file();
    const auth = createJiraAuth({ store: store(false), file: seam, env: {} });
    expect(() => auth.save(TOKEN)).toThrow(/encrypt/i);
    expect(seam.bytes).toBeNull();
  });

  it('writes ciphertext, never the plaintext token', () => {
    const seam = file();
    const auth = createJiraAuth({ store: store(), file: seam, env: {} });
    auth.save(TOKEN);
    expect(seam.bytes?.toString('utf8')).not.toContain(TOKEN);
    expect(seam.bytes?.toString('utf8')).toBe(`enc:${TOKEN}`);
  });

  it('clear removes the file and drops back to none', () => {
    const seam = file();
    const auth = createJiraAuth({ store: store(), file: seam, env: {} });
    auth.save(TOKEN);
    auth.clear();
    expect(seam.bytes).toBeNull();
    expect(auth.state('me@example.com')).toEqual({ kind: 'none' });
  });

  it('clear falls back to the environment rather than to none', () => {
    const auth = createJiraAuth({
      store: store(),
      file: file(),
      env: { JIRA_API_KEY: TOKEN },
    });
    auth.save('stored-one');
    auth.clear();
    expect(auth.state(null)).toEqual({ kind: 'env', variable: 'JIRA_API_KEY' });
  });
});

/**
 * The test that guards the security property rather than a behaviour.
 *
 * A future field that "just includes the config" would pass every behavioural
 * test above and fail this one, which is exactly why it is written as a blunt
 * deep scan of the serialised value instead of an assertion about known keys.
 */
describe('the token never leaves', () => {
  it('does not appear anywhere in the serialised state, in any case', () => {
    for (const env of [{}, { JIRA_API_KEY: TOKEN }]) {
      const auth = createJiraAuth({ store: store(), file: file(), env });
      auth.save(TOKEN);
      for (const email of [null, 'me@example.com']) {
        const serialised = JSON.stringify(auth.state(email));
        expect(serialised).not.toContain(TOKEN);
        expect(serialised).not.toContain('ATATT');
      }
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/electron/main/integrations/jira/auth.test.ts`
Expected: FAIL — cannot resolve `.../jira/auth`.

- [ ] **Step 3: Write `electron/main/integrations/jira/auth.ts`**

```typescript
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import {
  JIRA_TOKEN_ENV,
  type JiraCredentialState,
} from '../../../shared/jira-contract';

/**
 * The Jira credential (HIVE-67) — the only module in the app that ever sees a
 * token.
 *
 * ## Why this app stores a secret when `gh.ts` refuses to
 *
 * `gh.ts` stores no token, and its header says why: nothing read one, so it
 * would have been "a credential no code reads, living in a plaintext file the
 * product encourages the user to hand-edit."
 *
 * Both halves stop being true here. Something reads this one — the WORK tab —
 * and it is not going in `~/.hive/config.json`. That file is deliberately
 * hand-editable: `HIVE_CONFIG_PATH` relocates it, story 107 shipped a verb that
 * reveals it in the file manager, and `config-contract.ts` keeps an
 * `UNSAFE_ENV_KEYS` deny-list precisely because users edit it. So the token goes
 * to `safeStorage`, which encrypts against a key the OS holds — Keychain,
 * DPAPI, libsecret — and the ciphertext lives in its own file under `userData`.
 *
 * ## Why both dependencies are injected
 *
 * The same reason `gh.ts` takes its `RunCommand` (gh.ts:49-58): what is worth
 * testing is the decision logic, and a unit test that reached a real keychain
 * would answer differently on every machine and prompt for a password on some.
 *
 * ## What never happens here
 *
 * {@link JiraAuth.token} is main-internal. No IPC verb returns it, no channel
 * carries it, and `state()` is built from names and kinds rather than from
 * anything the token touched. The unit test asserts that by deep-scanning the
 * serialised state, because it is the invariant most easily lost in a refactor.
 */

/** The slice of Electron's `safeStorage` this module uses. */
export interface SecretStore {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

/** The ciphertext file, as a seam. */
export interface SecretFile {
  /** The bytes, or `null` when there is no file. Never throws on ENOENT. */
  read(): Buffer | null;
  write(bytes: Buffer): void;
  clear(): void;
}

export interface JiraAuth {
  /** What to tell the renderer. Never contains the token. */
  state(email: string | null): JiraCredentialState;
  /** Whether this machine can encrypt at all. Distinct from the state. */
  encryptionAvailable(): boolean;
  /** **Main-internal.** There is no IPC verb that reaches this. */
  token(): string | null;
  /** Throws when encryption is unavailable, rather than writing plaintext. */
  save(token: string): void;
  clear(): void;
}

/**
 * Why the reason is a sentence and not a code.
 *
 * The only realistic reader is a Linux user whose session has no keyring, and
 * the actionable half of that sentence is the variable name.
 */
const NO_ENCRYPTION =
  `This system has no keyring available to encrypt with, so no token can be ` +
  `stored. Set ${JIRA_TOKEN_ENV} in this app's environment instead.`;

export function createJiraAuth(deps: {
  store: SecretStore;
  file: SecretFile;
  env: NodeJS.ProcessEnv;
}): JiraAuth {
  const { store, file, env } = deps;

  /**
   * Presence only, never the value, for the *state* answer.
   *
   * An exported-but-empty variable reads as unset — the same false positive
   * `gh.ts:96-107` avoids on a very common shell-profile pattern.
   */
  const envToken = (): string | null => {
    const value = env[JIRA_TOKEN_ENV];
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  };

  const stored = (): string | null => {
    const bytes = file.read();
    if (bytes === null) return null;
    try {
      return store.decryptString(bytes);
    } catch {
      /**
       * Ciphertext this machine cannot read — a copied `userData`, a rotated
       * OS key, a truncated write. Reported as *no credential* rather than as
       * an error: the user's fix is to paste the token again, which is exactly
       * what the `none` state offers, and an error banner would send them
       * looking for a problem they cannot solve.
       */
      return null;
    }
  };

  return {
    encryptionAvailable: () => store.isEncryptionAvailable(),

    token: () => stored() ?? envToken(),

    state(email) {
      if (stored() !== null) {
        return { kind: 'stored', email: email ?? '' };
      }
      if (envToken() !== null) {
        return { kind: 'env', variable: JIRA_TOKEN_ENV };
      }
      // Only interesting when there is no credential at all. A machine that
      // cannot encrypt but has the variable set is an `env` machine that also
      // gets `encryptionAvailable: false` — see the contract.
      if (!store.isEncryptionAvailable()) {
        return { kind: 'unavailable', reason: NO_ENCRYPTION };
      }
      return { kind: 'none' };
    },

    save(token) {
      // Refusing is the correct behaviour. Writing a base64 blob and calling it
      // encrypted would be worse than storing nothing, because the user would
      // believe it was protected.
      if (!store.isEncryptionAvailable()) throw new Error(NO_ENCRYPTION);
      file.write(store.encryptString(token));
    },

    clear() {
      file.clear();
    },
  };
}

/**
 * The real file seam.
 *
 * `0600` at creation and re-asserted on every write: the ciphertext is useless
 * without the OS key, but a world-readable secrets file is the kind of thing
 * that outlives the reasoning behind it.
 */
export function credentialFile(path: string): SecretFile {
  return {
    read() {
      try {
        return readFileSync(path);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw cause;
      }
    },
    write(bytes) {
      writeFileSync(path, bytes, { mode: 0o600 });
      chmodSync(path, 0o600);
    },
    clear() {
      rmSync(path, { force: true });
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/electron/main/integrations/jira/auth.test.ts`
Expected: PASS, 13 cases.

- [ ] **Step 5: Commit**

```bash
git add electron/main/integrations/jira/auth.ts tests/electron/main/integrations/jira/auth.test.ts
git commit -m "feat(jira): safeStorage-backed credential, with the token never escaping main (HIVE-67)"
```

---

### Task 3: `client.ts` — the first HTTP call in main

**Files:**
- Create: `app/electron/main/integrations/jira/client.ts`
- Test: `app/tests/electron/main/integrations/jira/client.test.ts`

**Interfaces:**
- Consumes: `JiraResult`, `JiraError`, `JiraErrorKind` from Task 1.
- Produces: `FetchLike`, `JiraCredential`, `JiraClient`, `createJiraClient`, `JIRA_TIMEOUT_MS`, `MAX_RESPONSE_BYTES`.

- [ ] **Step 1: Write the failing test**

Create `app/tests/electron/main/integrations/jira/client.test.ts`:

```typescript
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
 * how a failure is *named* — both of which must be identical on every machine.
 */

const TOKEN = 'ATATT-not-a-real-token-9f3c';
const CREDENTIAL = { email: 'me@example.com', token: TOKEN };

/** A fetch that answers with one response and records what it was asked. */
function responder(
  response: Response | Error,
  seen: { url: string; init: RequestInit }[] = [],
): FetchLike {
  return (url, init) => {
    seen.push({ url, init });
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response);
  };
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const client = (fetch: FetchLike) =>
  createJiraClient({ fetch, site: 'behiques.atlassian.net', credential: CREDENTIAL });

describe('the request', () => {
  it('builds the URL from the configured host and the caller path', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    await client(responder(json({}), seen)).get('/rest/api/3/myself');
    expect(seen[0]?.url).toBe('https://behiques.atlassian.net/rest/api/3/myself');
  });

  it('sends Basic auth built from email and token', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    await client(responder(json({}), seen)).get('/rest/api/3/myself');
    const headers = new Headers(seen[0]?.init.headers);
    expect(headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`${CREDENTIAL.email}:${TOKEN}`).toString('base64')}`,
    );
    expect(headers.get('accept')).toBe('application/json');
  });

  it('attaches an abort signal, so a hung Jira cannot hang the pane', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    await client(responder(json({}), seen)).get('/rest/api/3/myself');
    expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal);
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
  ];

  for (const [status, kind] of cases) {
    it(`maps ${status} to ${kind}`, async () => {
      const result = await client(
        responder(new Response('nope', { status })),
      ).get('/rest/api/3/myself');
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.kind).toBe(kind);
    });
  }

  it('reads Retry-After on 429', async () => {
    const result = await client(
      responder(new Response('slow down', { status: 429, headers: { 'retry-after': '17' } })),
    ).get('/rest/api/3/myself');
    expect(!result.ok && result.error.retryAfter).toBe(17);
  });

  it('maps a rejected fetch to offline', async () => {
    const result = await client(responder(new TypeError('fetch failed'))).get(
      '/rest/api/3/myself',
    );
    expect(!result.ok && result.error.kind).toBe('offline');
  });

  it('maps an aborted fetch to timeout', async () => {
    const abort = new DOMException('The operation was aborted.', 'TimeoutError');
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

  it('names unparseable JSON without quoting it', async () => {
    const result = await client(
      responder(new Response('<html>nginx</html>', { status: 200 })),
    ).get('/rest/api/3/myself');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).not.toContain('nginx');
  });
});

describe('nothing leaks', () => {
  it('keeps the token and the response body out of every error message', async () => {
    for (const status of [401, 403, 404, 429, 400, 500]) {
      const body = `denied for ${TOKEN} — internal detail`;
      const result = await client(
        responder(new Response(body, { status })),
      ).get('/rest/api/3/myself');
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
});

describe('timeout wiring', () => {
  it('uses a 10 second budget', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await client(responder(json({}))).get('/rest/api/3/myself');
    expect(spy).toHaveBeenCalledWith(10_000);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/electron/main/integrations/jira/client.test.ts`
Expected: FAIL — cannot resolve `.../jira/client`.

- [ ] **Step 3: Write `electron/main/integrations/jira/client.ts`**

```typescript
import type {
  JiraError,
  JiraErrorKind,
  JiraResult,
} from '../../../shared/jira-contract';

/**
 * The Jira HTTP client (HIVE-67) — the first outbound request anywhere in
 * `electron/main`.
 *
 * ## What replaces `gh.ts`'s "argv is a constant"
 *
 * `gh.ts`'s strongest rule is that its IPC verb takes no payload at all, so
 * nothing from the renderer can reach an argument. That cannot hold for an
 * integration whose whole job is to run the user's query, so it is replaced by
 * rules that hold instead:
 *
 * 1. **The host is fixed from the configured site**, passed once at
 *    construction and never taken from a call. A renderer cannot aim this
 *    client at a different server, which is what would turn it into a
 *    credential-exfiltration primitive.
 * 2. **The path is a literal from this codebase.** Callers pass a constant;
 *    anything interpolated into one is validated first, by the guards.
 * 3. **Bounded**, like every external call in this app: an abort signal and a
 *    response-size cap, because a hung Jira must not hang the settings pane and
 *    an unbounded body must not become unbounded memory.
 * 4. **No raw output escapes.** Every message here is composed from a status
 *    code and a fixed string. The response body is never quoted and the token
 *    is never interpolated — an error is the easiest place in an integration to
 *    leak a credential into a log.
 *
 * HIVE-68 adds `searchJql`, `readIssue`, retries and pagination on top of this
 * same request path. It does not get to relax any of the four.
 */

/** Matching `gh.ts`'s posture of bounding every external call. */
export const JIRA_TIMEOUT_MS = 10_000;

/** 256 KiB. `/myself` is a few hundred bytes; this is already generous. */
export const MAX_RESPONSE_BYTES = 256 * 1024;

/** Injected so no test touches the network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface JiraCredential {
  email: string;
  token: string;
}

export interface JiraClient {
  get<T>(path: string): Promise<JiraResult<T>>;
}

const error = (
  kind: JiraErrorKind,
  message: string,
  retryAfter?: number,
): JiraResult<never> => ({
  ok: false,
  error: { kind, message, ...(retryAfter === undefined ? {} : { retryAfter }) },
});

/**
 * Status to kind, and the sentence the pane shows.
 *
 * Written as a function rather than a lookup because 4xx and 5xx need
 * different defaults, and because each message is specific enough to tell the
 * user what to *do*, which a generic "request failed" never is.
 */
function fromStatus(status: number, retryAfter?: number): JiraResult<never> {
  if (status === 401) {
    return error(
      'unauthorized',
      'Jira rejected the credential. The token may be wrong, revoked, or issued for a different account.',
    );
  }
  if (status === 403) {
    return error(
      'forbidden',
      'Jira accepted the credential but refused the request. The account is authenticated but not permitted.',
    );
  }
  if (status === 404) {
    return error(
      'not-found',
      'Jira answered but had nothing at that address. Check the site name.',
    );
  }
  if (status === 429) {
    return error('rate-limited', 'Jira is rate-limiting this app.', retryAfter);
  }
  if (status === 400) {
    return error('bad-query', 'Jira could not understand the request.');
  }
  return error('unknown', `Jira answered with ${status}.`);
}

/** `Retry-After` in seconds. A date form is ignored rather than guessed at. */
function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export function createJiraClient(deps: {
  fetch: FetchLike;
  /** A bare hostname, already validated by `assertJiraSite`. */
  site: string;
  credential: JiraCredential;
}): JiraClient {
  const { fetch, site, credential } = deps;

  // Built once, here and nowhere else. The only place the two halves of the
  // credential are ever joined.
  const authorization = `Basic ${Buffer.from(
    `${credential.email}:${credential.token}`,
    'utf8',
  ).toString('base64')}`;

  return {
    async get<T>(path: string): Promise<JiraResult<T>> {
      let response: Response;
      try {
        response = await fetch(`https://${site}${path}`, {
          method: 'GET',
          headers: { authorization, accept: 'application/json' },
          signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
        });
      } catch (cause) {
        /**
         * The cause is never included in the message.
         *
         * A rejected `fetch` carries a message this code did not compose, and
         * an integration is the last place that should paste an unknown string
         * into a surface — the token appears in the URL of no request this
         * client makes, but "probably safe" is not the standard for a
         * credential.
         */
        const aborted =
          cause instanceof Error &&
          (cause.name === 'TimeoutError' || cause.name === 'AbortError');
        return aborted
          ? error('timeout', 'Jira did not answer within ten seconds.')
          : error('offline', 'Could not reach Jira. The network may be down.');
      }

      if (!response.ok) {
        return fromStatus(response.status, retryAfterSeconds(response));
      }

      const declared = Number.parseInt(
        response.headers.get('content-length') ?? '',
        10,
      );
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        return error('unknown', "Jira's answer was too large to read.");
      }

      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        return error('unknown', "Jira's answer was too large to read.");
      }

      try {
        return { ok: true, value: JSON.parse(text) as T };
      } catch {
        // The body is not quoted. A proxy's HTML error page is the common case
        // here, and pasting it into the settings pane helps nobody.
        return error('unknown', 'Jira answered with something that was not JSON.');
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/electron/main/integrations/jira/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/main/integrations/jira/client.ts tests/electron/main/integrations/jira/client.test.ts
git commit -m "feat(jira): bounded HTTP client with a typed error union (HIVE-67)"
```

---

### Task 4: The `jira` block in the config file

**Files:**
- Modify: `app/electron/main/config/parse.ts` (add `'jira'` to `TOP_LEVEL_KEYS`, add `ParsedConfig.jira`, add `optionalJira()`, call it in `parseConfig`)
- Modify: `app/electron/main/config/index.ts` (resolve `jira` in `loadConfig`, add `setJira`)
- Test: `app/tests/electron/main/config/jira.test.ts`

**Interfaces:**
- Consumes: `JiraConfig`, `DEFAULT_JIRA`, `JIRA_KEYS`, `SetJiraRequest` from Task 1.
- Produces: `setJira(request: SetJiraRequest): ConfigSnapshot` from `electron/main/config/index.ts`; `ConfigSnapshot.jira` is populated.

- [ ] **Step 1: Write the failing test**

Create `app/tests/electron/main/config/jira.test.ts`. Model the harness on the existing `tests/electron/main/config/set-notifications.test.ts` — read it first and reuse its temp-config setup verbatim rather than inventing a second one.

```typescript
// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../../../electron/main/config/parse';

/**
 * The `jira` block (HIVE-67).
 *
 * Same treatment `notifications` gets (story 106): listed as a known top-level
 * key so a hand-written block is read rather than reported, partial when the
 * file names only one field, and costing only itself when it is malformed.
 */

const doc = (body: Record<string, unknown>): string =>
  JSON.stringify({ version: 2, ...body });

describe('parseConfig — jira', () => {
  it('is undefined when the file has no block', () => {
    expect(parseConfig(doc({}), 'config').jira).toBeUndefined();
  });

  it('reads both fields', () => {
    const parsed = parseConfig(
      doc({ jira: { site: 'behiques.atlassian.net', email: 'me@example.com' } }),
      'config',
    );
    expect(parsed.jira).toEqual({
      site: 'behiques.atlassian.net',
      email: 'me@example.com',
    });
    expect(parsed.errors).toEqual([]);
  });

  it('is partial when the file names only one field', () => {
    const parsed = parseConfig(doc({ jira: { site: 'a.b.net' } }), 'config');
    expect(parsed.jira).toEqual({ site: 'a.b.net' });
  });

  it('does not report the block as an unknown top-level key', () => {
    const parsed = parseConfig(doc({ jira: { site: 'a.b.net' } }), 'config');
    expect(parsed.errors.join(' ')).not.toMatch(/unknown/i);
    expect(parsed.fatal).toBe(false);
  });

  it('reports a non-object block and ignores it, keeping the rest of the file', () => {
    const parsed = parseConfig(doc({ jira: 'nope', shell: '/bin/zsh' }), 'config');
    expect(parsed.jira).toBeUndefined();
    expect(parsed.shell).toBe('/bin/zsh');
    expect(parsed.errors.join(' ')).toMatch(/jira/);
    expect(parsed.fatal).toBe(false);
  });

  it('reports a non-string field and skips it rather than the block', () => {
    const parsed = parseConfig(
      doc({ jira: { site: 7, email: 'me@example.com' } }),
      'config',
    );
    expect(parsed.jira).toEqual({ email: 'me@example.com' });
    expect(parsed.errors.join(' ')).toMatch(/jira\.site/);
  });

  it('costs only the block when it carries a forbidden key', () => {
    const parsed = parseConfig(
      `{"version":2,"shell":"/bin/zsh","jira":{"__proto__":{}}}`,
      'config',
    );
    expect(parsed.jira).toBeUndefined();
    expect(parsed.shell).toBe('/bin/zsh');
    expect(parsed.fatal).toBe(false);
  });

  it('reports an unknown key inside the block', () => {
    const parsed = parseConfig(doc({ jira: { token: 'nope' } }), 'config');
    expect(parsed.errors.join(' ')).toMatch(/jira/);
  });
});
```

Then extend it with a `setJira` describe block using the same temp-file harness `set-notifications.test.ts` uses, asserting:

```typescript
describe('setJira', () => {
  it('writes only the fields the request names', () => {
    // seed a config with jira.site set, call setJira({ email }),
    // re-read the file and assert site survived.
  });

  it('preserves an unknown sibling key inside the block', () => {
    // seed { jira: { site: 'a.b.net', future: 1 } }, call setJira({ email }),
    // assert `future` is still on disk — the block is spread, never rebuilt.
  });

  it('removes a field when the request passes null', () => {
    // seed both, call setJira({ site: null }), assert the key is gone
    // rather than present as "".
  });

  it('replaces a non-object block rather than merging onto it', () => {
    // seed { jira: "nope" }, call setJira({ site }), assert the result is an
    // object holding only site.
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/electron/main/config/jira.test.ts`
Expected: FAIL — `parsed.jira` is `undefined` in every case because the parser does not read the key, and the "unknown top-level key" assertion fails because it does.

- [ ] **Step 3: Teach `parse.ts` the block**

Add `'jira'` to `TOP_LEVEL_KEYS` (`parse.ts:85`) with a comment matching the `notifications` one. Add to `ParsedConfig`:

```typescript
  /**
   * HIVE-67's Jira block, exactly as the file declared it.
   *
   * `undefined` when the file has none — which every config written before this
   * story does. Partial when it names only one field; the caller merges
   * `DEFAULT_JIRA` under it. Kept partial here so the write path can tell "the
   * user chose this" from "the file said nothing".
   */
  jira?: Partial<JiraConfig>;
```

Add `optionalJira()` immediately after `optionalNotifications()`, structurally identical to it — the same forbidden-key loop with the same narrower message, the same `checkKeys` call against `JIRA_KEYS`, a per-field `typeof raw !== 'string'` check that reports and continues. Then call it in `parseConfig` beside `optionalNotifications` and include `jira` in all four `return` shapes in that function.

- [ ] **Step 4: Resolve and write it in `config/index.ts`**

In `loadConfig`'s returned object, after `notifications`:

```typescript
    // Defaults *under* whatever the file named, so a file declaring only a site
    // still answers for both fields (HIVE-67).
    jira: { ...DEFAULT_JIRA, ...parsed.jira },
```

`emptySnapshot` already supplies `jira` from Task 1, so the two error paths in `loadConfig` need no change.

Add the verb, modelled on `setNotifications` (`config/index.ts:525`):

```typescript
/**
 * Change the Jira connection (HIVE-67).
 *
 * The token is **not** here and never will be — it goes to `safeStorage`
 * through `jira:set-token`. What this writes is the site and the account email,
 * which are ordinary settings and belong with the rest of the config.
 *
 * The block is spread, never rebuilt, for the reason every other verb spreads
 * its target: a key this build has not heard of must survive a save made by
 * this one. `null` removes a field rather than storing `""`, which would be a
 * site named "" — the same three-state discipline `applyOverride` applies.
 */
export function setJira(request: SetJiraRequest): ConfigSnapshot {
  return commit(
    writeConfig((draft) => {
      const current =
        typeof draft.jira === 'object' &&
        draft.jira !== null &&
        !Array.isArray(draft.jira)
          ? { ...(draft.jira as Record<string, unknown>) }
          : {};

      applyOverride(current, 'site', request.site);
      applyOverride(current, 'email', request.email);

      return { ...draft, jira: current };
    }),
  );
}
```

`applyOverride`'s key parameter is currently typed `'shell' | 'claudeCommand' | 'env'`. Widen it to `'shell' | 'claudeCommand' | 'env' | 'site' | 'email'` and its value parameter to include `string | null | undefined` (it already does). Update its doc comment to say it is shared by the project-runtime and Jira verbs.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/electron/main/config/`
Expected: PASS, including the existing config suites — the new key must not disturb them.

- [ ] **Step 6: Commit**

```bash
git add electron/main/config/parse.ts electron/main/config/index.ts tests/electron/main/config/jira.test.ts
git commit -m "feat(config): read and write the jira block (HIVE-67)"
```

---

### Task 5: The verbs, the channels, and the bridge

**Files:**
- Create: `app/electron/main/integrations/jira/index.ts`
- Modify: `app/electron/shared/ipc-contract.ts` (five channels, `HiveBridge.jira`, `config.setJira`, `BRIDGE_KEYS`, `BRIDGE_CONFIG_KEYS`, new `BRIDGE_JIRA_KEYS`)
- Modify: `app/electron/preload/index.ts` (the `jira` namespace and `config.setJira`)
- Modify: `app/electron/main/ipc/index.ts` (five handlers)
- Test: `app/tests/electron/main/integrations/jira/index.test.ts`
- Test: `app/tests/electron/preload/bridge.test.ts` (extend the existing surface assertions)

**Interfaces:**
- Consumes: `createJiraAuth`, `credentialFile` (Task 2); `createJiraClient`, `FetchLike` (Task 3); `setJira`, `getConfig` (Task 4); the guards (Task 1).
- Produces: `Jira`, `createJira`; `CH.jiraStatus`, `CH.jiraSetToken`, `CH.jiraClearToken`, `CH.jiraTest`, `CH.configSetJira`; `window.hive.jira.{status,setToken,clearToken,test}`; `window.hive.config.setJira`.

- [ ] **Step 1: Write the failing test**

Create `app/tests/electron/main/integrations/jira/index.test.ts`:

```typescript
// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createJira } from '../../../../../electron/main/integrations/jira';
import type { SecretFile, SecretStore } from '../../../../../electron/main/integrations/jira/auth';
import type { FetchLike } from '../../../../../electron/main/integrations/jira/client';
import { DEFAULT_JIRA, emptySnapshot } from '../../../../../electron/shared/config-contract';

/**
 * The verbs main exposes (HIVE-67).
 *
 * Composition only — auth, client and config are each tested on their own. What
 * this proves is that the composition does not leak, and that a verb answers
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

const snapshot = (jira = DEFAULT_JIRA) => ({
  ...emptySnapshot('/tmp/config.json'),
  jira,
});

const never: FetchLike = () => {
  throw new Error('fetch must not be called');
};

const build = (options: {
  jira?: { site: string | null; email: string | null };
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  available?: boolean;
}) =>
  createJira({
    store: store(options.available ?? true),
    file: file(),
    env: options.env ?? {},
    config: () => snapshot(options.jira ?? DEFAULT_JIRA),
    fetch: options.fetch ?? never,
  });

describe('status', () => {
  it('reports the configured site and email beside the credential state', () => {
    const jira = build({ jira: { site: 'a.b.net', email: 'me@example.com' } });
    expect(jira.status()).toEqual({
      site: 'a.b.net',
      email: 'me@example.com',
      credential: { kind: 'none' },
      encryptionAvailable: true,
    });
  });

  it('reports encryptionAvailable false beside an env credential', () => {
    const jira = build({ available: false, env: { JIRA_API_KEY: TOKEN } });
    const status = jira.status();
    expect(status.credential).toEqual({ kind: 'env', variable: 'JIRA_API_KEY' });
    expect(status.encryptionAvailable).toBe(false);
  });

  it('never contains the token, in any state', () => {
    const jira = build({ jira: { site: 'a.b.net', email: 'me@example.com' } });
    jira.setToken({ token: TOKEN });
    expect(JSON.stringify(jira.status())).not.toContain(TOKEN);
    expect(JSON.stringify(jira.clearToken())).not.toContain(TOKEN);
  });
});

describe('test', () => {
  it('refuses before a site is configured, without calling fetch', async () => {
    const result = await build({ jira: { site: null, email: 'me@example.com' } }).test();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toMatch(/site/i);
  });

  it('refuses before an email is configured', async () => {
    const result = await build({ jira: { site: 'a.b.net', email: null } }).test();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toMatch(/email/i);
  });

  it('refuses with no credential at all', async () => {
    const result = await build({ jira: { site: 'a.b.net', email: 'me@example.com' } }).test();
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
            emailAddress: 'me@example.com',
            avatarUrls: { '48x48': 'https://…' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const jira = build({ jira: { site: 'a.b.net', email: 'me@example.com' }, fetch });
    jira.setToken({ token: TOKEN });

    const result = await jira.test();
    expect(result).toEqual({
      ok: true,
      value: { displayName: 'Yunid Bauza', accountId: '712020:9f3c' },
    });
  });

  it('does not clear a stored token when Jira answers 401', async () => {
    const fetch: FetchLike = () => Promise.resolve(new Response('no', { status: 401 }));
    const jira = build({ jira: { site: 'a.b.net', email: 'me@example.com' }, fetch });
    jira.setToken({ token: TOKEN });

    const result = await jira.test();
    expect(!result.ok && result.error.kind).toBe('unauthorized');
    expect(jira.status().credential.kind).toBe('stored');
  });
});

describe('setToken', () => {
  it('answers with the fresh status rather than nothing', () => {
    const jira = build({ jira: { site: 'a.b.net', email: 'me@example.com' } });
    expect(jira.setToken({ token: TOKEN }).credential).toEqual({
      kind: 'stored',
      email: 'me@example.com',
    });
  });

  it('reports rather than throws when encryption is unavailable', () => {
    const jira = build({ available: false });
    const status = jira.setToken({ token: TOKEN });
    expect(status.credential.kind).toBe('unavailable');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/electron/main/integrations/jira/index.test.ts`
Expected: FAIL — cannot resolve `.../jira`.

- [ ] **Step 3: Write `electron/main/integrations/jira/index.ts`**

```typescript
import type { ConfigSnapshot } from '../../../shared/config-contract';
import type { SetJiraTokenRequest } from '../../../shared/config-contract';
import type {
  JiraIdentity,
  JiraResult,
  JiraStatus,
} from '../../../shared/jira-contract';

import {
  createJiraAuth,
  type JiraAuth,
  type SecretFile,
  type SecretStore,
} from './auth';
import { createJiraClient, type FetchLike } from './client';

/**
 * The verbs main exposes for Jira (HIVE-67).
 *
 * Composition, and nothing else. `auth.ts` owns the credential, `client.ts`
 * owns HTTP, and this file owns the decision about which of them a verb needs
 * and what happens when the app is not configured yet.
 *
 * Every verb **answers**; none throws. A settings pane that cannot render
 * because Jira is unreachable tells the user this app is broken, which is
 * `gh.ts`'s rule (gh.ts:166-172) and is why the result union exists.
 */

/** What `GET /rest/api/3/myself` is narrowed to before it crosses IPC. */
const MYSELF = '/rest/api/3/myself';

export interface Jira {
  status(): JiraStatus;
  setToken(request: SetJiraTokenRequest): JiraStatus;
  clearToken(): JiraStatus;
  test(): Promise<JiraResult<JiraIdentity>>;
}

export function createJira(deps: {
  store: SecretStore;
  file: SecretFile;
  env: NodeJS.ProcessEnv;
  /** Read fresh on every verb — the user may have edited the file underneath. */
  config: () => ConfigSnapshot;
  fetch: FetchLike;
}): Jira {
  const { config, fetch } = deps;
  const auth: JiraAuth = createJiraAuth({
    store: deps.store,
    file: deps.file,
    env: deps.env,
  });

  const status = (): JiraStatus => {
    const { site, email } = config().jira;
    return {
      site,
      email,
      credential: auth.state(email),
      encryptionAvailable: auth.encryptionAvailable(),
    };
  };

  return {
    status,

    setToken(request) {
      try {
        auth.save(request.token);
      } catch {
        /**
         * Swallowed deliberately, and the *state* is the report.
         *
         * `save` throws only when encryption is unavailable, and in that case
         * `status()` already answers `unavailable` with a reason the pane
         * shows. Rejecting the invoke as well would make the renderer handle
         * the same fact twice, in two shapes.
         */
      }
      return status();
    },

    clearToken() {
      auth.clear();
      return status();
    },

    async test() {
      const { site, email } = config().jira;
      if (site === null) {
        return {
          ok: false,
          error: { kind: 'bad-query', message: 'No Jira site is configured yet.' },
        };
      }
      if (email === null) {
        return {
          ok: false,
          error: { kind: 'bad-query', message: 'No account email is configured yet.' },
        };
      }

      const token = auth.token();
      if (token === null) {
        return {
          ok: false,
          error: {
            kind: 'unauthorized',
            message: 'No API token is stored, and JIRA_API_KEY is not set.',
          },
        };
      }

      const client = createJiraClient({
        fetch,
        site,
        credential: { email, token },
      });

      const result = await client.get<{
        displayName?: unknown;
        accountId?: unknown;
      }>(MYSELF);
      if (!result.ok) return result;

      /**
       * Narrowed to two fields before it crosses IPC.
       *
       * `/myself` returns an avatar map, a locale, a time zone and the account's
       * email address. The epic's rule is that only mapped, named fields ever
       * cross — forwarding the payload would hand the renderer personal data it
       * has no use for, and set the precedent that raw Jira JSON is allowed
       * through.
       */
      const { displayName, accountId } = result.value;
      if (typeof displayName !== 'string' || typeof accountId !== 'string') {
        return {
          ok: false,
          error: {
            kind: 'unknown',
            message: 'Jira answered without an account name.',
          },
        };
      }
      return { ok: true, value: { displayName, accountId } };
    },
  };
}
```

Note the import of `SetJiraTokenRequest` — it lives in `config-contract.ts` per Task 1. If placing it in `jira-contract.ts` reads better once both files exist, move it there and update Task 1's file; keep it in exactly one place.

- [ ] **Step 4: Add the channels and the bridge surface to `ipc-contract.ts`**

In `CH`, after `integrationsStatus`:

```typescript
  /**
   * The Jira connection settings (HIVE-67).
   *
   * A `config:` channel rather than a `jira:` one because it writes the config
   * file and returns the fresh snapshot, exactly like every other settings
   * verb. Only the *credential* needs a namespace of its own, because it is the
   * only part that does not live in that file.
   */
  configSetJira: 'config:set-jira',
  /**
   * The Jira credential and the connection test (HIVE-67).
   *
   * Four verbs, and the count is the security design: the renderer may write a
   * token and clear one, and there is **no verb that returns one**. A user who
   * wants to read their token looks at Atlassian, which is correct.
   */
  jiraStatus: 'jira:status',
  jiraSetToken: 'jira:set-token',
  jiraClearToken: 'jira:clear-token',
  jiraTest: 'jira:test',
```

`EVENT_CHANNELS` is untouched — nothing here is pushed.

Add to `HiveBridge.config`, after `setNotifications`:

```typescript
    /**
     * Change the Jira site and account email (HIVE-67).
     *
     * `null` clears a field; an absent field is untouched. The API token is
     * deliberately not here — it is a secret, and it goes through
     * {@link HiveBridge.jira.setToken} into `safeStorage`.
     */
    setJira(request: SetJiraRequest): Promise<ConfigSnapshot>;
```

Add a new top-level namespace after `integrations`:

```typescript
  /**
   * Jira (HIVE-67).
   *
   * Read the credential *state*, write a token, clear one, and test the
   * connection. There is no verb that returns a token, and adding one would be
   * a deliberate widening of what a web page can extract from this machine.
   */
  jira: {
    status(): Promise<JiraStatus>;
    setToken(request: SetJiraTokenRequest): Promise<JiraStatus>;
    clearToken(): Promise<JiraStatus>;
    test(): Promise<JiraResult<JiraIdentity>>;
  };
```

Add `'jira'` to `BRIDGE_KEYS` (alphabetical: after `'integrations'`), `'setJira'` to `BRIDGE_CONFIG_KEYS` with a HIVE-67 comment, and:

```typescript
/** The exact key set of `window.hive.jira`. */
export const BRIDGE_JIRA_KEYS = [
  'status',
  'setToken',
  'clearToken',
  'test',
] as const;
```

Update the `BRIDGE_KEYS` doc comment to record what the new namespace lets a web page do — the existing comment does this for story 106 and the alarm firing is the point. Say: it can learn *whether* a Jira credential exists and where it came from, write one, clear one, and cause one authenticated request to the configured site; it cannot read a token and cannot choose the host.

- [ ] **Step 5: Add the preload bindings**

In `electron/preload/index.ts`, add to the `config` object:

```typescript
    setJira: (request: SetJiraRequest): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configSetJira, request),
```

and a new namespace after `integrations`:

```typescript
  // HIVE-67. Four verbs; none of them returns a token. See the contract.
  jira: {
    status: (): Promise<JiraStatus> => ipcRenderer.invoke(CH.jiraStatus),
    setToken: (request: SetJiraTokenRequest): Promise<JiraStatus> =>
      ipcRenderer.invoke(CH.jiraSetToken, request),
    clearToken: (): Promise<JiraStatus> => ipcRenderer.invoke(CH.jiraClearToken),
    test: (): Promise<JiraResult<JiraIdentity>> => ipcRenderer.invoke(CH.jiraTest),
  },
```

- [ ] **Step 6: Register the handlers**

In `electron/main/ipc/index.ts`, import `safeStorage` from `electron`, `createJira` and `credentialFile`, `setJira`, and the two new guards. Build the instance once inside `registerIpcHandlers`, beside the existing `createHookRuntime({ userDataPath: app.getPath('userData') })` call:

```typescript
  /**
   * The Jira integration (HIVE-67).
   *
   * Built once. `safeStorage` is passed as the store rather than imported
   * inside `auth.ts`, so the unit tests can inject a fake without mocking the
   * `electron` module — the same injection `gh.ts` uses for its command runner.
   *
   * `globalThis.fetch` rather than a dependency: Node is pinned `>=22` and
   * Electron is 43, so it is there. It is injected all the same, because a
   * client that reaches for a global is a client no test can answer for.
   */
  const jira = createJira({
    store: safeStorage,
    file: credentialFile(join(app.getPath('userData'), 'jira-credential.bin')),
    env: process.env,
    config: getConfig,
    fetch: (url, init) => globalThis.fetch(url, init),
  });

  handle(CH.jiraStatus, (): JiraStatus => jira.status());
  handle(CH.jiraSetToken, (_event, payload) =>
    jira.setToken(parseSetJiraTokenRequest(payload)),
  );
  handle(CH.jiraClearToken, (): JiraStatus => jira.clearToken());
  handle(CH.jiraTest, (): Promise<JiraResult<JiraIdentity>> => jira.test());
  handle(CH.configSetJira, (_event, payload) =>
    setJira(parseSetJiraRequest(payload)),
  );
```

- [ ] **Step 7: Extend the bridge surface test**

In `app/tests/electron/preload/bridge.test.ts`, add `BRIDGE_JIRA_KEYS` to whatever the existing exact-key-set assertions iterate. Read the file first and follow its shape; do not invent a second assertion style.

- [ ] **Step 8: Run everything**

Run: `pnpm vitest run tests/electron && pnpm type-check && pnpm lint && pnpm verify:boundaries`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add electron/main/integrations/jira/index.ts electron/shared/ipc-contract.ts electron/preload/index.ts electron/main/ipc/index.ts tests/electron/
git commit -m "feat(jira): the four credential verbs and their channels (HIVE-67)"
```

---

### Task 6: The renderer bridge module

**Files:**
- Create: `app/src/lib/jira.ts`
- Modify: `app/src/lib/project-config.ts` (add `setJiraConnection`)
- Test: `app/tests/lib/jira.test.ts`

**Interfaces:**
- Consumes: `window.hive.jira.*`, `window.hive.config.setJira` (Task 5).
- Produces: `readJiraStatus()`, `saveJiraToken(token)`, `clearJiraToken()`, `testJiraConnection()`, `setJiraConnection(request)`.

- [ ] **Step 1: Write the failing test**

Create `app/tests/lib/jira.test.ts`. Read `app/tests/lib/project-config.test.ts` first and reuse its `window.hive` stubbing approach.

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearJiraToken,
  readJiraStatus,
  saveJiraToken,
  testJiraConnection,
} from '@lib/jira';

/**
 * The renderer's Jira bridge (HIVE-67).
 *
 * Mirrors `project-config.ts`: no bridge is the browser demo and not a failure,
 * and a rejected channel is reported to the console rather than thrown at a
 * component — a settings pane that crashes because IPC hiccuped is worse than
 * one that says it does not know.
 */

const STATUS = {
  site: 'a.b.net',
  email: 'me@example.com',
  credential: { kind: 'none' as const },
  encryptionAvailable: true,
};

afterEach(() => {
  delete window.hive;
  vi.restoreAllMocks();
});

/** Install a partial bridge; the cast is confined to this helper. */
function bridge(jira: Partial<NonNullable<Window['hive']>['jira']>): void {
  window.hive = { jira } as unknown as NonNullable<Window['hive']>;
}

describe('with no bridge', () => {
  it('reads null rather than throwing', async () => {
    await expect(readJiraStatus()).resolves.toBeNull();
    await expect(saveJiraToken('t')).resolves.toBeNull();
    await expect(clearJiraToken()).resolves.toBeNull();
    await expect(testJiraConnection()).resolves.toBeNull();
  });
});

describe('with a bridge', () => {
  it('returns the status', async () => {
    bridge({ status: () => Promise.resolve(STATUS) });
    await expect(readJiraStatus()).resolves.toEqual(STATUS);
  });

  it('passes the token through to setToken', async () => {
    const setToken = vi.fn(() => Promise.resolve(STATUS));
    bridge({ setToken });
    await saveJiraToken('ATATT-x');
    expect(setToken).toHaveBeenCalledWith({ token: 'ATATT-x' });
  });

  it('reports a rejected channel as null and logs once', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridge({ status: () => Promise.reject(new Error('channel down')) });
    await expect(readJiraStatus()).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('never logs the token when a write is refused', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridge({ setToken: () => Promise.reject(new Error('refused')) });
    await saveJiraToken('ATATT-secret');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('ATATT-secret');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/lib/jira.test.ts`
Expected: FAIL — cannot resolve `@lib/jira`.

- [ ] **Step 3: Write `src/lib/jira.ts`**

```typescript
import type {
  JiraIdentity,
  JiraResult,
  JiraStatus,
} from '@shared/jira-contract';

/**
 * The renderer's half of the Jira bridge (HIVE-67).
 *
 * Mirrors `project-config.ts` in the two ways that matter. **No bridge returns
 * `null`** — that is the browser demo, not a failure, and story 083's rule is to
 * feature-detect the bridge rather than the user agent. **A rejected channel
 * returns `null` too**, logged, because a settings section that throws when IPC
 * hiccups is worse than one that says it does not know.
 *
 * No module-level cache here, unlike `project-config.ts`. The credential state
 * is read by exactly one pane, which holds it in component state and re-reads
 * after each write — there is nothing for a second consumer to go stale
 * against.
 *
 * The token appears in exactly one function's parameter list and is never
 * logged, including on the failure path.
 */

async function call<T>(
  verb: string,
  run: (bridge: NonNullable<Window['hive']>) => Promise<T>,
): Promise<T | null> {
  const bridge = window.hive;
  if (!bridge) return null;

  try {
    return await run(bridge);
  } catch (cause) {
    // The verb name, never the payload — `saveJiraToken`'s payload is a secret.
    console.error(`[hive] jira.${verb} failed:`, cause);
    return null;
  }
}

/** Where the credential comes from, and what the site and email are. */
export const readJiraStatus = (): Promise<JiraStatus | null> =>
  call('status', (bridge) => bridge.jira.status());

/** Store a token. Answers with the fresh status, so no follow-up read is needed. */
export const saveJiraToken = (token: string): Promise<JiraStatus | null> =>
  call('setToken', (bridge) => bridge.jira.setToken({ token }));

export const clearJiraToken = (): Promise<JiraStatus | null> =>
  call('clearToken', (bridge) => bridge.jira.clearToken());

/** `GET /rest/api/3/myself`. Resolves `null` only when the channel itself failed. */
export const testJiraConnection = (): Promise<JiraResult<JiraIdentity> | null> =>
  call('test', (bridge) => bridge.jira.test());
```

- [ ] **Step 4: Add `setJiraConnection` to `src/lib/project-config.ts`**

After `setNotificationPrefs`:

```typescript
/**
 * Change the Jira site and account email (HIVE-67).
 *
 * Here rather than in `lib/jira.ts` because it writes the config file and
 * returns a `ConfigSnapshot`, so it needs this module's `mutate` to install the
 * fresh one — the same path every other settings write takes. The *token* is in
 * `lib/jira.ts`, because it is not config.
 */
export const setJiraConnection = (request: SetJiraRequest): Promise<void> =>
  mutate((bridge) => bridge.config.setJira(request));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/lib/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/jira.ts src/lib/project-config.ts tests/lib/jira.test.ts
git commit -m "feat(jira): the renderer bridge module (HIVE-67)"
```

---

### Task 7: `SecretField`

**Files:**
- Create: `app/src/components/ui/secret-field.tsx`
- Test: `app/tests/components/ui/secret-field.test.tsx`

**Interfaces:**
- Produces: `SecretField` with props `{ label, value, onChange, onCommit?, placeholder?, hint?, className? }`.

- [ ] **Step 1: Write the failing test**

Create `app/tests/components/ui/secret-field.test.tsx`. Read a sibling such as `app/tests/components/ui/text-field.test.tsx` first and match its render/query idiom.

```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SecretField } from '@components/ui/secret-field';

/**
 * The write-only credential input (HIVE-67).
 *
 * Not a masked `TextField`: this field never displays a stored value, because
 * there is none to display. Its input is always a *new* value replacing the
 * old, and the tests below are what stop a later refactor from folding the two
 * into one component and quietly implying that a token round-trips.
 */

describe('SecretField', () => {
  it('masks the value by default', () => {
    render(<SecretField label="API token" value="s3cret" onChange={vi.fn()} />);
    expect(screen.getByLabelText('API token')).toHaveAttribute('type', 'password');
  });

  it('reveals and re-hides on the toggle', async () => {
    const user = userEvent.setup();
    render(<SecretField label="API token" value="s3cret" onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /show/i }));
    expect(screen.getByLabelText('API token')).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: /hide/i }));
    expect(screen.getByLabelText('API token')).toHaveAttribute('type', 'password');
  });

  it('reports every keystroke to onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SecretField label="API token" value="" onChange={onChange} />);
    await user.type(screen.getByLabelText('API token'), 'ab');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('commits on Enter and on blur', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <SecretField label="API token" value="x" onChange={vi.fn()} onCommit={onCommit} />,
    );
    const input = screen.getByLabelText('API token');
    await user.click(input);
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledTimes(1);
    await user.tab();
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it('describes itself with the hint rather than folding it into the name', () => {
    render(
      <SecretField
        label="API token"
        value=""
        onChange={vi.fn()}
        hint="Stored encrypted by the OS."
      />,
    );
    expect(screen.getByLabelText('API token')).toHaveAccessibleDescription(
      'Stored encrypted by the OS.',
    );
  });

  it('never autocompletes or spell-checks a credential', () => {
    render(<SecretField label="API token" value="" onChange={vi.fn()} />);
    const input = screen.getByLabelText('API token');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/components/ui/secret-field.test.tsx`
Expected: FAIL — cannot resolve `@components/ui/secret-field`.

- [ ] **Step 3: Write `src/components/ui/secret-field.tsx`**

```typescript
import { Eye, EyeSlash } from '@phosphor-icons/react';
import { useId, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * A write-only credential input (HIVE-67).
 *
 * Deliberately **not** a `type` prop on {@link TextField}. The two look similar
 * and mean different things: a `TextField` shows the value the app holds, and
 * this field cannot, because the app does not hold one — a stored token can be
 * replaced and cleared but never read back. Folding them together would put a
 * masked box on screen that implies a round trip that does not exist.
 *
 * So the value here is always a *new* token on its way in, and whatever is
 * already stored is described in prose beside the field rather than dotted out
 * inside it.
 *
 * The reveal toggle exists because the realistic failure is a truncated paste,
 * and a credential you cannot look at is one you cannot check before saving.
 * Same labelling arrangement as `TextField` — `htmlFor`, never a wrapping
 * `<label>` — for the reason `text-field.tsx:5-18` gives.
 */

interface SecretFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Fired on Enter and on blur — the commit points, as in `TextField`. */
  onCommit?: () => void;
  placeholder?: string;
  hint?: string;
  className?: string;
}

export function SecretField({
  label,
  value,
  onChange,
  onCommit,
  placeholder,
  hint,
  className,
}: SecretFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [revealed, setRevealed] = useState(false);

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-[12.5px] text-muted">
        {label}
      </label>

      <div className="flex items-center gap-1.5">
        <input
          id={id}
          type={revealed ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          aria-describedby={hint ? hintId : undefined}
          // A password manager offering to fill an Atlassian API token would
          // fill the wrong thing, and a spell-checker sends what it checks.
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onCommit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onCommit?.();
            }
          }}
          className={cn(
            'min-w-0 flex-1 rounded-[6px] border border-border bg-panel-2 px-2.5 py-1.5',
            'text-[12.5px] text-ink outline-none placeholder:text-subtle',
            'focus-visible:ring-1 focus-visible:ring-brand',
          )}
        />

        <button
          type="button"
          aria-label={revealed ? 'Hide the token' : 'Show the token'}
          onClick={() => setRevealed((current) => !current)}
          className={cn(
            'rounded-[6px] border border-transparent p-1.5 text-subtle',
            'hover:bg-hover hover:text-ink',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand',
          )}
        >
          {revealed ? <EyeSlash size={14} /> : <Eye size={14} />}
        </button>
      </div>

      {hint ? (
        <span id={hintId} className="text-[11.5px] text-subtle">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/components/ui/secret-field.test.tsx`
Expected: PASS.

- [ ] **Step 5: Document the atom**

Add a row for `SecretField` to `app/.claude/COMPONENTS.md`, following the format of the `TextField` entry already there. One line on what it is, and one on why it is not a `TextField` variant.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/secret-field.tsx tests/components/ui/secret-field.test.tsx .claude/COMPONENTS.md
git commit -m "feat(ui): SecretField, a write-only credential input (HIVE-67)"
```

---

### Task 8: The two settings groups

**Files:**
- Create: `app/src/features/settings/components/jira-connection-group.tsx`
- Create: `app/src/features/settings/components/jira-credential-group.tsx`
- Modify: `app/src/features/settings/components/integrations-section.tsx` (render both, between "Token source" and "Notifications")
- Test: `app/tests/features/settings/components/jira-connection-group.test.tsx`
- Test: `app/tests/features/settings/components/jira-credential-group.test.tsx`
- Test: `app/tests/features/settings/components/integrations-section.test.tsx` (extend)

**Interfaces:**
- Consumes: `SettingsGroup`, `TextField`, `SecretField`, `readJiraStatus`, `saveJiraToken`, `clearJiraToken`, `testJiraConnection`, `setJiraConnection`, `useProjectConfig`.
- Produces: `JiraConnectionGroup`, `JiraCredentialGroup` (both take `{ status, onChanged }`).

**Layout** — variant B from the mockup:

- **"Jira site"** — two `TextField`s (Site, Account email), each committing on blur or Enter through `setJiraConnection`, with a hint saying both live in `~/.hive/config.json`.
- **"API token"** — the credential-state line, a `SecretField` with Save, a Clear button when something is stored, the "Test connection" button, and the test verdict.

Copy per state, verbatim (these are the strings the tests assert):

| State | Line |
| --- | --- |
| `none` | "No token stored. The WORK tab will keep showing sample tickets." |
| `stored` | "A token is stored for {email}." |
| `env` | "`JIRA_API_KEY` is set in this app's environment, so that is the token being used." |
| `unavailable` | The `reason` from the state, verbatim — main composed it and it names the variable. |
| `encryptionAvailable: false` alongside `env` | Additionally: "This system cannot encrypt secrets, so storing one here is not offered." |

The token field and Save button are **not rendered** when `encryptionAvailable` is false — offering a control that cannot work is exactly what `integrations-section.tsx:30-35` says not to do ("absent rather than disabled").

- [ ] **Step 1: Write the failing tests**

Create both test files. Read `app/tests/features/settings/components/integrations-section.test.tsx` first for the module-mocking idiom this repo uses for `@lib/project-config`, and mock `@lib/jira` the same way.

`jira-credential-group.test.tsx` must assert, at minimum:

```typescript
// one `it` per row of the copy table above, e.g.
it('says nothing is stored in the none state', () => { /* render, assert copy */ });
it('names the account in the stored state', () => { /* … */ });
it('names JIRA_API_KEY in the env state', () => { /* … */ });
it('shows main\'s reason in the unavailable state', () => { /* … */ });

it('hides the token field entirely when encryption is unavailable', () => {
  // assert queryByLabelText('API token') is null — absent, not disabled.
});

it('offers Clear only when a token is stored', () => { /* … */ });

it('calls saveJiraToken with what was typed, and clears the field after', async () => {
  // assert the input is empty afterwards: a token left in a React state
  // is a token in a heap snapshot.
});

it('reports a 401 without clearing the stored credential', async () => {
  // testJiraConnection resolves { ok: false, error: { kind: 'unauthorized' } };
  // assert the failure copy renders AND clearJiraToken was never called.
});

it('shows the display name on a successful test', async () => { /* … */ });

it('re-reads the status after save, clear and test', async () => {
  // assert onChanged fired.
});
```

`jira-connection-group.test.tsx` must assert:

```typescript
it('renders the configured site and email', () => { /* … */ });
it('commits the site on blur', async () => {
  // assert setJiraConnection was called with { site: '…' } and nothing else —
  // saving one field must not restate the other.
});
it('sends null when a field is emptied', async () => { /* … */ });
it('does not commit when the value is unchanged', async () => { /* … */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/features/settings/components/jira-`
Expected: FAIL — neither component resolves.

- [ ] **Step 3: Write the two components**

Both take `{ status: JiraStatus; onChanged: () => void }` and are pure with respect to fetching — `integrations-section.tsx` owns the one `readJiraStatus()` call and passes the result down, so there is exactly one place that knows when to re-read. Each component calls its verb and then `onChanged()`.

`JiraConnectionGroup` holds one piece of local state per field (the draft), seeded from `status` and committed on blur or Enter, exactly as `runtime-section.tsx` does for shell and agent command — read that file and follow it rather than inventing a second commit idiom. An emptied field commits `null`, not `""`.

`JiraCredentialGroup` holds the draft token and the last test verdict. After a successful save it sets the draft back to `''`.

- [ ] **Step 4: Wire them into `integrations-section.tsx`**

Add one state hook for the Jira status beside the existing `status` one, read in the same `useEffect` (one round trip is two verbs here, so a second `void readJiraStatus().then(...)` inside the same effect, guarded by the same `cancelled` flag). Render both groups after the "Token source" group and before "Notifications", each behind `jiraStatus === null ? <p>Checking…</p> : …` the way the existing groups gate on `status === null`. Extend the section's own test to assert both group headings appear.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/features/settings/ && pnpm test:coverage`
Expected: PASS, and the 80% gate still green — the new `src/` files are covered by the tests above.

- [ ] **Step 6: Commit**

```bash
git add src/features/settings/components/ tests/features/settings/components/
git commit -m "feat(settings): the Jira connection and credential groups (HIVE-67)"
```

---

### Task 9: The end-to-end spec

**Files:**
- Create: `app/tests/e2e/electron/jira-settings.spec.ts`

**Scope note, to be repeated in the PR description.** The epic asks Playwright to render "all four credential states". Two of them are reachable in a real Electron app and two are not: `unavailable` needs a machine whose `safeStorage` cannot encrypt, and `stored` needs a token actually written to the OS keychain, which a CI run should not do. So the e2e spec proves `none` and `env`, and the four-state rendering is proven by `jira-credential-group.test.tsx`. This is a deliberate split, not a gap.

- [ ] **Step 1: Write the spec**

Model it on `app/tests/e2e/electron/integrations.spec.ts` — read that file and reuse its settings-navigation helper and its scratch `HIVE_CONFIG_PATH` seeding rather than writing new ones.

```typescript
// Assertions, in order:
// 1. Open Settings → Integrations. Both "Jira site" and "API token" headings render.
// 2. With a config naming no jira block: the site and email fields are empty and
//    the credential line says no token is stored.
// 3. Type a site, blur, reopen the pane: the value survived, which proves it
//    reached ~/.hive/config.json and came back through the snapshot.
// 4. Relaunch with JIRA_API_KEY set in the app's environment: the credential line
//    names JIRA_API_KEY. (launchHive already spreads process.env; pass the
//    variable through the same env object the fixture builds.)
// 5. "Test connection" with no site configured reports that, and does not hang.
```

The fixture's `launchHive` takes `userDataDir` and `configPath` today. Add an optional `env?: Record<string, string>` parameter, merged into the `env` object it already builds, so step 4 can set `JIRA_API_KEY` without a second launch helper. Keep every Electron-specific call inside `fixtures/hive-app.ts`, which is that file's stated rule.

- [ ] **Step 2: Run it**

Run: `pnpm test:e2e:electron -- jira-settings`
Expected: PASS. If `out/` is stale the config's `globalSetup` rebuilds it first.

- [ ] **Step 3: Run the whole suite**

Run: `pnpm lint && pnpm type-check && pnpm verify:boundaries && pnpm test:coverage && pnpm test:e2e`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/electron/
git commit -m "test(jira): end-to-end coverage for the settings pane (HIVE-67)"
```

---

## Self-review

**Spec coverage.** Every section of the design maps to a task: contracts and guards → 1; `auth.ts` and the four states → 2; `client.ts`, the error table and the bounds → 3; the config block → 4; IPC, the bridge and the "no verb returns a token" property → 5; the renderer bridge → 6; `SecretField` → 7; layout, copy and the four-state rendering → 8; e2e → 9. The security deep-scan appears in Tasks 2, 3 and 5, at each layer it could be lost.

**Acceptance criteria.** Ticket line by line: token stored via `safeStorage` and absent from the config file → Task 2 + Task 4 (the config verb has no token parameter at all). Status never contains the token → Tasks 2, 5. Renderer can write and clear but not read → Task 5, `BRIDGE_JIRA_KEYS`. Test connection reports the display name and typed failures for 401/403/timeout/offline → Tasks 3, 5, 8. `safeStorage` unavailable falls back to `JIRA_API_KEY` and writes no plaintext → Task 2. A transient 401 does not clear the credential → Task 5's test, Task 8's test. Lint, type-check, test, boundaries → every task's final step.

**Naming consistency.** `createJiraAuth`, `createJiraClient`, `createJira`; `JiraAuth`, `JiraClient`, `Jira`; `SecretStore`, `SecretFile`, `credentialFile`; `readJiraStatus`, `saveJiraToken`, `clearJiraToken`, `testJiraConnection`, `setJiraConnection`. `JiraStatus` (the IPC answer) is distinct from `JiraCredentialState` (the union inside it) throughout. `SetJiraTokenRequest` lives in `config-contract.ts` per Task 1 and is imported from there in Tasks 5 and 6.

**Known gap, stated rather than hidden.** The e2e spec covers two of four credential states; the other two are unit-covered. Task 9 says why.
