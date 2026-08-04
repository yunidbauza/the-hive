# Add a Remote Repository by URL — Implementation Plan (HIVE-54, story 102)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user pastes a repository URL, picks a parent folder, watches `git clone` run in a terminal they can type into, and ends with the cloned directory registered as a project.

**Architecture:** Main owns the whole flow. A new `electron/main/clone/` module validates the URL, derives the target folder name from the URL itself (never from the renderer), spawns `git` through the existing sessions layer under a reserved entity id — which is what makes every existing PTY channel work for it — then writes the config on exit 0 and removes the directory on anything else. The renderer renders a focused sub-view inside Settings and streams the terminal through a transport that never self-spawns.

**Tech Stack:** Electron · TypeScript (strict) · React 19 · Zustand · Vitest · Playwright `_electron` · node-pty · Tailwind v4

**Spec:** `docs/superpowers/specs/2026-08-03-hive-54-settings-add-remote-repo-design.md`

## Global Constraints

- `pnpm lint` and `pnpm type-check` must both pass before any task is considered done. No rule may be disabled inline to make a task pass.
- 80% coverage on lines, statements, branches and functions. Do not add a coverage-ignore comment to get past the gate.
- `tests/` **mirrors** `src/` and `electron/`. No exceptions.
- kebab-case for every file and folder under `src/` and `electron/`.
- Absolute `@/`, `@shared`, `@features`, `@lib`, `@hooks`, `@stores` imports. Never relative parent imports (`../`) in `src/`. Main-process code uses relative imports, following the existing files in `electron/main/`.
- `electron/shared/**` is **types and constants only** — no runtime imports, no Node APIs, no DOM APIs.
- `CLONE_ENTITY_ID` is a **value** import in the renderer, and that is allowed. `app/CLAUDE.md` says the renderer imports from `@shared` "type-only", which overstates the rule: `scripts/verify-boundaries.mjs:331-338` carries an explicit ALLOWED probe importing `export const contract = 1` from `electron/shared/` into `src/`, and `electron/shared/**` is defined as "types **and constants** only". `config-contract.ts` already exports `CONFIG_VERSION`, `DEFAULT_PROJECT_ICON` and `emptySnapshot`. Do not "fix" this into a type import — it will not compile. `pnpm verify:boundaries` is the arbiter.
- Raw hex literals in component code are banned. Colour comes from `--cc-*` tokens via Tailwind utilities (`bg-panel`, `text-muted`, `border-soft`).
- `node-pty` is never loaded for real in unit tests. `__mocks__/node-pty.ts` holds the recording fake.
- Icons come from `@phosphor-icons/react`.
- Commit after every task.

---

### Task 1: URL parsing and folder-name derivation

Pure module, no I/O. This is the security boundary for argument injection, so it lands first and alone.

**Files:**
- Create: `app/electron/main/clone/parse-url.ts`
- Test: `app/tests/electron/main/clone/parse-url.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseCloneUrl(raw: unknown): CloneUrlVerdict` where
  `type CloneUrlVerdict = { ok: true; url: string; repoName: string } | { ok: false; reason: string }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

import { parseCloneUrl } from '../../../../electron/main/clone/parse-url';

describe('parseCloneUrl', () => {
  it('accepts an https URL and derives the folder name', () => {
    const verdict = parseCloneUrl('https://github.com/behiques/the-hive.git');
    expect(verdict).toEqual({
      ok: true,
      url: 'https://github.com/behiques/the-hive.git',
      repoName: 'the-hive',
    });
  });

  it('accepts an scp-style ssh URL', () => {
    const verdict = parseCloneUrl('git@github.com:behiques/the-hive.git');
    expect(verdict).toMatchObject({ ok: true, repoName: 'the-hive' });
  });

  it('accepts an ssh:// URL', () => {
    const verdict = parseCloneUrl('ssh://git@github.com/behiques/the-hive');
    expect(verdict).toMatchObject({ ok: true, repoName: 'the-hive' });
  });

  it('accepts a file:// URL, which the e2e fixture uses', () => {
    const verdict = parseCloneUrl('file:///tmp/fixture/the-hive.git');
    expect(verdict).toMatchObject({ ok: true, repoName: 'the-hive' });
  });

  it('accepts an absolute local path', () => {
    const verdict = parseCloneUrl('/tmp/fixture/the-hive.git');
    expect(verdict).toMatchObject({ ok: true, repoName: 'the-hive' });
  });

  it('strips a trailing slash before deriving the name', () => {
    const verdict = parseCloneUrl('https://github.com/behiques/the-hive/');
    expect(verdict).toMatchObject({ ok: true, repoName: 'the-hive' });
  });

  it('rejects a value starting with a dash, which git would read as a flag', () => {
    const verdict = parseCloneUrl('--upload-pack=touch /tmp/pwned');
    expect(verdict).toEqual({
      ok: false,
      reason: 'a repository URL cannot start with "-"',
    });
  });

  it('rejects the ext:: transport, which executes a shell command', () => {
    const verdict = parseCloneUrl('ext::sh -c "touch /tmp/pwned"');
    expect(verdict).toMatchObject({ ok: false });
  });

  it('rejects plaintext http with a message naming https', () => {
    const verdict = parseCloneUrl('http://github.com/behiques/the-hive.git');
    expect(verdict).toEqual({
      ok: false,
      reason: 'http:// is not encrypted — use https:// instead',
    });
  });

  it('rejects the git:// transport with a message naming https', () => {
    const verdict = parseCloneUrl('git://github.com/behiques/the-hive.git');
    expect(verdict).toEqual({
      ok: false,
      reason: 'git:// is not encrypted or authenticated — use https:// instead',
    });
  });

  it('rejects a URL with no derivable folder name', () => {
    const verdict = parseCloneUrl('https://github.com/');
    expect(verdict).toEqual({
      ok: false,
      reason: 'that URL does not name a repository',
    });
  });

  it('rejects a non-string', () => {
    expect(parseCloneUrl(42)).toMatchObject({ ok: false });
  });

  it('rejects an empty string', () => {
    expect(parseCloneUrl('   ')).toMatchObject({ ok: false });
  });

  it('rejects a control character', () => {
    expect(parseCloneUrl('https://example.com/a\nb.git')).toMatchObject({
      ok: false,
    });
  });

  it('rejects a name that would escape the parent directory', () => {
    expect(parseCloneUrl('https://example.com/a/..')).toMatchObject({
      ok: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && pnpm vitest run tests/electron/main/clone/parse-url.test.ts`
Expected: FAIL — cannot resolve `../../../../electron/main/clone/parse-url`

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Validating a clone URL, and deriving the folder it becomes (story 102).
 *
 * Two jobs in one module because they are the same question asked twice: a URL
 * this rejects has no folder name, and a URL with no folder name is one we
 * cannot clone. Splitting them would let a caller take the name from a URL that
 * was never accepted.
 *
 * Pure, and deliberately the only place either rule lives. `git` is spawned with
 * an argv array so no quoting rule can turn a URL into a command — but argv does
 * nothing about a URL that *is* a flag, and `--upload-pack=…` and `ext::sh -c …`
 * are both remote-code-execution in a single string. That is what the leading-`-`
 * and transport checks below are for.
 */

export type CloneUrlVerdict =
  | { ok: true; url: string; repoName: string }
  | { ok: false; reason: string };

/**
 * Transports that carry no encryption or no authentication.
 *
 * Rejected with a message naming `https` rather than silently, because a user
 * pasting `git://` has a working URL in their hand and deserves to know why it
 * is refused.
 */
const REFUSED_SCHEMES: Record<string, string> = {
  'http:': 'http:// is not encrypted — use https:// instead',
  'git:': 'git:// is not encrypted or authenticated — use https:// instead',
};

/** Schemes we clone from. `file:` is also what the e2e suite uses. */
const ALLOWED_SCHEMES = new Set(['https:', 'ssh:', 'file:']);

/** `user@host:path/to/repo.git` — git's scp-like syntax, which has no scheme. */
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:(?!\/)/;

function fail(reason: string): CloneUrlVerdict {
  return { ok: false, reason };
}

/**
 * The last path segment, with `.git` and any trailing slashes removed.
 *
 * Returns `null` rather than a fallback name. A URL we cannot name a folder
 * from is a URL the user mistyped, and inventing `repo` for it would clone
 * something they did not ask for into a directory they did not expect.
 */
