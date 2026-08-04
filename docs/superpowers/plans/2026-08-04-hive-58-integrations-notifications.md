# Integrations & Notifications Implementation Plan (HIVE-58 / story 106)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Settings → Integrations section that reports `gh` CLI detection, auth status and which token source would serve the PR panel, plus OS notification preferences for the three event classes main can actually observe.

**Architecture:** Two new IPC verbs on the existing bridge — `integrations:status` (read-only, no parameters) and `config:set-notifications` (partial write through the single `writeConfig`). A notifier in main taps the one broadcast point every event already funnels through. The renderer gets a new section registered with two lines in `settings-overlay.tsx`.

**Tech Stack:** Electron 3x main/preload/renderer split, TypeScript strict, React 19 + zustand, Radix primitives via the `radix-ui` package, vitest, Playwright (`_electron`).

**Spec:** `docs/superpowers/specs/2026-08-04-hive-58-integrations-notifications-design.md`

## Global Constraints

- **Every IPC handler follows story 082 unchanged:** `assertSender` first, then a hand-written payload guard, no casts, `__proto__` rejected. Guards live in `electron/shared/guards.ts`.
- **Every mutating config verb returns a fresh `ConfigSnapshot`** and goes through `writeConfig` in `electron/main/config/write.ts`. Never a per-field patch.
- **Unknown top-level keys and `"//"` comment keys survive every write.** Mutations spread the draft document; they never rebuild it.
- **`CONFIG_VERSION` stays at `2`.** A new optional top-level key needs no bump.
- **No token value is ever read, stored, logged, or sent over the bridge.** Environment variables are checked for presence only.
- **No new npm dependency.** Radix's `Switch` ships inside `radix-ui@^1.6.7`, already installed.
- **POSIX-only stance is preserved** — `PATHEXT` is not consulted, matching `diagnoseCommand`.
- Working directory for every command: `/Users/yunidbauza/Projects/behiques/the-hive/.claude/worktrees/hive-58/app`.
- Gates before the PR: `pnpm lint`, `pnpm type-check`, `pnpm verify:boundaries`, `pnpm test`, `pnpm test:e2e`. This repo has **no CI**; local gates are the entire verification.

---

## File Structure

**Create:**
- `electron/main/config/probe.ts` — PATH probing, extracted from `diagnoseCommand`
- `electron/main/integrations/gh.ts` — `gh` detection, version, auth status, token source
- `electron/main/notifications/index.ts` — the OS notification emitter
- `src/components/ui/switch.tsx` — boolean control over Radix `Switch`
- `src/features/settings/components/settings-group.tsx` — the `Group` both existing sections duplicate
- `src/features/settings/components/path-probes.tsx` — the probe list both diagnostics render
- `src/features/settings/components/integrations-section.tsx` — the new pane
- `src/features/integrations/hooks/use-notification-activate.ts` — renderer half of click-to-open
- Tests mirroring each of the above under `tests/`

**Modify:**
- `electron/shared/config-contract.ts` — `NotificationPrefs`, `SetNotificationsRequest`, `DEFAULT_NOTIFICATIONS`, `ConfigSnapshot.notifications`, `emptySnapshot`
- `electron/shared/ipc-contract.ts` — `GhStatus`, `IntegrationsStatus`, `NotificationActivateEvent`, three channels, `HiveBridge.integrations`
- `electron/shared/guards.ts` — `parseSetNotificationsRequest`
- `electron/main/config/parse.ts:72` — `TOP_LEVEL_KEYS` gains `notifications`; parse the block
- `electron/main/config/index.ts` — `setNotifications`, snapshot assembly
- `electron/main/config/runtime.ts:105-165` — `diagnoseCommand` composes `probeCommand`
- `electron/main/ipc/index.ts` — two handlers, the notifier tap
- `electron/preload/index.ts` — the `integrations` namespace
- `src/features/settings/components/settings-overlay.tsx:44-62` — two lines
- `src/features/settings/components/runtime-section.tsx`, `appearance-section.tsx` — import the shared `Group`
- `src/features/settings/components/command-diagnostic-view.tsx` — import shared `PathProbes`
- `src/lib/project-config.ts` — renderer-side callers
- `src/components/layout/app-shell.tsx` — mount the activate hook

---

### Task 1: Extract `probeCommand` from `diagnoseCommand`

A pure refactor. Story 104's existing `diagnoseCommand` tests are the regression proof and must pass untouched.

**Files:**
- Create: `electron/main/config/probe.ts`
- Modify: `electron/main/config/runtime.ts:105-165`
- Test: `tests/config/probe.test.ts`

**Interfaces:**
- Consumes: `PathProbe` from `@shared/config-contract`
- Produces: `probeCommand(command: string, path: string): CommandProbe` where `CommandProbe = { isPath: boolean; resolved: string | null; probes: PathProbe[] }`

- [ ] **Step 1: Write the failing test**

`tests/config/probe.test.ts`:

