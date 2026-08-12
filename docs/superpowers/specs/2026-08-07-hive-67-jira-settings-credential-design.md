# HIVE-67 — Jira settings: connection and stored credential

Design, 2026-08-07. Part of the HIVE-66 Jira integration epic.

This story adds the connection settings and the app's first stored secret, and
nothing else. No ticket reading. It is first because every other story in the epic
depends on there being a credential.

## What ships

Three surfaces, one new capability.

| Surface | New |
| --- | --- |
| `~/.hive/config.json` | A `jira` block holding `site` and `email` |
| `userData/jira-credential.bin` | The API token, encrypted by `safeStorage` |
| Integrations settings pane | Two groups: **Jira site**, **API token** |

The one genuinely new capability is that the app now holds a credential. Everything
else follows existing patterns closely enough to be uninteresting.

## Why the token is not in the config file

`electron/main/integrations/gh.ts` deliberately stores no token, and its header says
why: nothing read one, so it would have been "a credential no code reads, living in a
plaintext file the product encourages the user to hand-edit."

Both halves stop being true here. Something reads this one. And it is not going in
`~/.hive/config.json` — that file is explicitly hand-editable (`HIVE_CONFIG_PATH`
relocates it, `config-contract.ts:264` keeps an `UNSAFE_ENV_KEYS` deny-list precisely
because users edit it, and story 107 shipped a "reveal in file manager" verb to
encourage exactly that).

So: `safeStorage`, which encrypts against an OS-held key — Keychain on macOS, DPAPI
on Windows, libsecret on Linux. The ciphertext lives under `userData`, in its own
file, mode `0600`.

## Modules

```
renderer                          main
--------                          ----
settings/components/                integrations/jira/
  jira-connection-group.tsx  ->       auth.ts     the only module that sees the token
  jira-credential-group.tsx           client.ts   HTTP; one verb this story
       |                              index.ts    the verbs main exposes
  lib/jira.ts                              ^
       |                                   |
  preload bridge.jira.*  ->  ipc/  --------+
```

Four files under `electron/main/integrations/jira/`. Three of them exist by the end
of this story; `mapping.ts` is HIVE-68's.

### `auth.ts` — the only module that sees the token

Takes both of its dependencies by injection, exactly as `gh.ts` takes its
`RunCommand` (`gh.ts:55-58`) and for the same reason: what is worth testing is the
decision logic, and a test that touched a real keychain would answer differently on
every machine.

```typescript
/** The slice of Electron's safeStorage this module uses. */
export interface SecretStore {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

/** The ciphertext file, as a seam. */
export interface SecretFile {
  read(): Buffer | null;
  write(bytes: Buffer): void;
  clear(): void;
}

export interface JiraAuth {
  /** What to tell the renderer. Never contains the token. */
  state(email: string | null): JiraCredentialState;
  /** True when this machine can encrypt at all. Reported alongside the state. */
  encryptionAvailable(): boolean;
  /** Main-internal. There is no IPC verb that reaches this. */
  token(): string | null;
  save(token: string): void;
  clear(): void;
}

export function createJiraAuth(deps: {
  store: SecretStore;
  file: SecretFile;
  env: NodeJS.ProcessEnv;
}): JiraAuth;
```

`token()` is not exported through `index.ts`'s verb surface and no channel returns
it. That is the invariant the security test guards.

### The four states, and their precedence

```typescript
export type JiraCredentialState =
  | { kind: 'none' }
  | { kind: 'stored'; email: string }
  | { kind: 'env'; variable: 'JIRA_API_KEY' }
  | { kind: 'unavailable'; reason: string };
```

Resolved in this order:

1. A ciphertext file exists and decrypts → `stored`, carrying the configured email.
2. `JIRA_API_KEY` is set and non-empty → `env`. Presence only; the value is never
   read for this answer, mirroring `gh.ts:96-107`.
3. Encryption is unavailable → `unavailable`, with the reason.
4. Otherwise → `none`.

**Why `encryptionAvailable` is reported separately.** The story's Linux paragraph
describes a case the union alone cannot express: no keyring *and* `JIRA_API_KEY`
set. That machine's credential state is `env` — that is genuinely where the token
comes from — but the pane still has to explain why it is not offering to store one.
One boolean beside the union says both things without inventing a fifth kind whose
only job is to be a conjunction.

An empty-but-exported variable counts as unset, which is the same false-positive
`gh.ts` avoids on a very common shell-profile pattern.

### `client.ts` — HTTP, one verb for now

`createJiraClient({ fetch, site, credential })`. Takes its `fetch` by injection so no
test touches the network. This story implements one call, `GET /rest/api/3/myself`,
and the parts of the error table that call can produce. HIVE-68 adds `searchJql`,
`readIssue`, retries and pagination on top of the same request path.

What this story's client already gets right, because retrofitting any of it later
would be a security regression:

- **Basic auth**, `base64(email + ':' + token)`, built here and nowhere else.
- **The host is fixed from config**, never from a payload. There is no parameter
  that can aim the client at another server — the one property that would otherwise
  turn this into a credential-exfiltration primitive.