function deriveRepoName(value: string): string | null {
  const withoutQuery = value.split(/[?#]/)[0] ?? '';
  const trimmed = withoutQuery.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  const lastColon = trimmed.lastIndexOf(':');
  const cut = Math.max(lastSlash, lastColon);
  const segment = cut === -1 ? trimmed : trimmed.slice(cut + 1);
  const name = segment.replace(/\.git$/i, '');

  if (name === '' || name === '.' || name === '..') return null;
  // A separator surviving into the folder name would let a URL choose where in
  // the filesystem the clone lands, which is the one thing main must decide.
  if (name.includes('/') || name.includes('\\')) return null;
  return name;
}

export function parseCloneUrl(raw: unknown): CloneUrlVerdict {
  if (typeof raw !== 'string') return fail('expected a repository URL');

  const url = raw.trim();
  if (url === '') return fail('enter a repository URL');

  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(url)) {
    return fail('that URL contains a control character');
  }

  /**
   * The check that closes argument injection.
   *
   * `git clone -- <url>` already stops a flag being read as one, and this module
   * is not the only guard. It is still refused here so the rejection has a
   * message, and so the rule survives anyone later changing how git is invoked.
   */
  if (url.startsWith('-')) return fail('a repository URL cannot start with "-"');

  if (SCP_LIKE.test(url)) {
    const repoName = deriveRepoName(url);
    return repoName === null
      ? fail('that URL does not name a repository')
      : { ok: true, url, repoName };
  }

  // An absolute local path — a bare repo on this machine. No scheme to check.
  if (url.startsWith('/')) {
    const repoName = deriveRepoName(url);
    return repoName === null
      ? fail('that path does not name a repository')
      : { ok: true, url, repoName };
  }

  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    return fail('that is not a repository URL');
  }

  const refusal = REFUSED_SCHEMES[scheme];
  if (refusal !== undefined) return fail(refusal);
  if (!ALLOWED_SCHEMES.has(scheme)) {
    return fail(`${scheme}// repositories are not supported — use https://`);
  }

  const repoName = deriveRepoName(url);
  return repoName === null
    ? fail('that URL does not name a repository')
    : { ok: true, url, repoName };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && pnpm vitest run tests/electron/main/clone/parse-url.test.ts`
Expected: PASS — 15 tests

Note: `ext::sh -c "…"` has no `//`, so `new URL()` parses its protocol as `ext:`, which is neither refused-by-name nor allowed — it falls through to the `not supported` branch. That is the assertion `toMatchObject({ ok: false })` covers.

- [ ] **Step 5: Run lint and type-check**

Run: `cd app && pnpm lint && pnpm type-check`
Expected: both clean

- [ ] **Step 6: Commit**

```bash
cd app
git add electron/main/clone/parse-url.ts tests/electron/main/clone/parse-url.test.ts
git commit -m "feat(clone): validate clone URLs and derive the target folder name (HIVE-54)"
```

---

### Task 2: The shared contract and its payload guard

Types, constants and the guard. Nothing here executes a clone; every later task imports from it.

**Files:**
- Modify: `app/electron/shared/config-contract.ts`
- Modify: `app/electron/shared/ipc-contract.ts`
- Modify: `app/electron/shared/guards.ts`
- Test: `app/tests/electron/shared/guards.test.ts` (existing file — add a describe block)

**Interfaces:**
- Consumes: `ConfigSnapshot` from `config-contract.ts`.
- Produces:
  - `CLONE_ENTITY_ID: 'hive:clone'`
  - `interface CloneRequest { url: string; parentPath: string; cols: number; rows: number }`
  - `type CloneStartResult = { ok: true; targetPath: string } | { ok: false; reason: string }`
  - `interface CloneDoneEvent { ok: boolean; targetPath: string | null; reason: string | null; snapshot: ConfigSnapshot }`
  - `CH.configCloneStart = 'config:clone-start'`, `CH.configCloneCancel = 'config:clone-cancel'`, `CH.configCloneDone = 'config:clone-done'`
  - `parseCloneRequest(input: unknown): CloneRequest`
  - `HiveBridge.config.startClone`, `.cancelClone`, `.onCloneDone`

- [ ] **Step 1: Write the failing test**

Add to `app/tests/electron/shared/guards.test.ts`:

```ts
describe('parseCloneRequest', () => {
  const valid = {
    url: 'https://github.com/behiques/the-hive.git',
    parentPath: '/Users/me/Projects',
    cols: 80,
    rows: 24,
  };

  it('accepts a well-formed request', () => {
    expect(parseCloneRequest(valid)).toEqual(valid);
  });

  it('rejects a missing key', () => {
    expect(() => parseCloneRequest({ ...valid, url: undefined })).toThrow();
  });

  it('rejects an unknown key', () => {
    expect(() => parseCloneRequest({ ...valid, destination: '/etc' })).toThrow();
  });

  it('rejects __proto__', () => {
    const payload = JSON.parse(
      '{"url":"https://x/y.git","parentPath":"/p","cols":80,"rows":24,"__proto__":{"polluted":true}}',
    ) as unknown;
    expect(() => parseCloneRequest(payload)).toThrow();
  });

  it('rejects a non-string url', () => {
    expect(() => parseCloneRequest({ ...valid, url: 42 })).toThrow();
  });

  it('rejects a non-integer cols', () => {
    expect(() => parseCloneRequest({ ...valid, cols: 1.5 })).toThrow();
  });

  it('rejects a zero rows', () => {
    expect(() => parseCloneRequest({ ...valid, rows: 0 })).toThrow();
  });
});
```

Add `parseCloneRequest` to the existing import at the top of that test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && pnpm vitest run tests/electron/shared/guards.test.ts`
Expected: FAIL — `parseCloneRequest` is not exported

- [ ] **Step 3: Write minimal implementation**

In `app/electron/shared/config-contract.ts`, append:

```ts
/**
 * The entity id a clone's terminal runs under (story 102).
 *
 * Reserved, single, and not a real entity: it is the id the existing PTY
 * channels carry clone traffic on, which is what lets the clone terminal be
 * *typable* — `pty:write` routes through the sessions layer's id translation
 * (`electron/main/ipc/index.ts`), so a clone that bypassed the registry would
 * stream output fine and silently swallow every keystroke, and no credential
 * prompt could ever be answered.
 *
 * Being a single id also caps concurrency at one clone, which the focused
 * sub-view already implies.
 *
 * The `hive:` prefix cannot collide with a project-derived entity id — story
 * 101's `deriveProjectId` builds ids from directory basenames.
 */
export const CLONE_ENTITY_ID = 'hive:clone';

/**
 * Payload of `config:clone-start` (story 102).
 *
 * Note what is **absent**: a destination. The renderer supplies the *parent*
 * directory and the URL; main derives the final path segment from the URL
 * itself. That is how this story keeps the epic's rule that no verb takes a
 * destination path (`stories/100-settings-epic.md:86`) while still writing a
 * directory tree.
 *
 * `parentPath` is re-validated in main from scratch — expanded, made absolute,
 * `realpath`'d, confirmed to be a directory — exactly like `AddProjectRequest`.
 */
export interface CloneRequest {
  url: string;
  parentPath: string;
  /** The terminal's size at the moment the clone starts. */
  cols: number;
  rows: number;
}

/**
 * What `startClone` answers with.
 *
 * Pre-flight only. It resolves as soon as the process is spawned — the clone
 * itself streams through `pty:data` and concludes on {@link CloneDoneEvent}.
 * `targetPath` is returned so the view can name the folder it is creating.
 */
export type CloneStartResult =
  | { ok: true; targetPath: string }
  | { ok: false; reason: string };

/**
 * How a clone ended (story 102).
 *
 * Carries the fresh snapshot for the same reason every mutating config verb
 * returns one: the renderer must never have to follow a write with a reload,
 * and must never render a list the write already invalidated. On failure the
 * snapshot is the unchanged current one.
 */
export interface CloneDoneEvent {
  ok: boolean;
  /** The directory that now exists, or `null` when the clone failed. */
  targetPath: string | null;
  /** Why it failed, or `null` on success. */
  reason: string | null;
  snapshot: ConfigSnapshot;
}
```

In `app/electron/shared/ipc-contract.ts`:

1. Extend the type import from `./config-contract` with `CloneDoneEvent`, `CloneRequest`, `CloneStartResult`.
2. Add to `CH`, after `configRemoveProject`:

```ts
  /** Story 102's clone verbs. See `CloneRequest` for why there is no destination. */
  configCloneStart: 'config:clone-start',
  configCloneCancel: 'config:clone-cancel',
  configCloneDone: 'config:clone-done', // main → renderer
```

3. Add `CH.configCloneDone` to `EVENT_CHANNELS`.
4. Add to `HiveBridge.config`:

```ts
    /**
     * Start a clone (story 102). Resolves once `git` is running, not once it
     * has finished — completion arrives on {@link HiveBridge.config.onCloneDone}.
     */
    startClone(request: CloneRequest): Promise<CloneStartResult>;
    /** Kill a running clone and remove the directory it had created. */
    cancelClone(): Promise<void>;
    /** Returns its own unsubscribe. Callers MUST invoke it on unmount. */
    onCloneDone(callback: (event: CloneDoneEvent) => void): () => void;
```

In `app/electron/shared/guards.ts`, add `CloneRequest` to the type imports and append:

```ts
/**
 * Payload guard for `config:clone-start` (story 102).
 *
 * `url` gets `assertPath`'s permissiveness rather than `assertText`'s bounds:
 * it is about to be handed to `parseCloneUrl`, which is the guard that actually
 * decides whether it is a URL. Two validators disagreeing about what a URL may
 * contain is how a rule gets quietly relaxed — this one proves the *shape*, and
 * `parseCloneUrl` proves the *value*.
 */
export function parseCloneRequest(input: unknown): CloneRequest {
  const raw = assertShape(
    input,
    ['url', 'parentPath', 'cols', 'rows'],
    'startClone',
  );
  return {
    url: assertPath(raw.url, 'startClone.url'),
    parentPath: assertPath(raw.parentPath, 'startClone.parentPath'),
    cols: assertDimension(raw.cols, 'startClone.cols'),
    rows: assertDimension(raw.rows, 'startClone.rows'),
  };
}
```

If `guards.ts` has no `assertDimension`, reuse whatever `parseResizeRequest` (line 190) already uses for `cols`/`rows` — read it first and call the same helper. Do not add a second dimension validator.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && pnpm vitest run tests/electron/shared/guards.test.ts`
Expected: PASS

- [ ] **Step 5: Verify the bridge surface test still passes**

The exact top-level key set of `window.hive` is asserted somewhere in the suite (`BRIDGE_KEYS`). These verbs hang off the existing `config` key, so `BRIDGE_KEYS` is unchanged.

Run: `cd app && pnpm vitest run && pnpm lint && pnpm type-check`
Expected: all pass. Type-check will still fail on `preload/index.ts` not implementing the three new `HiveBridge.config` members — **that is expected here**; implement it in Task 5 and leave this task's commit type-clean by adding the preload members as part of this task instead. Concretely: also add to `app/electron/preload/index.ts` inside `config: {`:

```ts
    startClone: (request: CloneRequest): Promise<CloneStartResult> =>
      ipcRenderer.invoke(CH.configCloneStart, request),
    cancelClone: (): Promise<void> => ipcRenderer.invoke(CH.configCloneCancel),
    onCloneDone: (callback: (event: CloneDoneEvent) => void): (() => void) =>
      subscribe(CH.configCloneDone, callback),
```

Use whatever helper the existing `pty.onData` / `pty.onExit` use for event subscription — read `preload/index.ts` and follow it exactly rather than writing a new one. Add the three types to its type imports.

- [ ] **Step 6: Commit**

```bash
cd app
git add electron/shared/ electron/preload/index.ts tests/electron/shared/guards.test.ts
git commit -m "feat(clone): clone contract, channels, payload guard and bridge verbs (HIVE-54)"
```

---

### Task 3: `sessions.openCommand` — a session that runs an arbitrary command

Refactor, not a parallel path. `open()` keeps its behaviour and delegates.

**Files:**
- Modify: `app/electron/main/sessions/index.ts`
- Test: `app/tests/electron/main/sessions/index.test.ts` (existing — add a describe block)

**Interfaces:**
- Consumes: `SessionRegistry.open/close/size`, `PtyIpc.spawn/kill`, `ExitEvent`.
- Produces, on the `Sessions` interface:

```ts
  /**
   * Spawn a bare command in a PTY — no project, no bootstrap, no activity.
   * `onExit` fires once, for whichever of exit or host-loss happens first.
   */
  openCommand(request: OpenCommandRequest): void;
```

```ts
export interface OpenCommandRequest {
  entityId: string;
  cwd: string;
  file: string;
  args: string[];
  cols: number;
  rows: number;
  onExit: (result: CommandExit) => void;
}

export interface CommandExit {
  /** `-1` when nothing ran or nothing concluded. Never a real status then. */
  exitCode: number;
  /** The host died under a process that may still have been working. */
  lost: boolean;
  /** A host-level failure message — set when the binary could not start. */
  message?: string;
}
```

**Why `message` exists — verified, not assumed.** When `node-pty` cannot start
the binary, `electron/pty-host/session-manager.ts:210-233` catches the throw and
emits `{ type: 'error', sessionId, message }`. That is **not an exit**: the
supervisor routes it to `onError` (`supervisor.ts:261-263`), and today the only
subscriber logs it and stops (`electron/main/ipc/pty.ts:265-269`). So a missing
`git` produces no `pty:exit` at all — without the subscription added in Step 3
below, `onExit` never fires and the clone view spins forever.

- [ ] **Step 1: Write the failing test**

Follow the existing file's setup helpers for `createSessions` (fake supervisor, `send` spy, `config` stub). Add:

```ts
describe('openCommand', () => {
  it('spawns the given file and args in the given cwd', () => {
    const { sessions, supervisor } = makeSessions();

    sessions.openCommand({
      entityId: 'hive:clone',
      cwd: '/Users/me/Projects',
      file: 'git',
      args: ['clone', '--progress', '--', 'https://x/y.git', 'y'],
      cols: 80,
      rows: 24,
      onExit: () => {},
    });

    expect(supervisor.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        shell: 'git',
        args: ['clone', '--progress', '--', 'https://x/y.git', 'y'],
        cwd: '/Users/me/Projects',
        cols: 80,
        rows: 24,
      }),
    );
  });

  it('does not arm the claude bootstrap', () => {
    const { sessions, supervisor } = makeSessions();

    sessions.openCommand({
      entityId: 'hive:clone',
      cwd: '/tmp',
      file: 'git',
      args: ['clone'],
      cols: 80,
      rows: 24,
      onExit: () => {},
    });

    // The bootstrap writes `claudeCommand` into the pty once output appears.
    // Feeding it output must produce no write at all.
    emitData(supervisor, 'hive:clone', 'Cloning into ...\r\n');
    expect(supervisor.write).not.toHaveBeenCalled();
  });

  it('calls onExit with the exit code', () => {
    const { sessions, supervisor } = makeSessions();
    const onExit = vi.fn();

    sessions.openCommand({
      entityId: 'hive:clone',
      cwd: '/tmp',
      file: 'git',
      args: ['clone'],
      cols: 80,
      rows: 24,
      onExit,
    });

    emitExit(supervisor, 'hive:clone', 0);
    expect(onExit).toHaveBeenCalledWith({ exitCode: 0, lost: false });
  });

  it('calls onExit with lost when the host dies under it', () => {
    const { sessions, supervisor } = makeSessions();
    const onExit = vi.fn();

    sessions.openCommand({
      entityId: 'hive:clone',
      cwd: '/tmp',
      file: 'git',
      args: ['clone'],
      cols: 80,
      rows: 24,
      onExit,
    });

    emitLost(supervisor, 'hive:clone');
    expect(onExit).toHaveBeenCalledWith({ exitCode: -1, lost: true });
  });

  it('calls onExit when the binary could not start', () => {
    const { sessions, supervisor } = makeSessions();
    const onExit = vi.fn();

    sessions.openCommand({
      entityId: 'hive:clone',
      cwd: '/tmp',
      file: 'git',
      args: ['clone'],
      cols: 80,
      rows: 24,
      onExit,
    });

    // What the host emits when node-pty cannot spawn the file. No exit follows.
    emitError(supervisor, 'hive:clone', 'could not start git in /tmp: ENOENT');

    expect(onExit).toHaveBeenCalledWith({
      exitCode: -1,
      lost: false,
      message: 'could not start git in /tmp: ENOENT',
    });
  });

  it('calls onExit exactly once', () => {
    const { sessions, supervisor } = makeSessions();
    const onExit = vi.fn();

    sessions.openCommand({
      entityId: 'hive:clone',
      cwd: '/tmp',
      file: 'git',
      args: ['clone'],
      cols: 80,
      rows: 24,
      onExit,
    });

    emitExit(supervisor, 'hive:clone', 1);
    emitExit(supervisor, 'hive:clone', 1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('refuses when the session cap is reached', () => {
    const { sessions } = makeSessions({ maxSessions: 0 });
    expect(() =>
      sessions.openCommand({
        entityId: 'hive:clone',
        cwd: '/tmp',
        file: 'git',
        args: ['clone'],
        cols: 80,
        rows: 24,
        onExit: () => {},
      }),
    ).toThrow(/capacity/i);
  });

  it('routes write to the command session', () => {
    const { sessions, supervisor } = makeSessions();
    sessions.openCommand({
      entityId: 'hive:clone',
      cwd: '/tmp',
      file: 'git',
      args: ['clone'],
      cols: 80,
      rows: 24,
      onExit: () => {},
    });

    sessions.write('hive:clone', 'password\r');
    expect(supervisor.write).toHaveBeenCalledWith(
      expect.any(String),
      'password\r',
    );
  });
});
```

`makeSessions`, `emitData`, `emitExit` and `emitLost` may already exist in this test file under different names — **read the file first and reuse its helpers** rather than adding duplicates. If they do not exist, write them at the top of the new describe block using the same fake-supervisor shape the existing tests use.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && pnpm vitest run tests/electron/main/sessions/index.test.ts`
Expected: FAIL — `sessions.openCommand is not a function`

- [ ] **Step 3: Write minimal implementation**

In `app/electron/main/sessions/index.ts`:

1. Add the exported request type near `OpenRequest`:

```ts
/**
 * A PTY that runs a command rather than a session (story 102).
 *
 * Everything `OpenRequest` resolves — a project, a shell, a bootstrap — is
 * absent here on purpose. The caller has already decided what to run and where,
 * because the only caller is the clone flow, and a clone's cwd is a directory
 * *it* validated and whose child does not exist yet. Routing it through
 * `open()` would hit the `unmapped` refusal, which is correct for a session and
 * wrong for this.
 */
export interface OpenCommandRequest {
  entityId: string;
  cwd: string;
  file: string;
  args: string[];
  cols: number;
  rows: number;
  /** Fires once, for whichever of exit or host-loss happens first. */
  onExit: (result: { exitCode: number; lost: boolean }) => void;
}
```

2. Add `openCommand(request: OpenCommandRequest): void;` to the `Sessions` interface, with the doc comment from the Interfaces block above.

3. Inside `createSessions`, add the callback registry next to `heldInput`:

```ts
  /**
   * Exit callbacks for command sessions (story 102).
   *
   * Kept out of `exitWaiters` deliberately: those resolve `void` for the restart
   * ordering and may hold several waiters, where this is one owner that needs
   * the *code*. Deleted before it is invoked so a re-entrant call cannot fire it
   * twice.
   */
  const commandExit = new Map<string, (result: CommandExit) => void>();

  function settleCommand(entityId: string, result: CommandExit): void {
    const onExit = commandExit.get(entityId);
    if (!onExit) return;
    commandExit.delete(entityId);
    onExit(result);
  }
```

And the subscription that catches a binary which never started. Put it beside
the `ptyIpc` construction, and keep its disposer so `dispose()` can drop it:

```ts
  /**
   * A host error for a command session is that command's ending.
   *
   * `node-pty` failing to spawn emits `{ type: 'error' }` and **no exit** — so
   * for `openCommand` this is the only signal that will ever arrive. A session
   * does not need this (its surface shows the empty terminal and the user can
   * restart), but a clone does: without it, `git` not being on `PATH` leaves the
   * clone view spinning on a process that was never created.
   */
  const disposeErrors = supervisor.onError((event) => {
    if (event.sessionId === undefined) return;
    const entityId = registry.entityFor(event.sessionId);
    if (entityId === undefined) return;
    settleCommand(entityId, {
      exitCode: -1,
      lost: false,
      message: event.message,
    });
    settleExit(entityId);
  });
```

Call `disposeErrors()` inside the existing `dispose()`.

4. In `forward`, call it from both terminal branches — in `case CH.ptyExit`, immediately before `settleExit(entityId)`:

```ts
        settleCommand(entityId, { exitCode: data.exitCode, lost: false });
```

and in `case CH.ptyLost`, immediately before `settleExit(entityId)`:

```ts
        // No code: nothing concluded. `-1` is the sentinel the clone flow reads
        // as "did not finish", never as an exit status.
        settleCommand(entityId, { exitCode: -1, lost: true });
```

5. Extract the spawn tail. Replace the body of `spawn()` after the project resolution and `activity.forget(request.entityId)` with a call to a new private helper, and add `openCommand`:

```ts
  /**
   * Mint a session and start a process. The one place a PTY is spawned.
   *
   * Both entry points funnel through here so there is no second way to start a
   * process — the capacity check and the host-blocked check must apply to a
   * clone exactly as they apply to a session.
   */
  function startProcess(request: {
    entityId: string;
    cwd: string;
    file: string;
    args: string[];
    cols: number;
    rows: number;
  }): void {
    if (registry.size() >= maxSessions) {
      throw new Error(spawnRefusal({ reason: 'at-capacity', limit: maxSessions }));
    }
    if (supervisor.isBlocked()) {
      throw new Error(spawnRefusal({ reason: 'host-unavailable' }));
    }

    const sessionId = registry.open(request.entityId);

    ptyIpc.spawn({
      sessionId,
      shell: request.file,
      args: request.args,
      cwd: request.cwd,
      env: {},
      cols: request.cols,
      rows: request.rows,
    });
  }
```

Then `spawn()` keeps its project lookup, its refusals, `activity.forget(...)`, and its trailing `bootstrap.arm(...)`, but delegates the middle to `startProcess({ entityId: request.entityId, cwd: project.path, file: snapshot.shell, args: LOGIN_SHELL_ARGS, cols: request.cols, rows: request.rows })`. Keep the existing capacity and host-blocked checks where they are **or** rely on `startProcess` — but not both. Prefer moving them into `startProcess` and deleting them from `spawn`, so the two paths cannot drift.

Finally, in the returned object:

```ts
    openCommand(request) {
      commandExit.set(request.entityId, request.onExit);
      try {
        startProcess(request);
      } catch (cause) {
        // The callback owns every ending, including "it never started" — a
        // caller that had to handle a throw *and* a callback would have two
        // cleanup paths and would eventually only implement one.
        commandExit.delete(request.entityId);
        throw cause;
      }
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && pnpm vitest run tests/electron/main/sessions/`
Expected: PASS — the new describe block **and** every pre-existing session test, unchanged. If an existing test broke, the refactor changed behaviour; fix the refactor, not the test.

- [ ] **Step 5: Run the full check**

Run: `cd app && pnpm test && pnpm lint && pnpm type-check`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
cd app
git add electron/main/sessions/index.ts tests/electron/main/sessions/index.test.ts
git commit -m "feat(sessions): openCommand — a PTY that runs a command, not a session (HIVE-54)"
```

---

### Task 4: The clone orchestrator

Pre-flight, spawn, exit handling, config write, cleanup. The heart of the story.

**Files:**
- Create: `app/electron/main/clone/index.ts`
- Modify: `app/electron/main/config/index.ts` (add the `origin` parameter to `addProject`)
- Test: `app/tests/electron/main/clone/index.test.ts`

**Interfaces:**
- Consumes: `parseCloneUrl` (Task 1), `CloneRequest`/`CloneStartResult`/`CloneDoneEvent`/`CLONE_ENTITY_ID` (Task 2), `Sessions.openCommand` (Task 3), `resolveProject` from `../config/resolve`, `addProject`/`getConfig` from `../config`.
- Produces:

```ts
export interface CloneFlow {
  start(request: CloneRequest): CloneStartResult;
  cancel(): void;
  /** Kill and clean up a clone in flight. Called on app quit. */
  dispose(): void;
}
export function createCloneFlow(options: CloneFlowOptions): CloneFlow;
export interface CloneFlowOptions {
  sessions: Pick<Sessions, 'openCommand' | 'kill'>;
  /** Injected so the test never touches a real filesystem. */
  fs?: { existsSync(p: string): boolean; rmSync(p: string, o: { recursive: true; force: true }): void };
  addProject?: (request: AddProjectRequest, origin: ProjectOrigin) => ConfigSnapshot;
  getConfig?: () => ConfigSnapshot;
  emit: (event: CloneDoneEvent) => void;
}
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';

import { CLONE_ENTITY_ID, emptySnapshot } from '../../../../electron/shared/config-contract';
import { createCloneFlow } from '../../../../electron/main/clone';

function makeFlow(overrides: Partial<Parameters<typeof createCloneFlow>[0]> = {}) {
  const openCommand = vi.fn();
  const kill = vi.fn();
  const emit = vi.fn();
  const rmSync = vi.fn();
  const snapshot = emptySnapshot('/Users/me/.hive/config.json');
  const addProject = vi.fn().mockReturnValue(snapshot);

  const flow = createCloneFlow({
    sessions: { openCommand, kill },
    // The parent exists; the target does not.
    fs: {
      existsSync: (p: string) => p === '/Users/me/Projects',
      rmSync,
    },
    addProject,
    getConfig: () => snapshot,
    emit,
    ...overrides,
  });

  return { flow, openCommand, kill, emit, rmSync, addProject, snapshot };
}

const request = {
  url: 'https://github.com/behiques/the-hive.git',
  parentPath: '/Users/me/Projects',
  cols: 80,
  rows: 24,
};

describe('createCloneFlow', () => {
  it('spawns git with an argv array and a -- terminator', () => {
    const { flow, openCommand } = makeFlow();
    const result = flow.start(request);

    expect(result).toEqual({
      ok: true,
      targetPath: '/Users/me/Projects/the-hive',
    });
    expect(openCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: CLONE_ENTITY_ID,
        cwd: '/Users/me/Projects',
        file: 'git',
        args: [
          'clone',
          '--progress',
          '--',
          'https://github.com/behiques/the-hive.git',
          'the-hive',
        ],
      }),
    );
  });

  it('refuses a bad URL before spawning anything', () => {
    const { flow, openCommand } = makeFlow();
    const result = flow.start({ ...request, url: '--upload-pack=x' });

    expect(result).toMatchObject({ ok: false });
    expect(openCommand).not.toHaveBeenCalled();
  });

  it('refuses when the target already exists', () => {
    const { flow, openCommand } = makeFlow({
      fs: { existsSync: () => true, rmSync: vi.fn() },
    });
    const result = flow.start(request);

    expect(result).toEqual({
      ok: false,
      reason:
        '/Users/me/Projects/the-hive already exists — choose another folder',
    });
    expect(openCommand).not.toHaveBeenCalled();
  });

  it('refuses a second clone while one is running', () => {
    const { flow } = makeFlow();
    flow.start(request);
    expect(flow.start(request)).toMatchObject({ ok: false });
  });

  it('adds the project with origin cloned on exit 0', () => {
    const { flow, openCommand, addProject, emit, snapshot } = makeFlow();
    flow.start(request);

    openCommand.mock.calls[0][0].onExit({ exitCode: 0, lost: false });

    expect(addProject).toHaveBeenCalledWith(
      { path: '/Users/me/Projects/the-hive' },
      'cloned',
    );
    expect(emit).toHaveBeenCalledWith({
      ok: true,
      targetPath: '/Users/me/Projects/the-hive',
      reason: null,
      snapshot,
    });
  });

  it('removes the directory and writes nothing on a non-zero exit', () => {
    const { flow, openCommand, addProject, rmSync, emit } = makeFlow();
    flow.start(request);

    openCommand.mock.calls[0][0].onExit({ exitCode: 128, lost: false });

    expect(addProject).not.toHaveBeenCalled();
    expect(rmSync).toHaveBeenCalledWith('/Users/me/Projects/the-hive', {
      recursive: true,
      force: true,
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, targetPath: null }),
    );
  });

  it('surfaces a host failure message verbatim when git could not start', () => {
    const { flow, openCommand, emit, rmSync } = makeFlow();
    flow.start(request);

    openCommand.mock.calls[0][0].onExit({
      exitCode: -1,
      lost: false,
      message: 'could not start git in /Users/me/Projects: ENOENT',
    });

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        reason: 'could not start git in /Users/me/Projects: ENOENT',
      }),
    );
    expect(rmSync).toHaveBeenCalled();
  });

  it('treats a lost host as a failure', () => {
    const { flow, openCommand, rmSync } = makeFlow();
    flow.start(request);

    openCommand.mock.calls[0][0].onExit({ exitCode: -1, lost: true });
    expect(rmSync).toHaveBeenCalled();
  });

  it('cancel kills the session and cleans up', () => {
    const { flow, openCommand, kill, rmSync } = makeFlow();
    flow.start(request);

    flow.cancel();
    expect(kill).toHaveBeenCalledWith(CLONE_ENTITY_ID);

    openCommand.mock.calls[0][0].onExit({ exitCode: 143, lost: false });
    expect(rmSync).toHaveBeenCalled();
  });

  it('cancel with no clone running does nothing', () => {
    const { flow, kill } = makeFlow();
    flow.cancel();
    expect(kill).not.toHaveBeenCalled();
  });

  it('allows a new clone after one finished', () => {
    const { flow, openCommand } = makeFlow();
    flow.start(request);
    openCommand.mock.calls[0][0].onExit({ exitCode: 0, lost: false });

    expect(flow.start(request)).toMatchObject({ ok: true });
  });

  it('refuses when the parent path does not resolve', () => {
    const { flow, openCommand } = makeFlow({
      fs: { existsSync: () => false, rmSync: vi.fn() },
    });
    expect(flow.start(request)).toMatchObject({ ok: false });
    expect(openCommand).not.toHaveBeenCalled();
  });

  it('dispose kills and cleans up a clone in flight', () => {
    const { flow, kill, rmSync } = makeFlow();
    flow.start(request);

    flow.dispose();
    expect(kill).toHaveBeenCalledWith(CLONE_ENTITY_ID);
    expect(rmSync).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && pnpm vitest run tests/electron/main/clone/index.test.ts`
Expected: FAIL — cannot resolve `../../../../electron/main/clone`

- [ ] **Step 3: Write the implementation**

First, `app/electron/main/config/index.ts` — give `addProject` an origin:

```ts
export function addProject(
  request: AddProjectRequest,
  /**
   * Where this entry came from. **Main-internal, never from the payload.**
   *
   * `parseAddProjectRequest` does not accept an `origin`, so a renderer cannot
   * claim a hand-picked folder was cloned. The only caller that passes anything
   * but the default is the clone flow, which knows because it ran the clone.
   */
  origin: ProjectOrigin = 'local',
): ConfigSnapshot {
```

and change the written entry's `origin: 'local'` (line ~224) to `origin,`. Import `ProjectOrigin` as a type.

Then `app/electron/main/clone/index.ts`:

```ts
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type {
  AddProjectRequest,
  CloneDoneEvent,
  CloneRequest,
  CloneStartResult,
  ConfigSnapshot,
  ProjectOrigin,
} from '@shared/config-contract';
import { CLONE_ENTITY_ID } from '@shared/config-contract';

import { addProject as addProjectToConfig, getConfig as readConfig } from '../config';
import { resolveProject } from '../config/resolve';
import type { Sessions } from '../sessions';

import { parseCloneUrl } from './parse-url';

/**
 * Cloning a remote repository (story 102).
 *
 * Main owns the whole flow — the renderer starts one and renders what comes
 * back. It does not decide when the clone succeeded, does not write the config,
 * and never supplies the destination. Putting the success criterion in the
 * renderer would make a config write depend on a process that may have been
 * closed, and letting it name a directory would hand it the one capability the
 * epic's "no verb takes a destination path" rule exists to withhold
 * (`stories/100-settings-epic.md:86`).
 *
 * What main derives, and the renderer never sends:
 *
 * - the folder name, from the URL (`parse-url.ts`);
 * - the target, by joining that onto a `realpath`'d parent;
 * - whether it succeeded, from `git`'s exit code.
 */

export interface CloneFlowOptions {
  sessions: Pick<Sessions, 'openCommand' | 'kill'>;
  emit: (event: CloneDoneEvent) => void;
  /** Injected so tests never touch a real filesystem. */
  fs?: {
    existsSync(path: string): boolean;
    rmSync(path: string, options: { recursive: true; force: true }): void;
  };
  addProject?: (
    request: AddProjectRequest,
    origin: ProjectOrigin,
  ) => ConfigSnapshot;
  getConfig?: () => ConfigSnapshot;
}

export interface CloneFlow {
  start(request: CloneRequest): CloneStartResult;
  cancel(): void;
  /** Kill and clean up a clone in flight. Called on app quit. */
  dispose(): void;
}

/** The clone in flight. `null` when none is. */
interface InFlight {
  targetPath: string;
}

export function createCloneFlow(options: CloneFlowOptions): CloneFlow {
  const {
    sessions,
    emit,
    fs = { existsSync, rmSync },
    addProject = addProjectToConfig,
    getConfig = readConfig,
  } = options;

  let inFlight: InFlight | null = null;

  function refuse(reason: string): CloneStartResult {
    return { ok: false, reason };
  }

  /**
   * Remove the directory this flow created.
   *
   * `git` cleans up after its own ordinary failures, but not after `SIGKILL`
   * and not when the app quits underneath it — which are exactly the two cases
   * that would otherwise leave a half-clone the user has to find and delete by
   * hand. `force` so a clone that failed before creating anything is not an
   * error in its own cleanup.
   */
  function cleanup(targetPath: string): void {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }

  function finish(ok: boolean, targetPath: string, reason: string | null): void {
    inFlight = null;

    if (!ok) {
      cleanup(targetPath);
      emit({ ok: false, targetPath: null, reason, snapshot: getConfig() });
      return;
    }

    const snapshot = addProject({ path: targetPath }, 'cloned');
    emit({ ok: true, targetPath, reason: null, snapshot });
  }

  return {
    start(request) {
      if (inFlight !== null) {
        return refuse('a clone is already running — wait for it to finish');
      }

      const verdict = parseCloneUrl(request.url);
      if (!verdict.ok) return refuse(verdict.reason);

      /**
       * The parent re-runs the **entire** story 090 resolution — expand `~`,
       * require absolute, `realpath`, require a directory — for the same reason
       * `addProject` does: the native dialog is a UX step, not a capability
       * grant, and a renderer that skipped it and posted a path directly gets
       * identical treatment.
       */
      const probe = resolveProject({ id: 'probe', path: request.parentPath });
      if (probe.status !== 'ok' || probe.path === null) {
        return refuse(
          `cannot clone into ${request.parentPath} (${probe.status})`,
        );
      }

      const targetPath = join(probe.path, verdict.repoName);

      /**
       * Refused rather than merged into. `git clone` into a non-empty directory
       * fails anyway, and into an empty one it would succeed — leaving the user
       * with a directory they had already made, now containing a repository
       * they may not have meant to put there.
       */
      if (fs.existsSync(targetPath)) {
        return refuse(`${targetPath} already exists — choose another folder`);
      }

      inFlight = { targetPath };

      try {
        sessions.openCommand({
          entityId: CLONE_ENTITY_ID,
          cwd: probe.path,
          file: 'git',
          /**
           * An argv array, and `--` before the URL.
           *
           * argv is what makes quoting irrelevant; `--` is what stops a URL
           * being read as a flag even if `parse-url` were ever loosened.
           * `--progress` because git only draws progress when stdout is a tty
           * it believes in, and the whole point of the PTY is that it is one.
           */
          args: [
            'clone',
            '--progress',
            '--',
            verdict.url,
            verdict.repoName,
          ],
          cols: request.cols,
          rows: request.rows,
          onExit: ({ exitCode, lost, message }) => {
            if (exitCode === 0 && !lost) {
              finish(true, targetPath, null);
              return;
            }
            /**
             * `message` wins when the host supplied one — that is the
             * `could not start git in <cwd>` case, and it is already phrased in
             * words the user can act on. Re-writing it as "git exited with code
             * -1" would lose the only detail that makes it fixable.
             */
            finish(
              false,
              targetPath,
              message ??
                (lost
                  ? 'the terminal host stopped before the clone finished'
                  : `git exited with code ${exitCode}`),
            );
          },
        });
      } catch (cause) {
        inFlight = null;
        return refuse(cause instanceof Error ? cause.message : String(cause));
      }

      return { ok: true, targetPath };
    },

    cancel() {
      if (inFlight === null) return;
      // Cleanup runs in `onExit`, not here: the process still holds the
      // directory, and removing it underneath a live `git` is how you get a
      // partially-deleted tree instead of no tree.
      sessions.kill(CLONE_ENTITY_ID);
    },

    dispose() {
      const current = inFlight;
      if (current === null) return;
      inFlight = null;
      sessions.kill(CLONE_ENTITY_ID);
      // Synchronous, unlike `cancel`: the app is going away and there will be
      // no `onExit` to run cleanup in.
      cleanup(current.targetPath);
    },
  };
}
```

If `@shared` is not aliased for `electron/main/**`, use the same relative form the neighbouring main files use (`../../shared/config-contract`). Read `electron/main/config/index.ts`'s imports and match them exactly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && pnpm vitest run tests/electron/main/clone/`
Expected: PASS — 13 tests across both clone files

- [ ] **Step 5: Confirm the existing config tests still pass**

The `origin` parameter has a default, so every existing `addProject` caller is unaffected.

Run: `cd app && pnpm test && pnpm lint && pnpm type-check`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
cd app
git add electron/main/clone/index.ts electron/main/config/index.ts tests/electron/main/clone/index.test.ts
git commit -m "feat(clone): orchestrate git clone, write on success, clean up on failure (HIVE-54)"
```

---

### Task 5: Wire the clone flow into IPC and app teardown

**Files:**
- Modify: `app/electron/main/ipc/index.ts`
- Modify: `app/electron/main/index.ts`
- Test: `app/tests/electron/main/ipc/clone-channels.test.ts` (**new** — there is no existing test that registers handlers; `tests/electron/main/ipc-security.test.ts` tests `assertSender` alone and `tests/electron/main/ipc/pty.test.ts` tests `createPtyIpc`)

**Interfaces:**
- Consumes: `createCloneFlow` (Task 4), `parseCloneRequest` (Task 2), `CH.configCloneStart/Cancel/Done` (Task 2).
- Produces: `disposeCloneFlow()` exported from `ipc/index.ts` for `main/index.ts` to call on `will-quit`; the clone flow is created lazily beside `sessions`.

- [ ] **Step 1: Write the failing test**

Follow the existing file's harness for invoking a handler with a fake `event`. Add:

```ts
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

/**
 * Mocked the same way `tests/electron/main/ipc-security.test.ts` does it, and
 * for the same reason: `ipc/index.ts` imports `electron` at module scope, so
 * the mock has to be installed before the dynamic import below.
 *
 * `ipcMain.handle` records every registration, which is how a test reaches a
 * handler that is otherwise only callable by Electron.
 */
const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', on: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn);
    },
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
}));