```ts
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { probeCommand } from '@main/config/probe';

function binDir(name: string, mode: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'hive-probe-'));
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, mode);
  return dir;
}

describe('probeCommand', () => {
  it('resolves a command found on PATH', () => {
    const dir = binDir('gh', 0o755);
    const result = probeCommand('gh', dir);

    expect(result.isPath).toBe(false);
    expect(result.resolved).toBe(join(dir, 'gh'));
    expect(result.probes).toEqual([{ directory: dir, found: true }]);
  });

  it('flags a present but non-executable file rather than calling it missing', () => {
    const dir = binDir('gh', 0o644);
    const result = probeCommand('gh', dir);

    expect(result.resolved).toBeNull();
    expect(result.probes).toEqual([
      { directory: dir, found: false, notExecutable: true },
    ]);
  });

  it('skips empty PATH entries rather than probing an unshared cwd', () => {
    const dir = binDir('gh', 0o755);
    const result = probeCommand('gh', `:${dir}`);

    expect(result.probes).toHaveLength(1);
    expect(result.resolved).toBe(join(dir, 'gh'));
  });

  it('treats a command containing a separator as a path, not a search', () => {
    const dir = binDir('gh', 0o755);
    const result = probeCommand(join(dir, 'gh'), dir);

    expect(result.isPath).toBe(true);
    expect(result.resolved).toBe(join(dir, 'gh'));
    expect(result.probes).toEqual([]);
  });

  it('reports a relative path as unresolved', () => {
    const result = probeCommand('./bin/gh', '/usr/bin');

    expect(result.isPath).toBe(true);
    expect(result.resolved).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/config/probe.test.ts`
Expected: FAIL — cannot resolve `@main/config/probe`.

- [ ] **Step 3: Create `probe.ts` by moving the loop out of `diagnoseCommand`**

`electron/main/config/probe.ts` — move `isExecutable` / `exists` and the search loop verbatim from `runtime.ts`, keeping every comment that explains a decision:

```ts
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, sep } from 'node:path';

import type { PathProbe } from '@shared/config-contract';

/**
 * The result of looking for a command, without deciding what it means.
 *
 * Extracted from `diagnoseCommand` (story 104) when story 106 needed the same
 * search for `gh`. The rules are unchanged; only their caller is now plural.
 */
export interface CommandProbe {
  isPath: boolean;
  resolved: string | null;
  probes: PathProbe[];
}

function exists(candidate: string): boolean { /* moved verbatim */ }
function isExecutable(candidate: string): boolean { /* moved verbatim */ }

export function probeCommand(command: string, path: string): CommandProbe {
  const isPath = command.includes(sep) || command.includes('/');

  if (isPath) {
    return {
      isPath: true,
      resolved: isAbsolute(command) && isExecutable(command) ? command : null,
      probes: [],
    };
  }

  const probes: PathProbe[] = [];
  let resolved: string | null = null;

  for (const directory of path.split(delimiter)) {
    if (directory === '') continue;

    const candidate = join(directory, command);
    const found = isExecutable(candidate);
    const probe: PathProbe = { directory, found };
    if (!found && exists(candidate)) probe.notExecutable = true;

    probes.push(probe);
    if (found && resolved === null) resolved = candidate;
  }

  return { isPath: false, resolved, probes };
}
```

- [ ] **Step 4: Rewrite `diagnoseCommand` as a composition**

`electron/main/config/runtime.ts` — keep the signature and the doc comment; the body becomes:

```ts
export function diagnoseCommand(
  runtime: EffectiveRuntime,
  projectId: string | null,
  baseEnv: NodeJS.ProcessEnv = process.env,
): CommandDiagnostic {
  const command = runtime.claudeCommand;
  const path = runtime.env.PATH ?? baseEnv.PATH ?? '';
  const { isPath, resolved, probes } = probeCommand(command, path);

  return { projectId, command, isPath, resolved, path, probes };
}
```

- [ ] **Step 5: Run the new test and story 104's suite**

Run: `pnpm exec vitest run tests/config/probe.test.ts tests/config`
Expected: PASS, including every pre-existing `diagnoseCommand` test unmodified.

- [ ] **Step 6: Commit**

```bash
git add electron/main/config/probe.ts electron/main/config/runtime.ts tests/config/probe.test.ts
git commit -m "refactor(config): extract probeCommand from diagnoseCommand (HIVE-58)"
```

---

### Task 2: Notification preferences — the read path

Schema, parsing, and resolution into `ConfigSnapshot`. No write yet, so an absent key must resolve to defaults on every existing file.

**Files:**
- Modify: `electron/shared/config-contract.ts`, `electron/main/config/parse.ts:72`, `electron/main/config/index.ts`
- Test: `tests/config/notifications-parse.test.ts`

**Interfaces:**
- Produces:
  - `interface NotificationPrefs { sessionDone: boolean; sessionIdle: boolean; cloneDone: boolean }`
  - `const DEFAULT_NOTIFICATIONS: NotificationPrefs = { sessionDone: true, sessionIdle: false, cloneDone: true }`
  - `ConfigSnapshot.notifications: NotificationPrefs` — always fully resolved
  - `ParsedConfig.notifications: Partial<NotificationPrefs> | undefined`

- [ ] **Step 1: Write the failing test**