- **`AbortSignal.timeout(10_000)`**, matching `gh.ts`'s posture of bounding every
  external call.
- **A response-size cap.** `/myself` is small; a body that is not is a reason to
  stop reading, not to buffer it.
- **No raw body escapes.** Errors carry a message this file composed, never the
  response text and never the token.

Node is pinned `>=22` and Electron is 43, so global `fetch` and `AbortSignal.timeout`
are available with no new dependency. This is the first HTTP call anywhere in
`electron/main`.

### The error union

Declared in a new `electron/shared/jira-contract.ts` in this story, with the full
`kind` set the epic's table names, so HIVE-68 extends behaviour rather than the type:

```typescript
export type JiraResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: JiraError };

export interface JiraError {
  kind: 'unauthorized' | 'forbidden' | 'not-found' | 'rate-limited'
      | 'offline' | 'timeout' | 'bad-query' | 'unknown';
  /** Safe to show. Never contains the token or a raw response body. */
  message: string;
  /** Seconds, from Retry-After. Only on 'rate-limited'. */
  retryAfter?: number;
}
```

This story produces `unauthorized`, `forbidden`, `not-found`, `timeout`, `offline`
and `unknown`. The remaining two — `rate-limited` and `bad-query` — are reachable
only through verbs HIVE-68 adds, along with the retry behaviour `rate-limited`
implies.

Verbs return this union rather than throwing across IPC, because the settings pane
must render either way — `gh.ts:166-172`'s reasoning, unchanged.

## Config

A new top-level `jira` block, following `notifications` (story 106) in every respect:

```json
{
  "version": 2,
  "jira": {
    "site": "behiques.atlassian.net",
    "email": "you@example.com"
  }
}
```

- `JiraConfig { site: string | null; email: string | null }` in `config-contract.ts`.
- `ConfigSnapshot.jira` is **always fully resolved**, like `notifications` — a
  consumer that had to remember to default is one that will eventually forget on one
  branch (`config-contract.ts:194-201`).
- `'jira'` joins `TOP_LEVEL_KEYS` in `parse.ts:85`, so a hand-written block is read
  rather than reported as an unknown key.
- `optionalJira()` mirrors `optionalNotifications()` (`parse.ts:271`), including its
  narrower forbidden-key message: a poisoned block costs the block, not the file.
- The write verb **spreads, never rebuilds** the block, and writes only the fields
  the request names.
- No `CONFIG_VERSION` bump. A new optional key is exactly what the existing scheme
  absorbs without one.

`jql` is deliberately absent. It is HIVE-69's, and adding a slot for it here would
be a field nothing reads.

## IPC

The connection settings are config, so they go through the config namespace and its
existing guarded write path. The credential is not, so it gets its own.

| Channel | Payload | Returns |
| --- | --- | --- |
| `config:set-jira` | `{ site?: string \| null; email?: string \| null }` | `ConfigSnapshot` |
| `jira:status` | none | `JiraStatus` |
| `jira:set-token` | `{ token: string }` | `JiraStatus` |
| `jira:clear-token` | none | `JiraStatus` |
| `jira:test` | none | `JiraResult<JiraIdentity>` |

```typescript
export interface JiraStatus {
  site: string | null;
  email: string | null;
  credential: JiraCredentialState;
  encryptionAvailable: boolean;
}

export interface JiraIdentity {
  displayName: string;
  accountId: string;
}
```

`window.hive.jira = { status, setToken, clearToken, test }`, plus
`window.hive.config.setJira`. `BRIDGE_KEYS`, `BRIDGE_CONFIG_KEYS` and a new
`BRIDGE_JIRA_KEYS` are updated; the surface test asserts them. No new event channel,
so `EVENT_CHANNELS` is untouched.

**The renderer can write a token and clear one. There is no verb that returns one.**
That is the whole point of the namespace being four verbs rather than five.

### Guards

Three new guards in `electron/shared/guards.ts`, in the house style — hand-written,
`assertShape` first, refusal naming the field.

**Site.** A bare hostname. A leading `https://` and a trailing `/` are stripped
first, because pasting the URL from the browser is what everyone will actually do,
and refusing it teaches nothing. After stripping, the value must match a hostname:
labels of `[A-Za-z0-9-]`, dot-separated, no port, no path, no userinfo, no
whitespace, bounded at 253. Anything else is refused rather than encoded and sent.
This guard is the only thing standing between a payload and the URL the credential
is attached to.

**Email.** Bounded, printable, no whitespace, exactly one `@`, and **no colon** — it
is the half of a Basic credential that appears before the separator, and a colon
inside it would silently move the boundary.

**Token.** Bounded at 1024, printable ASCII, no whitespace. Its refusal message
names the field and never echoes the value.

`null` is accepted and distinct from absent for `site` and `email`, following
`parseSetProjectRuntimeRequest` (`guards.ts:558`): without it the UI could set a
value but never take it back, and an emptied field would have to be stored as `""`.

## Renderer