const { CH } = await import('../../../../electron/shared/ipc-contract');
const { registerIpcHandlers, resetIpcHandlers } = await import(
  '../../../../electron/main/ipc'
);

/** An event whose sending frame is the app's own main frame. */
const trustedEvent = {
  senderFrame: { url: 'file:///out/renderer/index.html' },
  sender: { mainFrame: { url: 'file:///out/renderer/index.html' } },
} as never;

/** A subframe — any frame in the process could otherwise invoke. */
const untrustedEvent = {
  senderFrame: { url: 'https://evil.example/' },
  sender: { mainFrame: { url: 'file:///out/renderer/index.html' } },
} as never;

const validPayload = {
  url: 'https://github.com/behiques/the-hive.git',
  parentPath: '/tmp',
  cols: 80,
  rows: 24,
};

function register(): void {
  handlers.clear();
  // Match whatever argument shape `registerIpcHandlers` takes — read
  // `electron/main/ipc/index.ts`'s signature and pass the same fakes the
  // supervisor and config need. If it takes none, call it bare.
  registerIpcHandlers();
}

describe('clone channels', () => {
  afterEach(() => {
    resetIpcHandlers();
  });

  it('registers all three clone channels', () => {
    register();
    expect(handlers.has(CH.configCloneStart)).toBe(true);
    expect(handlers.has(CH.configCloneCancel)).toBe(true);
  });

  it('rejects a sender that is not the main frame', async () => {
    register();
    await expect(
      Promise.resolve(
        handlers.get(CH.configCloneStart)!(untrustedEvent, validPayload),
      ),
    ).rejects.toThrow();
  });

  it('rejects a payload carrying a destination key', async () => {
    register();
    await expect(
      Promise.resolve(
        handlers.get(CH.configCloneStart)!(trustedEvent, {
          ...validPayload,
          destination: '/etc',
        }),
      ),
    ).rejects.toThrow();
  });

  it('returns a refusal for an unusable URL rather than throwing', async () => {
    register();
    const result = await handlers.get(CH.configCloneStart)!(trustedEvent, {
      ...validPayload,
      url: 'http://github.com/behiques/the-hive.git',
    });
    expect(result).toMatchObject({ ok: false });
  });
});
```

Import `afterEach` from vitest alongside the others. If `registerIpcHandlers` needs a supervisor or config argument, build the smallest fake that satisfies its type — read the signature first.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && pnpm vitest run tests/electron/main/ipc/clone-channels.test.ts`
Expected: FAIL — no handler registered for `config:clone-start`