`tests/config/notifications-parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { parseConfig } from '@main/config/parse';
import { DEFAULT_NOTIFICATIONS } from '@shared/config-contract';

const LABEL = 'config';

describe('notifications parsing', () => {
  it('is absent on a file that has never had one', () => {
    const parsed = parseConfig('{"version":2}', LABEL);

    expect(parsed.notifications).toBeUndefined();
    expect(parsed.errors).toEqual([]);
  });

  it('reads a partial block without inventing the missing keys', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"sessionIdle":true}}',
      LABEL,
    );

    expect(parsed.notifications).toEqual({ sessionIdle: true });
    expect(parsed.errors).toEqual([]);
  });

  it('reports a non-boolean rather than coercing it', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"sessionDone":"yes"}}',
      LABEL,
    );

    expect(parsed.errors).toContain(
      'config.notifications.sessionDone: expected a boolean',
    );
  });

  it('reports an unknown key inside the block', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"waiting":true}}',
      LABEL,
    );

    expect(parsed.errors.join('\n')).toMatch(/notifications.*waiting/);
  });

  it('no longer reports notifications as an unknown top-level key', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"cloneDone":false}}',
      LABEL,
    );

    expect(parsed.errors).toEqual([]);
  });

  it('defaults have session idle off — the chatty one', () => {
    expect(DEFAULT_NOTIFICATIONS).toEqual({
      sessionDone: true,
      sessionIdle: false,
      cloneDone: true,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/config/notifications-parse.test.ts`
Expected: FAIL — `DEFAULT_NOTIFICATIONS` is not exported.

- [ ] **Step 3: Add the contract types**

In `electron/shared/config-contract.ts`, after the runtime types:

```ts
/**
 * Which events raise an OS notification (story 106).
 *
 * Only classes backed by an event main can actually observe. There is no
 * `waiting`: it is not derivable from a pty (story 096), and the epic's rule
 * for the section nav applies here too — absent rather than disabled, because
 * a dead switch teaches the user the feature is broken.
 */
export interface NotificationPrefs {
  /** A session's process exited. */
  sessionDone: boolean;
  /** A session produced no output for `ACTIVITY_IDLE_MS`. */
  sessionIdle: boolean;
  /** A clone finished, whether it succeeded or failed. */
  cloneDone: boolean;
}

/**
 * `sessionIdle` is off because it is real but chatty — a build that pauses to
 * download is not news, and a notification stream nobody trusts is worse than
 * none.
 */
export const DEFAULT_NOTIFICATIONS: NotificationPrefs = {
  sessionDone: true,
  sessionIdle: false,
  cloneDone: true,
};

export const NOTIFICATION_KEYS: readonly (keyof NotificationPrefs)[] = [
  'sessionDone',
  'sessionIdle',
  'cloneDone',
];
```

Add `notifications: NotificationPrefs;` to `ConfigSnapshot` and
`notifications: { ...DEFAULT_NOTIFICATIONS },` to `emptySnapshot`'s return.

- [ ] **Step 4: Parse the block**

In `electron/main/config/parse.ts`, add `'notifications'` to `TOP_LEVEL_KEYS` (line 72) and parse it after `claudeCommand`:

```ts
const notifications = optionalNotifications(document, label, errors);
```

with a helper that reuses `checkKeys` for the inner object and pushes
`` `${label}.notifications.${key}: expected a boolean` `` for a non-boolean.
Return it on every `ParsedConfig` return path.

- [ ] **Step 5: Resolve it into the snapshot**

In `electron/main/config/index.ts`, `loadConfig`'s return gains:

```ts
notifications: { ...DEFAULT_NOTIFICATIONS, ...parsed.notifications },
```

- [ ] **Step 6: Run the tests**

Run: `pnpm exec vitest run tests/config && pnpm type-check`
Expected: PASS. Fix any existing test that hand-assembles a `ConfigSnapshot` by adding `notifications`.

- [ ] **Step 7: Commit**

```bash
git add electron/shared/config-contract.ts electron/main/config/parse.ts electron/main/config/index.ts tests/
git commit -m "feat(config): read notification preferences from the config file (HIVE-58)"
```

---

### Task 3: `config:set-notifications` — the write path

**Files:**
- Modify: `electron/shared/config-contract.ts`, `electron/shared/guards.ts`, `electron/shared/ipc-contract.ts`, `electron/main/config/index.ts`, `electron/main/ipc/index.ts`, `electron/preload/index.ts`, `src/lib/project-config.ts`
- Test: `tests/config/set-notifications.test.ts`, `tests/electron/guards.test.ts` (extend)

**Interfaces:**
- Consumes: `NotificationPrefs`, `DEFAULT_NOTIFICATIONS`, `NOTIFICATION_KEYS` (Task 2)
- Produces:
  - `interface SetNotificationsRequest { sessionDone?: boolean; sessionIdle?: boolean; cloneDone?: boolean }`
  - `parseSetNotificationsRequest(input: unknown): SetNotificationsRequest`
  - `setNotifications(request: SetNotificationsRequest): ConfigSnapshot`
  - channel `configSetNotifications: 'config:set-notifications'`
  - bridge `window.hive.config.setNotifications(request): Promise<ConfigSnapshot>`

- [ ] **Step 1: Write the failing tests**

`tests/config/set-notifications.test.ts` — against a `HIVE_CONFIG_PATH` sandbox, following `tests/config/set-runtime.test.ts`'s existing setup:

```ts
it('writes only the field named, leaving a hand-written sibling byte-identical', () => {
  writeConfigFile('{\n  "version": 2,\n  "notifications": { "sessionDone": false }\n}\n');

  const snapshot = setNotifications({ sessionIdle: true });

  expect(snapshot.notifications).toEqual({
    sessionDone: false,
    sessionIdle: true,
    cloneDone: true,
  });
  expect(readConfigFile()).toContain('"sessionDone": false');
});

it('creates the block on a file that has none, without touching comments', () => {
  writeConfigFile('{\n  "//": "hand written",\n  "version": 2\n}\n');

  setNotifications({ cloneDone: false });

  const text = readConfigFile();
  expect(text).toContain('"//": "hand written"');
  expect(JSON.parse(text).notifications).toEqual({ cloneDone: false });
});

it('leaves the key absent until a switch is actually touched', () => {
  writeConfigFile('{\n  "version": 2\n}\n');

  expect(JSON.parse(readConfigFile()).notifications).toBeUndefined();
});

it('preserves unknown top-level keys across the write', () => {
  writeConfigFile('{\n  "version": 2,\n  "futureThing": 1\n}\n');

  setNotifications({ sessionDone: false });

  expect(JSON.parse(readConfigFile()).futureThing).toBe(1);
});
```

Guard tests in `tests/electron/guards.test.ts`:

```ts
it('rejects a non-boolean', () => {
  expect(() => parseSetNotificationsRequest({ sessionDone: 'yes' })).toThrow(
    IpcValidationError,
  );
});

it('rejects an unknown key', () => {
  expect(() => parseSetNotificationsRequest({ waiting: true })).toThrow(
    IpcValidationError,
  );
});

it('rejects __proto__', () => {
  expect(() =>
    parseSetNotificationsRequest(JSON.parse('{"__proto__":{"x":1}}')),
  ).toThrow(IpcValidationError);
});

it('rejects an empty request — nothing to change', () => {
  expect(() => parseSetNotificationsRequest({})).toThrow(IpcValidationError);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run tests/config/set-notifications.test.ts tests/electron/guards.test.ts`
Expected: FAIL — `setNotifications` / `parseSetNotificationsRequest` are not exported.

- [ ] **Step 3: Add the request type and guard**

`config-contract.ts`:

```ts
/**
 * Payload of `config:set-notifications` (story 106).
 *
 * Partial in exactly the way `SetRuntimeRequest` is: only the fields named are
 * touched, so saving one switch never restates another. There is no `null`
 * case — unlike a per-project override, a preference has no lower level to fall
 * back to, so "off" is a value, not an absence.
 */
export interface SetNotificationsRequest {
  sessionDone?: boolean;
  sessionIdle?: boolean;
  cloneDone?: boolean;
}
```

`guards.ts`, following `parseSetRuntimeRequest`'s shape exactly:

```ts
export function parseSetNotificationsRequest(
  input: unknown,
): SetNotificationsRequest {
  const raw = assertShape(input, [], 'setNotifications', [...NOTIFICATION_KEYS]);
  const request: SetNotificationsRequest = {};

  for (const key of NOTIFICATION_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      return fail(`setNotifications.${key}: expected a boolean`);
    }
    request[key] = value;
  }

  if (Object.keys(request).length === 0) {
    return fail('setNotifications: nothing to change');
  }

  return request;
}
```

- [ ] **Step 4: Add the verb**

`electron/main/config/index.ts`, modelled on `setRuntime`:

```ts
/**
 * Change notification preferences (story 106).
 *
 * The block is **spread, never rebuilt**, for the same reason every other verb
 * spreads: a key this build has not heard of — a class a later story adds — must
 * survive a save made by this one.
 */
export function setNotifications(
  request: SetNotificationsRequest,
): ConfigSnapshot {
  return commit(
    writeConfig((draft) => {
      const current = isPlainObject(draft.notifications)
        ? draft.notifications
        : {};

      return { ...draft, notifications: { ...current, ...request } };
    }),
  );
}
```

- [ ] **Step 5: Wire the channel, handler, bridge and renderer helper**

- `ipc-contract.ts`: `configSetNotifications: 'config:set-notifications'`, and `setNotifications(request: SetNotificationsRequest): Promise<ConfigSnapshot>` on `HiveBridge.config`.
- `ipc/index.ts`, alongside the other two mutating verbs:

```ts
handle(
  CH.configSetNotifications,
  (_event, payload): ConfigSnapshot =>
    setNotifications(parseSetNotificationsRequest(payload)),
);
```

- `preload/index.ts`: `setNotifications: (request) => ipcRenderer.invoke(CH.configSetNotifications, request)`.
- `src/lib/project-config.ts`: `setNotificationPrefs(request)` following `setRuntimeConfig`.

- [ ] **Step 6: Run the tests**

Run: `pnpm exec vitest run tests/config tests/electron && pnpm type-check`
Expected: PASS. The preload bridge-key-set alarm test fires by design — update its expected key list and record why in the test's comment, as story 104 did.

- [ ] **Step 7: Commit**

```bash
git add electron src/lib/project-config.ts tests
git commit -m "feat(config): add config:set-notifications write verb (HIVE-58)"
```

---

### Task 4: `gh` detection and auth status