`src/lib/jira.ts` mirrors `src/lib/project-config.ts` — module-level state, a
never-throw wrapper, `null` when there is no bridge (the browser demo is not a
failure, `project-config.ts:64-66`). Four functions: `readJiraStatus`,
`saveJiraToken`, `clearJiraToken`, `testJiraConnection`. `setJiraConnection` goes in
`project-config.ts` instead, next to `setNotificationPrefs`, because it returns a
`ConfigSnapshot` and needs that module's `mutate` to install it.

### Two components, not one

The story says "a Jira group in `integrations-section.tsx`". That file is already 275
lines; the two groups, four credential states, a test result and its failure copy
would push it past 500 and make a file that is currently readable stop being so.

So the groups are extracted: `jira-connection-group.tsx` and
`jira-credential-group.tsx` under `features/settings/components/`, rendered by
`integrations-section.tsx` between "Token source" and "Notifications". The pane the
user sees is exactly what the story describes; the file is not where it would have
had to grow.

### `SecretField`

A new atom, `src/components/ui/secret-field.tsx`. Not a `type="password"` prop on
`TextField`, because the semantics differ in a way that matters: this field is
**write-only**. It never displays a stored value, because there is none to display —
it shows what is stored as a *state*, and its input is always a new value replacing
the old one. A masked `TextField` would imply the value round-trips.

Props: `label`, `value`, `onChange`, `onCommit`, `placeholder`, `hint`, and a reveal
toggle so a pasted token can be checked before saving. Same labelling arrangement as
`TextField` (`htmlFor`, never a wrapping label) for the reason
`text-field.tsx:5-18` gives.

### Reading the status

Once on open, keyed on whether there is a snapshot — the pattern
`integrations-section.tsx:156-167` documents at length — and re-read after each of
the three mutating verbs, because each one changes the answer. Not polled: nothing
outside the app installs a Jira credential for it.

## Layout

Two `SettingsGroup`s, mirroring the existing "GitHub CLI" / "Token source" pair:

- **Jira site** — site and email, two `TextField`s, committed on blur or Enter like
  every other settings field (`text-field.tsx:24`).
- **API token** — the credential state line, a `SecretField`, Save and Clear, and
  the "Test connection" button with its verdict.

The split is the story's own argument made visible: the first group is ordinary
configuration that lives in a file you may hand-edit, the second is the one secret
that does not.

## Errors

| Condition | `kind` | What the pane says |
| --- | --- | --- |
| 401 | `unauthorized` | The credential is wrong, revoked, or for another account. **The stored token is not cleared** — a transient 401 must not destroy it. |
| 403 | `forbidden` | Authenticated but not permitted. Different fix, so different words. |
| 404 | `not-found` | The site name resolves but has no Jira. Usually a typo in the host. |
| `fetch` rejects | `offline` | Jira is unreachable. |
| `AbortSignal` | `timeout` | Ten seconds with no answer. |
| anything else | `unknown` | Reported, never thrown. |

No configuration at all is not an error state: the group renders its empty fields and
says what to fill in.

## Testing

`tests/` mirrors the source, per `CLAUDE.md`. The 80% gate covers only `src/**`
(`vitest.config.ts:34`), so the main-process tests below are required by this design
rather than enforced by the gate.

| File | What it proves |
| --- | --- |
| `tests/electron/main/integrations/jira/auth.test.ts` | All four states and their precedence; empty env var reads as unset; save/clear round-trip through a fake `SecretStore`; **the deep-scan test** |
| `tests/electron/main/integrations/jira/client.test.ts` | The Basic header is built correctly; the URL host comes from config; the timeout signal is attached; one case per error row; no response body reaches a message |
| `tests/electron/shared/guards.test.ts` | Site stripping and rejection, the colon rule on email, token bounds, `null`-vs-absent |
| `tests/electron/main/config/*.test.ts` | The `jira` block parses, defaults, survives an unknown sibling key, and is spread rather than rebuilt on write |
| `tests/electron/preload/*.test.ts` | The bridge surface has exactly the declared keys |
| `tests/lib/jira.test.ts` | No bridge returns `null`; a rejected channel does not throw |
| `tests/components/ui/secret-field.test.tsx` | Masking, the reveal toggle, commit on Enter and blur |
| `tests/features/settings/components/jira-*.test.tsx` | Each credential state renders its own copy; Clear calls the verb; a 401 leaves the stored state intact |
| `tests/e2e/electron/jira-settings.spec.ts` | The pane renders all four states, driven through `HIVE_CONFIG_PATH` and a stubbed credential |

**The test that guards the security property rather than a behaviour:** serialise
every value returned by `jira:status` and `jira:test` and assert the token string
does not appear anywhere in it. Written as an explicit deep scan, because that is the
invariant most easily lost in a refactor — a future field that "just includes the
config" would pass every behavioural test and break this one.

## Out of scope

Reading tickets (HIVE-68), the WORK tab (HIVE-69), transitions (HIVE-70), comments
(HIVE-71), and the JQL override field (HIVE-69). No polling, no background refresh,
no credential migration path — there is nothing yet to migrate from.