- [ ] **Step 3: Write minimal implementation**

In `app/electron/main/ipc/index.ts`, beside the module-level `sessions`:

```ts
let cloneFlow: CloneFlow | null = null;
```

Inside `registerIpcHandlers`, after `sessions` is constructed:

```ts
  cloneFlow = createCloneFlow({
    sessions,
    emit: (event) => send(CH.configCloneDone, event),
  });
```

using whatever `send` helper the existing handlers use for pushing to the renderer (`sessions` is already constructed with one — reuse that exact function).

Then the three handlers, next to the other config ones:

```ts
  /**
   * Clone verbs (story 102).
   *
   * `startClone` returns a **refusal**, it does not throw: a mistyped URL is
   * something the user fixes in a text field, not an exception the renderer
   * has to catch. Guard failures still throw — those are malformed payloads,
   * not user mistakes.
   */
  handle(
    CH.configCloneStart,
    (_event, payload): CloneStartResult => {
      const request = parseCloneRequest(payload);
      return (
        cloneFlow?.start(request) ?? {
          ok: false,
          reason: 'the clone service is not available',
        }
      );
    },
  );

  handle(CH.configCloneCancel, (): void => {
    cloneFlow?.cancel();
  });
```

In `resetIpcHandlers`, add `cloneFlow?.dispose(); cloneFlow = null;` beside the sessions teardown, and export:

```ts
/** Kill and clean up a clone in flight. Called from the app's `will-quit`. */
export function disposeCloneFlow(): void {
  cloneFlow?.dispose();
}
```

In `app/electron/main/index.ts`, register it on `will-quit`:

```ts
app.on('will-quit', () => {
  /**
   * A clone in flight when the app quits is the likeliest way to strand a
   * half-clone: `git` cleans up after its own failures, but not after the
   * process tree is torn down underneath it.
   */
  disposeCloneFlow();
});
```

If `main/index.ts` already has a `will-quit` or `before-quit` handler, add the call inside it rather than registering a second one.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && pnpm vitest run tests/electron/main/ipc/ && pnpm test`
Expected: PASS, including the existing security spec that asserts every channel checks its sender

- [ ] **Step 5: Run lint and type-check**

Run: `cd app && pnpm lint && pnpm type-check`
Expected: both clean

- [ ] **Step 6: Commit**

```bash
cd app
git add electron/main/ipc/index.ts electron/main/index.ts tests/electron/main/ipc/clone-channels.test.ts
git commit -m "feat(clone): clone-start, clone-cancel and quit-time cleanup (HIVE-54)"
```

---

### Task 6: The renderer's clone module and terminal transport

**Files:**
- Create: `app/src/lib/clone-repo.ts`
- Modify: `app/src/lib/terminal/pty-transport.ts:388-434` (extract `createTransport`, add `createCloneTransport`)
- Test: `app/tests/lib/clone-repo.test.ts`
- Test: `app/tests/lib/terminal/pty-transport.test.ts` (existing — add a describe block)

**Interfaces:**
- Consumes: `window.hive.config.startClone/cancelClone/onCloneDone`, `window.hive.pty.write/resize/ack/onData/onExit`, `CLONE_ENTITY_ID`.
- Produces:
  - `startClone(request: Omit<CloneRequest, never>): Promise<CloneStartResult>`
  - `cancelClone(): Promise<void>`
  - `onCloneDone(cb: (event: CloneDoneEvent) => void): () => void`
  - `createCloneTransport(): TerminalTransport`

- [ ] **Step 1: Write the failing tests**

`app/tests/lib/clone-repo.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cancelClone, onCloneDone, startClone } from '@lib/clone-repo';