**Files:**
- Create: `electron/main/integrations/gh.ts`
- Modify: `electron/shared/ipc-contract.ts`, `electron/main/ipc/index.ts`, `electron/preload/index.ts`, `src/lib/project-config.ts`
- Test: `tests/electron/gh-status.test.ts`

**Interfaces:**
- Consumes: `probeCommand` (Task 1), `effectiveRuntime` from `@main/config/runtime`
- Produces:
  - `type GhTokenSource = 'keyring' | 'env' | 'none'`
  - `interface GhStatus { installed, resolved, path, probes, version, authenticated, account, tokenSource, envVar, error }` (exact fields in the spec)
  - `interface IntegrationsStatus { gh: GhStatus; notificationsSupported: boolean }`
  - `readGhStatus(env: NodeJS.ProcessEnv, run: RunCommand): GhStatus` — `run` injected so tests never execute a real binary
  - `type RunCommand = (file: string, args: readonly string[]) => { code: number; stdout: string; stderr: string }`
  - channel `integrationsStatus: 'integrations:status'`, bridge `window.hive.integrations.status()`

- [ ] **Step 1: Write the failing test**

`tests/electron/gh-status.test.ts`:

```ts
const AUTHED = `github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Token scopes: 'gist', 'read:org', 'repo'
`;

function runner(map: Record<string, { code: number; stdout: string; stderr?: string }>) {
  return (file: string, args: readonly string[]) => {
    const key = args.join(' ');
    const hit = map[key];
    if (!hit) throw new Error(`unexpected argv: ${file} ${key}`);
    return { code: hit.code, stdout: hit.stdout, stderr: hit.stderr ?? '' };
  };
}

it('reports not installed, with the probes explaining where it looked', () => {
  const status = readGhStatus({ PATH: '/nowhere' }, runner({}));

  expect(status.installed).toBe(false);
  expect(status.authenticated).toBe(false);
  expect(status.tokenSource).toBe('none');
  expect(status.probes).toEqual([{ directory: '/nowhere', found: false }]);
});

it('reports the account and keyring source when gh is logged in', () => {
  const status = readGhStatus(
    { PATH: dirWithGh },
    runner({ '--version': { code: 0, stdout: 'gh version 2.62.0 (2024-11-14)\n' },
             'auth status': { code: 0, stdout: AUTHED } }),
  );

  expect(status.installed).toBe(true);
  expect(status.version).toBe('2.62.0');
  expect(status.authenticated).toBe(true);
  expect(status.account).toBe('octocat');
  expect(status.tokenSource).toBe('keyring');
  expect(status.envVar).toBeNull();
});

it('reports the environment as the source when GH_TOKEN is set, because gh would use it', () => {
  const status = readGhStatus(
    { PATH: dirWithGh, GH_TOKEN: 'ghp_realsecret', GITHUB_TOKEN: 'other' },
    runner({ '--version': { code: 0, stdout: 'gh version 2.62.0\n' },
             'auth status': { code: 0, stdout: AUTHED } }),
  );

  expect(status.tokenSource).toBe('env');
  expect(status.envVar).toBe('GH_TOKEN');
});

it('never lets a token value into the result', () => {
  const status = readGhStatus(
    { PATH: dirWithGh, GH_TOKEN: 'ghp_realsecret' },
    runner({ '--version': { code: 0, stdout: 'gh version 2.62.0\n' },
             'auth status': { code: 0, stdout: `${AUTHED}\n  Token: ghp_realsecret\n` } }),
  );

  expect(JSON.stringify(status)).not.toContain('ghp_realsecret');
});

it('treats not-logged-in as an ordinary answer, not an error', () => {
  const status = readGhStatus(
    { PATH: dirWithGh },
    runner({ '--version': { code: 0, stdout: 'gh version 2.62.0\n' },
             'auth status': { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' } }),
  );

  expect(status.installed).toBe(true);
  expect(status.authenticated).toBe(false);
  expect(status.error).toBeNull();
});

it('runs the resolved absolute path, never the bare name', () => {
  const seen: string[] = [];
  readGhStatus({ PATH: dirWithGh }, (file, args) => {
    seen.push(file);
    return { code: 0, stdout: 'gh version 2.62.0\n', stderr: '' };
  });

  expect(seen.every((file) => file === join(dirWithGh, 'gh'))).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run tests/electron/gh-status.test.ts`
Expected: FAIL — cannot resolve `@main/integrations/gh`.

- [ ] **Step 3: Implement `gh.ts`**

Key body, with the security reasoning in comments:

```ts
const TIMEOUT_MS = 5_000;
const MAX_BUFFER = 512 * 1024;

/**
 * Run a command for a *fact*, not for the user (story 106).
 *
 * `execFile`, never `exec` and never a shell — there is no string for a
 * metacharacter to live in. The file is the **resolved absolute path** from
 * `probeCommand`, never the bare name: resolving once and running that exact
 * path closes the window where PATH could resolve differently between the check
 * and the run. argv is a constant; the verb this serves takes no parameters at
 * all, so no renderer input can reach it.
 */
export const runCommand: RunCommand = (file, args) => {
  const result = spawnSync(file, [...args], {
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    encoding: 'utf8',
    shell: false,
  });
  ...
};
```