describe('clone-repo', () => {
  beforeEach(() => {
    delete (window as { hive?: unknown }).hive;
  });

  it('refuses without a bridge instead of throwing', async () => {
    const result = await startClone({
      url: 'https://x/y.git',
      parentPath: '/tmp',
      cols: 80,
      rows: 24,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it('forwards the request to the bridge', async () => {
    const start = vi.fn().mockResolvedValue({ ok: true, targetPath: '/tmp/y' });
    (window as { hive?: unknown }).hive = { config: { startClone: start } };

    const request = {
      url: 'https://x/y.git',
      parentPath: '/tmp',
      cols: 80,
      rows: 24,
    };
    await expect(startClone(request)).resolves.toEqual({
      ok: true,
      targetPath: '/tmp/y',
    });
    expect(start).toHaveBeenCalledWith(request);
  });

  it('cancel is a no-op without a bridge', async () => {
    await expect(cancelClone()).resolves.toBeUndefined();
  });

  it('onCloneDone returns a no-op unsubscribe without a bridge', () => {
    expect(() => onCloneDone(() => {})()).not.toThrow();
  });
});
```

Add to `app/tests/lib/terminal/pty-transport.test.ts` (reuse its existing `resetPtyChannels()` teardown):

```ts
import { describe, expect, it, vi } from 'vitest';

import { createCloneTransport } from '@lib/terminal/pty-transport';

describe('createCloneTransport', () => {
  it('never spawns — main already did', () => {
    const spawn = vi.fn();
    (window as { hive?: unknown }).hive = {
      pty: {
        spawn,
        write: vi.fn(),
        resize: vi.fn(),
        ack: vi.fn(),
        onData: () => () => {},
        onExit: () => () => {},
      },
    };

    const transport = createCloneTransport();
    transport.onData(() => {});

    expect(spawn).not.toHaveBeenCalled();
  });

  it('writes keystrokes under the clone entity id', () => {
    const write = vi.fn();
    (window as { hive?: unknown }).hive = {
      pty: {
        write,
        resize: vi.fn(),
        ack: vi.fn(),
        onData: () => () => {},
        onExit: () => () => {},
      },
    };

    createCloneTransport().write('hunter2\r');
    expect(write).toHaveBeenCalledWith({
      sessionId: 'hive:clone',
      data: 'hunter2\r',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && pnpm vitest run tests/lib/clone-repo.test.ts tests/lib/terminal/pty-transport.test.ts`
Expected: FAIL — modules do not resolve

- [ ] **Step 3: Write minimal implementation**

`app/src/lib/clone-repo.ts` — mirror `project-config.ts`'s no-bridge discipline exactly (feature-detect the bridge, never the user agent; a missing bridge is the browser demo, not a failure):

```ts
import type {
  CloneDoneEvent,
  CloneRequest,
  CloneStartResult,
} from '@shared/config-contract';

/**
 * Cloning a repository, as the renderer sees it (story 102).
 *
 * A thin module rather than a store, for the same reason `project-config.ts` is
 * one: this is a fact about the *machine*, and main owns every decision in the
 * flow. The renderer starts a clone and renders what comes back.
 */

/** Start a clone. Resolves once `git` is running, not once it has finished. */
export async function startClone(
  request: CloneRequest,
): Promise<CloneStartResult> {
  const bridge = window.hive;
  // No bridge is the browser demo, not a failure — story 083's rule.
  if (!bridge) {
    return { ok: false, reason: 'cloning needs the desktop app' };
  }
  return bridge.config.startClone(request);
}

export async function cancelClone(): Promise<void> {
  await window.hive?.config.cancelClone();
}

/** Subscribe to the outcome. Returns its own unsubscribe. */
export function onCloneDone(
  callback: (event: CloneDoneEvent) => void,
): () => void {
  const bridge = window.hive;
  if (!bridge) return () => {};
  return bridge.config.onCloneDone(callback);
}
```

The clone transport goes **in `pty-transport.ts`**, not in a new file. Its channel map, replay buffer, sequence tracking and ack loop are all module-private, and the clone needs every one of them — a separate file would either duplicate ~430 lines or force those internals to be exported. It is a PTY transport; it just does not start its own process.

`createPtyTransport` (line 388) is only ~45 lines; the machinery is around it. Extract its body behind a mount hook and give both factories a one-line definition:

```ts
/**
 * The two transports differ in exactly one thing: what happens when a surface
 * mounts. A session's transport spawns, because mounting its surface is what
 * starts it. A clone's does not — main started `git` before this view existed,
 * and a transport that spawned on mount would start a *second* clone the first
 * time React remounted the pane.
 *
 * Parameterising that one moment is what keeps the replay-then-subscribe
 * ordering, the sequence-gap detection and the ack loop identical for both.
 */
function createTransport(
  entityId: string,
  onMount: (channel: EntityChannel) => void,
): TerminalTransport {
  return {
    write: (data) => pty().write({ sessionId: entityId, data }),

    resize: (cols, rows) => pty().resize({ sessionId: entityId, cols, rows }),

    onData(cb) {
      const channel = channels.get(entityId) ?? openChannel(entityId);

      // Replay, then subscribe, then mount — the ordering story 095 documents
      // on this function. Its comment moves here with the code; do not drop it.
      if (channel.buffer.length > 0) cb(channel.buffer.join(''));

      channel.subscribers.add(cb);

      if (!channel.closed) onMount(channel);

      // Unsubscribe only. This must never kill the PTY — see the original
      // comment, which moves here verbatim.
      return () => {
        channel.subscribers.delete(cb);
      };
    },

    // …plus every other member `createPtyTransport` already returns, unchanged.
  };
}

export function createPtyTransport(
  entityId: string,
  projectId: string,
): TerminalTransport {
  return createTransport(entityId, (channel) =>
    ensureSpawned(channel, entityId, projectId),
  );
}

/**
 * The clone terminal's transport (story 102).
 *
 * No spawn, and no project — a clone has neither. Everything that carries
 * bytes is the session path's, unchanged.
 */
export function createCloneTransport(): TerminalTransport {
  return createTransport(CLONE_ENTITY_ID, () => {});
}
```

Add `import { CLONE_ENTITY_ID } from '@shared/config-contract';` at the top — a value import, which is allowed for constants; `pnpm verify:boundaries` in Step 5 proves it.

Two constraints on this refactor: `createPtyTransport`'s **exported signature must not change** (story 095's tests assert it), and every doc comment currently on `createPtyTransport`'s body moves with the code rather than being deleted — the replay-ordering and never-kill-on-unmount comments are the reasoning future readers need most.

Update the test file path accordingly — the clone transport's tests belong in the existing `app/tests/lib/terminal/pty-transport.test.ts`, not a new file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && pnpm vitest run tests/lib/`
Expected: PASS

- [ ] **Step 5: Run boundaries, lint and type-check**

Run: `cd app && pnpm verify:boundaries && pnpm lint && pnpm type-check`
Expected: all pass. `verify:boundaries` matters here — `clone-repo.ts` and `pty-transport.ts` are in `src/lib/`, which may not import from `features/` or `components/`, and `CLONE_ENTITY_ID` is the first **value** (not type-only) import the renderer takes from `@shared`.

- [ ] **Step 6: Commit**

```bash
cd app
git add src/lib/clone-repo.ts src/lib/terminal/pty-transport.ts tests/lib/
git commit -m "feat(clone): renderer clone module and non-spawning terminal transport (HIVE-54)"
```

---

### Task 7: The clone sub-view and its entry point

Option B, as approved on the mockups: the Projects section swaps for a focused clone screen.

**Files:**
- Create: `app/src/features/settings/components/clone-repo-view.tsx`
- Modify: `app/src/features/settings/components/projects-section.tsx`
- Test: `app/tests/features/settings/components/clone-repo-view.test.tsx`
- Test: `app/tests/features/settings/components/projects-section.test.tsx` (existing — add cases)

**Interfaces:**
- Consumes: `startClone`, `cancelClone`, `onCloneDone` from `@lib/clone-repo`; `createCloneTransport` from `@lib/terminal/pty-transport`; `chooseProjectDirectory` from `@/lib/project-config`; `TerminalSurface` from `@/components/terminal/terminal-surface`.
- Produces: `<CloneRepoView onDone={() => void} />` — calls `onDone` when the user goes back or a clone succeeds.

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CloneRepoView } from '@features/settings/components/clone-repo-view';

vi.mock('@lib/clone-repo', () => ({
  startClone: vi.fn(),
  cancelClone: vi.fn(),
  onCloneDone: vi.fn(() => () => {}),
}));
vi.mock('@/lib/project-config', () => ({
  chooseProjectDirectory: vi.fn(),
}));

describe('CloneRepoView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables Clone until both a URL and a folder are present', async () => {
    render(<CloneRepoView onDone={() => {}} />);
    expect(screen.getByRole('button', { name: /^clone$/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/repository url/i), {
      target: { value: 'https://github.com/behiques/the-hive.git' },
    });
    expect(screen.getByRole('button', { name: /^clone$/i })).toBeDisabled();
  });

  it('shows the folder the clone will create once both are set', async () => {
    const { chooseProjectDirectory } = await import('@/lib/project-config');
    vi.mocked(chooseProjectDirectory).mockResolvedValue('/Users/me/Projects');

    render(<CloneRepoView onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText(/repository url/i), {
      target: { value: 'https://github.com/behiques/the-hive.git' },
    });
    fireEvent.click(screen.getByRole('button', { name: /choose/i }));

    await waitFor(() => {
      expect(screen.getByText(/the-hive/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /^clone$/i })).toBeEnabled();
  });

  it('surfaces a refusal from main without spawning a terminal', async () => {
    const { startClone } = await import('@lib/clone-repo');
    const { chooseProjectDirectory } = await import('@/lib/project-config');
    vi.mocked(chooseProjectDirectory).mockResolvedValue('/Users/me/Projects');
    vi.mocked(startClone).mockResolvedValue({
      ok: false,
      reason: '/Users/me/Projects/the-hive already exists — choose another folder',
    });

    render(<CloneRepoView onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText(/repository url/i), {
      target: { value: 'https://github.com/behiques/the-hive.git' },
    });
    fireEvent.click(screen.getByRole('button', { name: /choose/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^clone$/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: /^clone$/i }));

    await waitFor(() => {
      expect(screen.getByText(/already exists/)).toBeInTheDocument();
    });
  });

  it('calls onDone when Back is clicked', () => {
    const onDone = vi.fn();
    render(<CloneRepoView onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: /projects/i }));
    expect(onDone).toHaveBeenCalled();
  });

  it('unsubscribes from clone-done on unmount', () => {
    const unsubscribe = vi.fn();
    vi.mocked(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@lib/clone-repo').onCloneDone,
    ).mockReturnValue(unsubscribe);

    const { unmount } = render(<CloneRepoView onDone={() => {}} />);
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
```

Adjust the mock-import style to match the existing settings tests (`projects-section.test.tsx`) — read it first and follow its conventions rather than these exactly. xterm is never instantiated for real; `__mocks__/@xterm/` handles that.

And in `projects-section.test.tsx`, add:

```tsx
it('shows the clone view when Clone from URL is clicked', () => {
  render(<ProjectsSection />);
  fireEvent.click(screen.getByRole('button', { name: /clone from url/i }));
  expect(screen.getByLabelText(/repository url/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && pnpm vitest run tests/features/settings/`
Expected: FAIL — `clone-repo-view` does not resolve

- [ ] **Step 3: Write minimal implementation**

`app/src/features/settings/components/clone-repo-view.tsx`. Follow the visual language of `projects-section.tsx` exactly — `text-[14px]` pane title, `text-[11.5px] text-subtle` sub-line, `rounded-[7px] border border-border` cards, `bg-brand-fill … text-on-brand` primary button, error rows as `rounded-[5px] border border-red px-2.5 py-1.5 text-[11.5px] text-red`. No raw hex.

Structure:

```tsx
export function CloneRepoView({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [phase, setPhase] = useState<'compose' | 'cloning' | 'failed'>('compose');
  const [error, setError] = useState<string | null>(null);
  const [targetPath, setTargetPath] = useState<string | null>(null);
  // Built once so a re-render never swaps the terminal's transport underneath it.
  const transport = useMemo(() => createCloneTransport(), []);
  ...
}
```

Behaviour:

- **Back** (`← Projects`) calls `onDone()`. While cloning it is not shown — cancel first.
- **Choose…** calls `chooseProjectDirectory()`; `null` means cancelled, so nothing changes.
- The derived line renders the folder name from the URL's last segment for *display only*. Main derives the real one; if they ever disagree, main wins and its `targetPath` from `CloneStartResult` replaces the preview.
- **Clone** calls `startClone({ url, parentPath, cols: 80, rows: 24 })`. `ok: false` sets `error` and stays in `compose`. `ok: true` sets `targetPath`, moves to `cloning`.
- In `cloning`, render `<TerminalSurface transport={transport} readOnly={false} />` — **`readOnly={false}` is load-bearing**: it is what lets the user answer git's credential and host-key prompts, which is the reason this story uses a PTY at all.
- `onCloneDone` (subscribed in a `useEffect` that returns its unsubscribe) → `ok` calls `onDone()`, otherwise sets `error` and phase `failed` with **Retry** (back to `compose`, fields kept) and **Back**.
- **Cancel clone** calls `cancelClone()`.

`app/src/features/settings/components/projects-section.tsx`:

```tsx
const [view, setView] = useState<'list' | 'clone'>('list');
...
if (view === 'clone') return <CloneRepoView onDone={() => setView('list')} />;
```

and a second button beside `Add project`:

```tsx
<button
  type="button"
  onClick={() => setView('clone')}
  className="flex w-fit items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12.5px] text-muted hover:bg-hover hover:text-ink"
>
  <GitBranch size={12} weight="bold" />
  Clone from URL
</button>
```

wrapping both buttons in a `flex items-center gap-2` row. Import `GitBranch` from `@phosphor-icons/react`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && pnpm vitest run tests/features/settings/`
Expected: PASS

- [ ] **Step 5: Full check including coverage**

Run: `cd app && pnpm test:coverage && pnpm lint && pnpm type-check && pnpm verify:boundaries`
Expected: all pass, coverage ≥ 80% on all four metrics

- [ ] **Step 6: Commit**

```bash
cd app
git add src/features/settings/components/ tests/features/settings/components/
git commit -m "feat(settings): focused clone-a-repository sub-view (HIVE-54)"
```

---

### Task 8: End-to-end proof against a real clone

No network. A bare repository created in a temp directory is a real remote as far as `git` is concerned.

**Files:**
- Create: `app/tests/e2e/electron/clone-repo.spec.ts`

No fixture changes are needed. `app/tests/e2e/electron/settings.spec.ts` already
has everything: `launchHive` from `./fixtures/hive-app` (which takes
`userDataDir` and `configPath`), a local `stubDirectoryDialog(app, filePaths)`
that replaces `dialog.showOpenDialog` **in main** via `app.evaluate`, and an
`openSettings(page)` helper. Those three are file-local rather than exported —
copy their bodies into the new spec rather than exporting them from
`settings.spec.ts`, which would make one spec file import another.

**Interfaces:**
- Consumes: `launchHive` from `./fixtures/hive-app`; the `HIVE_CONFIG_PATH` sandbox from story 085/101.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

```ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

import { launchHive } from './fixtures/hive-app';

/** A bare repo on disk is a real remote — no network, and CI-safe. */
function makeBareRemote(): string {
  const root = mkdtempSync(join(tmpdir(), 'hive-remote-'));
  const source = join(root, 'src');
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'commit', '-q', '--allow-empty', '-m', 'init'], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Hive',
      GIT_AUTHOR_EMAIL: 'hive@example.com',
      GIT_COMMITTER_NAME: 'Hive',
      GIT_COMMITTER_EMAIL: 'hive@example.com',
    },
  });
  const bare = join(root, 'demo-repo.git');
  execFileSync('git', ['clone', '-q', '--bare', source, bare]);
  return bare;
}

/**
 * Copied from settings.spec.ts, which owns the original.
 *
 * `dialog.showOpenDialog` is stubbed **in main**, not bypassed: the renderer
 * still calls `chooseDirectory` and still echoes the path back, so the round
 * trip under test is the real one. Only the native sheet, which Playwright
 * cannot drive, is replaced.
 */
async function stubDirectoryDialog(
  app: ElectronApplication,
  filePaths: string[],
): Promise<void> {
  await app.evaluate(({ dialog }, paths) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dialog as any).showOpenDialog = async () => ({
      canceled: paths.length === 0,
      filePaths: paths,
    });
  }, filePaths);
}

const openSettings = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
};

const EMPTY_CONFIG = JSON.stringify({ version: 2, projects: [] }, null, 2);

test('clones a repository and registers it as a project', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  writeFileSync(configPath, EMPTY_CONFIG);
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');

  const remote = makeBareRemote();
  const parent = mkdtempSync(join(tmpdir(), 'hive-parent-'));

  await openSettings(page);
  await page.getByRole('button', { name: /clone from url/i }).click();
  await page.getByLabel(/repository url/i).fill(remote);

  await stubDirectoryDialog(app, [parent]);
  await page.getByRole('button', { name: /choose/i }).click();

  await page.getByRole('button', { name: /^clone$/i }).click();

  await expect(page.getByText('demo-repo')).toBeVisible({ timeout: 30_000 });

  const written = JSON.parse(readFileSync(configPath, 'utf8')) as {
    projects: { id: string; origin: string; path: string }[];
  };
  const entry = written.projects.find((p) => p.id === 'demo-repo');
  expect(entry?.origin).toBe('cloned');
  expect(existsSync(join(parent, 'demo-repo', '.git'))).toBe(true);
});

test('a failed clone leaves no directory behind', async ({}, testInfo) => {
  const configPath = testInfo.outputPath('hive-config.json');
  writeFileSync(configPath, EMPTY_CONFIG);
  const app = await launchHive({
    userDataDir: testInfo.outputPath('user-data'),
    configPath,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('header');

  const parent = mkdtempSync(join(tmpdir(), 'hive-parent-'));

  await openSettings(page);
  await page.getByRole('button', { name: /clone from url/i }).click();
  await page
    .getByLabel(/repository url/i)
    .fill(join(tmpdir(), 'definitely-not-a-repo.git'));
  await stubDirectoryDialog(app, [parent]);
  await page.getByRole('button', { name: /choose/i }).click();
  await page.getByRole('button', { name: /^clone$/i }).click();

  await expect(page.getByText(/git exited with code/i)).toBeVisible({
    timeout: 30_000,
  });
  expect(existsSync(join(parent, 'definitely-not-a-repo'))).toBe(false);
});
```

Both tests build their own app instance because `launchHive` takes the config path, and each needs a fresh sandbox. Close the app in a `finally` or via `test.afterEach` following whatever `settings.spec.ts` does — read it and match.

- [ ] **Step 2: Run the spec to verify it fails**

Run: `cd app && pnpm desktop:build && pnpm test:e2e:electron -- clone-repo`
Expected: FAIL — the button or the label is not found, or the config has no `demo-repo` entry

- [ ] **Step 3: Make it pass**

No new product code should be needed. If a selector does not resolve, fix the **accessible name** in `clone-repo-view.tsx` (a `<label htmlFor>` for the URL field, real `<button>` elements) rather than loosening the selector — an element Playwright cannot name is one a screen reader cannot either.

- [ ] **Step 4: Run the whole e2e electron suite**

Run: `cd app && pnpm test:e2e:electron`
Expected: PASS, including the story 101 settings specs

- [ ] **Step 5: Full verification**

Run: `cd app && pnpm test:coverage && pnpm lint && pnpm type-check && pnpm verify:boundaries && pnpm test:pty`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
cd app
git add tests/e2e/electron/
git commit -m "test(clone): e2e clone against a local bare repo, and failure cleanup (HIVE-54)"
```

---

## Final verification

- [ ] Drive the built app by hand: `pnpm desktop:build && pnpm desktop:preview`. Open Settings → Clone from URL, clone a real public repository, confirm the terminal renders progress, confirm the project appears in the list and in the left rail, and confirm a session can be started in it.
- [ ] Confirm a private repository prompts for credentials **in the terminal** and that typing into it works — this is the requirement the whole PTY design exists for, and no unit test covers it.
- [ ] Propagate the surface deviation to HIVE-54 with the `workstream:spec-deviation` skill: the ticket says progress appears in "the terminal the user already trusts" (the center stage); it appears in a focused sub-view inside Settings instead, because `resolveView` puts settings above every other state and the epic forbids settings changing `activeTab`.
- [ ] Open the PR as a **draft** (`gh pr create --draft`), then hand off to `workstream:ship`.