`readGhStatus` composes: `probeCommand('gh', env.PATH ?? '')` → if unresolved, return the not-installed answer; else `--version` then `auth status`. Parse the login with
`/Logged in to \S+ account (\S+)/`, and read only `env.GH_TOKEN` / `env.GITHUB_TOKEN` **presence**. Never put stdout in the result.

`tokenSource`: `env` if either variable is non-empty (`GH_TOKEN` wins, matching `gh`'s precedence); else `keyring` if authenticated; else `none`.

- [ ] **Step 4: Wire the read-only verb**

`ipc-contract.ts` gains the channel and `HiveBridge.integrations = { status(): Promise<IntegrationsStatus> }`.
`ipc/index.ts`:

```ts
/**
 * Integrations status (story 106) — read-only, and takes no payload.
 *
 * The absent parameter list is the security design, not an omission: with
 * nothing arriving from the renderer there is no argv to inject into.
 */
handle(CH.integrationsStatus, (): IntegrationsStatus => ({
  gh: readGhStatus(effectiveRuntime(getConfig(), null).env, runCommand),
  notificationsSupported: Notification.isSupported(),
}));
```

- [ ] **Step 5: Run tests and type-check**

Run: `pnpm exec vitest run tests/electron && pnpm type-check && pnpm verify:boundaries`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron src/lib/project-config.ts tests
git commit -m "feat(integrations): detect gh, its auth status and token source (HIVE-58)"
```

---

### Task 5: The notification emitter

**Files:**
- Create: `electron/main/notifications/index.ts`
- Modify: `electron/main/ipc/index.ts`, `electron/shared/ipc-contract.ts`
- Test: `tests/electron/notifications.test.ts`

**Interfaces:**
- Consumes: `NotificationPrefs` (Task 2), `CH.sessionStatus`, `CH.configCloneDone`
- Produces:
  - `createNotifier(options: NotifierOptions): Notifier` where
    `NotifierOptions = { prefs: () => NotificationPrefs; present: NotificationPresenter; activate: (entityId: string) => void }`
  - `Notifier = { observe(channel: string, payload: unknown): void }`
  - `NotificationPresenter = (options: { title: string; body: string; onClick: () => void }) => void`
  - channel `notificationsActivate: 'notifications:activate'` (main → renderer),
    `interface NotificationActivateEvent { entityId: string }`

- [ ] **Step 1: Write the failing test**

```ts
function harness(prefs: Partial<NotificationPrefs> = {}) {
  const shown: { title: string; body: string; onClick: () => void }[] = [];
  const activated: string[] = [];
  const notifier = createNotifier({
    prefs: () => ({ ...DEFAULT_NOTIFICATIONS, ...prefs }),
    present: (options) => shown.push(options),
    activate: (id) => activated.push(id),
  });
  return { notifier, shown, activated };
}

it('notifies when a session finishes', () => {
  const { notifier, shown } = harness();
  notifier.observe(CH.sessionStatus, { entityId: 'apfm-web', status: 'done' });

  expect(shown).toHaveLength(1);
  expect(shown[0].body).toContain('apfm-web');
});

it('says nothing about idle by default — the chatty class is off', () => {
  const { notifier, shown } = harness();
  notifier.observe(CH.sessionStatus, { entityId: 'apfm-web', status: 'idle' });

  expect(shown).toEqual([]);
});

it('notifies on idle once the user turns it on', () => {
  const { notifier, shown } = harness({ sessionIdle: true });
  notifier.observe(CH.sessionStatus, { entityId: 'apfm-web', status: 'idle' });

  expect(shown).toHaveLength(1);
});

it('never notifies for working — it is not an event class', () => {
  const { notifier, shown } = harness({ sessionIdle: true });
  notifier.observe(CH.sessionStatus, { entityId: 'apfm-web', status: 'working' });

  expect(shown).toEqual([]);
});

it('respects a class that is switched off', () => {
  const { notifier, shown } = harness({ sessionDone: false });
  notifier.observe(CH.sessionStatus, { entityId: 'apfm-web', status: 'done' });

  expect(shown).toEqual([]);
});

it('notifies when a clone finishes, and when one fails', () => {
  const { notifier, shown } = harness();
  notifier.observe(CH.configCloneDone, { ok: true, projectId: 'hive' });
  notifier.observe(CH.configCloneDone, { ok: false, reason: 'auth failed' });

  expect(shown).toHaveLength(2);
});

it('asks the renderer to open the session when the notification is clicked', () => {
  const { notifier, shown, activated } = harness();
  notifier.observe(CH.sessionStatus, { entityId: 'apfm-web', status: 'done' });
  shown[0].onClick();

  expect(activated).toEqual(['apfm-web']);
});

it('ignores a payload that is not the shape it expects', () => {
  const { notifier, shown } = harness();
  notifier.observe(CH.sessionStatus, null);
  notifier.observe(CH.sessionStatus, { entityId: 42, status: 'done' });

  expect(shown).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run tests/electron/notifications.test.ts`
Expected: FAIL — `createNotifier` is not exported.

- [ ] **Step 3: Implement the notifier**

The presenter is injected so the unit tests never touch Electron's `Notification`. The real presenter, built in `ipc/index.ts`, guards with `Notification.isSupported()` and focuses the window on click.

Document the two decisions in the module comment:

```
 * ## No focus suppression
 *
 * Main cannot know which session the user is looking at — `activeTab` is
 * renderer state. The only rule main could apply alone is "stay quiet while a
 * window is focused", which would suppress precisely the background-session
 * case this exists for. The per-class switch is the control, and there is no
 * second, invisible one.
 *
 * ## Why a tap on the broadcast, not a call at each source
 *
 * Every event main sends already funnels through one `send`. Tapping it once
 * means a class added later cannot forget to notify; a call site per source
 * would be a rule enforced by memory.
```

- [ ] **Step 4: Tap the broadcast in `ipc/index.ts`**

```ts
const notifier = createNotifier({
  prefs: () => getConfig().notifications,
  present: presentNotification,
  activate: (entityId) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      if (window.isMinimized()) window.restore();
      window.focus();
    }
    send(CH.notificationsActivate, { entityId } satisfies NotificationActivateEvent);
  },
});

const send = (channel: string, payload: unknown): void => {
  notifier.observe(channel, payload);
  for (const window of BrowserWindow.getAllWindows()) { ... }
};
```

- [ ] **Step 5: Run tests**

Run: `pnpm exec vitest run tests/electron && pnpm type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron tests
git commit -m "feat(notifications): raise OS notifications for real session and clone events (HIVE-58)"
```

---

### Task 6: Shared UI pieces — `Switch`, `SettingsGroup`, `PathProbes`

Three small units, each earning its place by gaining a third consumer. No behaviour change to the two existing sections.

**Files:**
- Create: `src/components/ui/switch.tsx`, `src/features/settings/components/settings-group.tsx`, `src/features/settings/components/path-probes.tsx`
- Modify: `runtime-section.tsx:30`, `appearance-section.tsx:52`, `command-diagnostic-view.tsx`
- Test: `tests/components/switch.test.tsx`, `tests/features/settings/settings-group.test.tsx`

**Interfaces:**
- Produces:
  - `<Switch checked label description onCheckedChange />`
  - `<SettingsGroup title description>{children}</SettingsGroup>`
  - `<PathProbes probes={PathProbe[]} />`

- [ ] **Step 1: Write the failing test**

```tsx
it('reports its state to assistive tech and toggles on click', async () => {
  const onCheckedChange = vi.fn();
  render(
    <Switch checked={false} label="Session finished" onCheckedChange={onCheckedChange} />,
  );

  const control = screen.getByRole('switch', { name: 'Session finished' });
  expect(control).toHaveAttribute('aria-checked', 'false');

  await userEvent.click(control);
  expect(onCheckedChange).toHaveBeenCalledWith(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run tests/components/switch.test.tsx`
Expected: FAIL — cannot resolve `@components/ui/switch`.

- [ ] **Step 3: Implement the three components**

`switch.tsx` wraps `Switch as SwitchPrimitive` from `radix-ui`, vendored the way `dialog.tsx` is, styled with the existing tokens (`bg-active`, `bg-brand`, `focus-visible:ring-brand`). **No new dependency** — record that in the file comment.

`settings-group.tsx` is the `Group` currently duplicated in `runtime-section.tsx:30` and `appearance-section.tsx:52`, moved verbatim.

`path-probes.tsx` is the probe list lifted out of `command-diagnostic-view.tsx`.

- [ ] **Step 4: Point the existing sections at the shared pieces**

Delete both local `Group` definitions; import `SettingsGroup`. Delete the inline probe list; import `PathProbes`. No markup changes — the existing section tests are the proof.

- [ ] **Step 5: Run the full renderer suite**

Run: `pnpm exec vitest run tests/components tests/features/settings && pnpm lint`
Expected: PASS, with every pre-existing settings test unmodified.

- [ ] **Step 6: Commit**

```bash
git add src tests
git commit -m "refactor(settings): share Group and PathProbes, add a Switch primitive (HIVE-58)"
```

---

### Task 7: The Integrations section

**Files:**
- Create: `src/features/settings/components/integrations-section.tsx`, `src/features/integrations/hooks/use-notification-activate.ts`
- Modify: `src/features/settings/components/settings-overlay.tsx:44-62`, `src/components/layout/app-shell.tsx`
- Test: `tests/features/settings/integrations-section.test.tsx`, `tests/hooks/use-notification-activate.test.ts`

**Interfaces:**
- Consumes: `IntegrationsStatus` + `window.hive.integrations.status()` (Task 4), `setNotificationPrefs` (Task 3), `Switch` / `SettingsGroup` / `PathProbes` (Task 6), `useProjectConfig`, `useOpenTab`
- Produces: `<IntegrationsSection />`, registered as `{ id: 'integrations', label: 'Integrations' }`

- [ ] **Step 1: Write the failing test**

```tsx
it('explains where it looked when gh is not installed', async () => {
  stubBridge({ gh: { installed: false, probes: [{ directory: '/usr/bin', found: false }], ... } });
  render(<IntegrationsSection />);

  expect(await screen.findByText(/GitHub CLI was not found/i)).toBeInTheDocument();
  expect(screen.getByText('/usr/bin')).toBeInTheDocument();
});

it('names the account and the token source when gh is authenticated', async () => { ... });

it('says the PR list is fixture-backed and that no token is stored', async () => {
  stubBridge({ gh: { installed: true, authenticated: true, tokenSource: 'keyring', ... } });
  render(<IntegrationsSection />);

  expect(await screen.findByText(/does not store a token/i)).toBeInTheDocument();
});

it('writes a preference through the verb when a switch is toggled', async () => {
  render(<IntegrationsSection />);

  await userEvent.click(await screen.findByRole('switch', { name: /session finished/i }));
  expect(setNotificationPrefs).toHaveBeenCalledWith({ sessionDone: false });
});

it('replaces the switches with an explanation when the OS has no notification support', async () => {
  stubBridge({ notificationsSupported: false });
  render(<IntegrationsSection />);

  expect(await screen.findByText(/this system has no notification support/i)).toBeInTheDocument();
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
});

it('falls back to a plain message with no bridge — the browser demo', () => {
  render(<IntegrationsSection />);
  expect(screen.getByText(/only available in the desktop app/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run tests/features/settings/integrations-section.test.tsx`
Expected: FAIL — cannot resolve the component.

- [ ] **Step 3: Implement the section**

Three `SettingsGroup`s — GitHub CLI, Token source, Notifications — following `runtime-section.tsx`'s exact shape: `useProjectConfig()` for prefs, a `useEffect` that loads `integrations.status()` once, the same no-bridge early return, and the same `snapshot.errors` banner.

- [ ] **Step 4: Register it — the two promised lines**

`settings-overlay.tsx`: add `{ id: 'integrations', label: 'Integrations' }` to `SECTIONS` and `integrations: IntegrationsSection` to `PANES`.

- [ ] **Step 5: Implement click-to-open**

`use-notification-activate.ts`, modelled line-for-line on `use-session-status.ts`:

```ts
export function useNotificationActivate(): void {
  const openTab = useOpenTab();

  useEffect(() => {
    const bridge = window.hive;
    if (!bridge) return;

    return bridge.notifications.onActivate(({ entityId }) => openTab(entityId));
  }, [openTab]);
}
```

Mount it in `app-shell.tsx` beside `useSessionStatus()`.

- [ ] **Step 6: Run the suite and the gates**

Run: `pnpm exec vitest run && pnpm lint && pnpm type-check && pnpm verify:boundaries`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src tests
git commit -m "feat(settings): add the Integrations section (HIVE-58)"
```

---

### Task 8: End-to-end proof, and the scope note for 108

**Files:**
- Create: `tests/e2e/settings-integrations.spec.ts`
- Test: the spec itself

- [ ] **Step 1: Write the e2e spec**

Following `tests/e2e/`'s existing `_electron` + `HIVE_CONFIG_PATH` sandbox pattern:

```ts
test('Integrations reports a gh state without throwing when gh is absent', async () => {
  // The runner may or may not have gh installed; both are valid answers and
  // neither may crash the pane. That is the assertion.
});

test('toggling a notification switch lands in the file, comments intact', async () => {
  // Open settings → Integrations, click the "Session finished" switch,
  // then read the sandboxed config.json and assert:
  //   - notifications.sessionDone === false
  //   - the template's "//" comment keys are still present
});
```

Remember (from story 105's note on HIVE-60): the overlay is `aria-modal`, so Radix marks the rest of the tree `aria-hidden` — a role query for the left rail cannot resolve until settings is dismissed.

- [ ] **Step 2: Run the e2e suites**

Run: `pnpm test:e2e`
Expected: PASS — web and electron projects both.

- [ ] **Step 3: Full gate run**

Run: `pnpm lint && pnpm type-check && pnpm verify:boundaries && pnpm test:coverage`
Expected: all PASS, coverage above the 80 gate.

- [ ] **Step 4: Commit**

```bash
git add tests
git commit -m "test(settings): e2e for integrations and notification preferences (HIVE-58)"
```

- [ ] **Step 5: Post the scope note to HIVE-60**

A comment recording `config:set-notifications` as the sixth mutating verb, its partial-write conformance case (saving `sessionIdle` leaves a hand-written `sessionDone` byte-identical; an absent `notifications` key stays absent until a switch is touched), and that `integrations:status` is read-only and should be shown not to touch the file at all.

---

## Self-Review

**Spec coverage:** `probeCommand` → Task 1. gh detection/auth/token source → Task 4. Notification schema → Task 2, write verb → Task 3, emitter + activate → Task 5. Shared UI extractions and the `Switch` → Task 6. Section + registration + click-to-open renderer half → Task 7. e2e, gates and the 108 note → Task 8. Every "What ships" subsection maps to a task.

**Placeholder scan:** The two refactor tasks say "moved verbatim" for code that already exists in the tree at cited line numbers — that is an instruction to move specific code, not a placeholder. Every new function has its signature and its decisive logic written out.

**Type consistency:** `NotificationPrefs` / `DEFAULT_NOTIFICATIONS` / `NOTIFICATION_KEYS` (Task 2) are consumed under those exact names in Tasks 3, 5 and 7. `probeCommand`'s `CommandProbe` (Task 1) is destructured as `{ isPath, resolved, probes }` in Tasks 1 and 4. `GhStatus` field names match between Tasks 4 and 7. `setNotificationPrefs` is the renderer helper in Tasks 3 and 7; `setNotifications` is the main-side verb.
