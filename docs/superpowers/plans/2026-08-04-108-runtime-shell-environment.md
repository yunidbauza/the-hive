# Login shell defaulting and workspace environment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Default a session's shell to the user's real login shell, and add a workspace-level environment layer above per-project `env`.

**Architecture:** Resolution stays in main. A new `main/config/shell.ts` answers "what shell" from the password database with injected inputs so every branch is testable. `ConfigSnapshot` gains a top-level `env` that `effectiveRuntime` merges *under* the project's, matching how `shell` and `claudeCommand` already resolve. The pty-host is untouched — `buildEnv` already merges an injected map. A second diagnostic runs the resolved shell once and reports which variables its rc file overrode.

**Tech Stack:** TypeScript, Electron (main / preload / pty-host `utilityProcess`), React 19, Zustand, Vitest, Playwright.

**Spec:** [`../specs/2026-08-04-108-runtime-shell-environment-design.md`](../specs/2026-08-04-108-runtime-shell-environment-design.md)

## Global Constraints

- All commands run from `app/`. Unit tests: `pnpm vitest run <path>`. Type check: `pnpm type-check`. Lint: `pnpm lint`. Boundaries: `pnpm verify:boundaries`.
- **`tests/` mirrors source, exactly.** A test for `electron/main/config/X.ts`
  lives at `tests/electron/main/config/X.test.ts`. Do not put main-process
  tests in `tests/config/` — that directory mirrors `src/config/` (the
  renderer's `isDesktop`/`env`), and the two `runtime.ts` files are different
  modules. This was wrong in the plan's first draft and corrected after Task 1.
- **Tests under `tests/electron/` use relative imports and no aliases.** All 30
  of them do: `import { effectiveRuntime } from '../../../../electron/main/config/runtime';`.
  Production code under `electron/` *does* use `@shared/…`; tests do not. Do
  not add an alias to reach main-process code from a test.
- **Every test under `tests/electron/` starts with `// @vitest-environment node`**
  on line 1. The suite default is `happy-dom` (`vitest.config.ts:24`).
- `app/electron/shared/config-contract.ts` is **types and constants only — no Node APIs, no DOM APIs**. It is imported by the renderer. `node:os` must never appear there.
- The refusal list is shared: `unsafeEnvReason()` in `config-contract.ts` is the single rule, enforced by both `shared/guards.ts` (bridge) and `main/config/parse.ts` (file). Never add a second copy.
- Env limits are already fixed and must match across both entry points: `MAX_ENV_ENTRIES = 200`, `MAX_ENV_VALUE = 4096` (`parse.ts:124-125`), `MAX_ENV_ENTRIES = 200` (`guards.ts:404`).
- An env map is **all-or-nothing**. Any bad member rejects the whole map with a message; never salvage per key (`parse.ts:136-142`).
- Config writes **spread, never rebuild** — unknown keys survive a write.
- POSIX only. No `PATHEXT`, no Windows branch.
- Every mutating verb returns a fresh `ConfigSnapshot`; the renderer never follows a write with a reload.

---

### Task 1: `defaultShell()`

**Files:**
- Create: `app/electron/main/config/shell.ts`
- Test: `app/tests/electron/main/config/shell.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `defaultShell(userInfo?: () => { shell?: string | null }, platform?: string): string`. Both parameters injected with real defaults so production callers write `defaultShell()`.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
// app/tests/electron/main/config/shell.test.ts
import { describe, expect, it } from 'vitest';

import { defaultShell } from '../../../../electron/main/config/shell';

const info = (shell: string | null) => () => ({ shell });

describe('defaultShell', () => {
  it('uses an absolute shell from the password database', () => {
    expect(defaultShell(info('/bin/zsh'), 'darwin')).toBe('/bin/zsh');
    expect(defaultShell(info('/usr/local/bin/fish'), 'linux')).toBe(
      '/usr/local/bin/fish',
    );
  });

  it('falls back to /bin/zsh on darwin when the entry is unusable', () => {
    expect(defaultShell(info(null), 'darwin')).toBe('/bin/zsh');
    expect(defaultShell(info(''), 'darwin')).toBe('/bin/zsh');
    // Relative paths cannot be spawned; they must not reach pty.spawn.
    expect(defaultShell(info('zsh'), 'darwin')).toBe('/bin/zsh');
  });

  it('falls back to /bin/sh off darwin', () => {
    expect(defaultShell(info(null), 'linux')).toBe('/bin/sh');
    expect(defaultShell(info('bash'), 'linux')).toBe('/bin/sh');
  });

  it('survives a userInfo that throws', () => {
    const throws = () => {
      throw new Error('getpwuid failed');
    };
    expect(defaultShell(throws, 'darwin')).toBe('/bin/zsh');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/electron/main/config/shell.test.ts`
Expected: FAIL — cannot resolve `../../../../electron/main/config/shell`.

- [ ] **Step 3: Write the implementation**

```ts
// app/electron/main/config/shell.ts
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_SHELL } from '@shared/config-contract';

/**
 * The shell a session spawns when nothing overrides it.
 *
 * **`getpwuid`, not `$SHELL`.** Three comments in this codebase have long
 * claimed the default came from `$SHELL`; none of them was ever true, and
 * making it true would have been the wrong fix. A GUI app opened from Finder
 * or the Dock inherits launchd's environment, where `SHELL` is unset — the
 * same launch mode `config/runtime.ts` already warns about for `PATH`. So the
 * variable is absent in exactly the case that matters most, a packaged build.
 * `os.userInfo()` reads the password database, which is populated regardless
 * of how the process was started.
 *
 * Both inputs are injected so the branches are testable without mocking
 * `node:os`.
 */
export function defaultShell(
  userInfo: () => { shell?: string | null } = os.userInfo,
  platform: string = process.platform,
): string {
  let login: string | null | undefined;
  try {
    login = userInfo().shell;
  } catch {
    // A container or a directory service that cannot answer is not an error
    // worth surfacing — it is a reason to use the platform default.
    login = null;
  }

  /**
   * Absolute or nothing. A relative or empty entry cannot be spawned, and
   * letting it through would fail inside the child with no context — the
   * failure mode `config/resolve.ts` already documents for `cwd`.
   */
  if (typeof login === 'string' && login !== '' && path.isAbsolute(login)) {
    return login;
  }

  return platform === 'darwin' ? '/bin/zsh' : DEFAULT_SHELL;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run tests/electron/main/config/shell.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/electron/main/config/shell.ts app/tests/electron/main/config/shell.test.ts
git commit -m "feat(config): resolve the default shell from the password database"
```

---

### Task 2: Use `defaultShell()`, and correct the three false comments

**Files:**
- Modify: `app/electron/main/config/write.ts:219`
- Modify: `app/electron/main/config/index.ts` (the load path's `?? DEFAULT_SHELL`)
- Modify: `app/electron/shared/config-contract.ts:188`, `:231`
- Modify: `app/electron/main/config/template.ts:25`
- Test: `app/tests/electron/main/config/shell.test.ts` (extend)

**Interfaces:**
- Consumes: `defaultShell()` from Task 1.
- Produces: `ConfigSnapshot.shell` is the login shell when the file names none.

- [ ] **Step 1: Find every `?? DEFAULT_SHELL` site**

Run: `rg -n 'DEFAULT_SHELL' app/electron/main`
Expected: `write.ts:219` and the equivalent in `config/index.ts`. Record both; every one must change.

- [ ] **Step 2: Write the failing test**

```ts
// append to app/tests/electron/main/config/shell.test.ts
// Add to the existing import block at the top of the file:
//   import { emptySnapshot } from '../../../../electron/shared/config-contract';

describe('snapshot defaulting', () => {
  it('a file naming no shell resolves to the login shell, not /bin/sh', () => {
    // emptySnapshot takes the resolved shell as its second argument; the
    // callers in main now pass defaultShell() rather than the constant.
    const snapshot = emptySnapshot('/tmp/config.json', defaultShell(info('/bin/zsh'), 'darwin'));
    expect(snapshot.shell).toBe('/bin/zsh');
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm vitest run tests/electron/main/config/shell.test.ts`
Expected: FAIL — `info` is not defined at this scope if the helper was declared inside the first `describe`. Hoist `const info` to module scope, re-run, and confirm the assertion itself is what fails.

- [ ] **Step 4: Replace the constant with the function at both sites**

In `write.ts:219`:

```ts
shell: validated.shell ?? defaultShell(),
```

Apply the identical change at the `config/index.ts` site found in Step 1. Add `import { defaultShell } from './shell';` to both. Remove the now-unused `DEFAULT_SHELL` import where nothing else uses it — `pnpm lint` will flag it.

- [ ] **Step 5: Correct the three false comments**

`config-contract.ts:188`:

```ts
  /** The login shell for every session, already defaulted by `defaultShell()`. */
```

`config-contract.ts:231`:

```ts
/** The last-resort shell: used off darwin when the password database has no usable entry. */
```

`template.ts:25`:

```ts
    '//shell': 'Optional. The login shell every session runs. Defaults to your account login shell.',
```

- [ ] **Step 6: Run the full unit suite and the type check**

Run: `pnpm vitest run && pnpm type-check`
Expected: PASS. If a test asserts `/bin/sh` as a *default* rather than a seeded value, fix the test — that is the regression audit the spec calls for. Tests that seed `shell` explicitly (`runtime-settings.spec.ts:43`) are correct as written and must not be touched.

- [ ] **Step 7: Commit**

```bash
git add app/electron app/tests
git commit -m "feat(config): default the shell to the login shell, correct the \$SHELL comments"
```

---

### Task 3: Read a top-level `env` from the config file

**Files:**
- Modify: `app/electron/main/config/parse.ts` (`TOP_LEVEL_KEYS:85`, `ParsedConfig:39`, `parseConfig:316`)
- Test: `app/tests/electron/main/config/parse.test.ts` (extend)

**Interfaces:**
- Consumes: `optionalEnv(value, label, errors)` — already in `parse.ts:143`, already applies `FORBIDDEN_KEYS`, `ENV_NAME`, `unsafeEnvReason`, `MAX_ENV_ENTRIES`, `MAX_ENV_VALUE` and the control-character rule.
- Produces: `ParsedConfig.env: Record<string, string> | undefined` — `undefined` when the file has no block, matching how `notifications` is kept partial.

- [ ] **Step 1: Write the failing test**

```ts
// append to app/tests/electron/main/config/parse.test.ts
// `parseConfig` is ALREADY imported at the top of this file — do not re-import it.

const doc = (extra: object) =>
  JSON.stringify({ version: 2, projects: [], ...extra });

describe('top-level env', () => {
  it('reads a well-formed block', () => {
    const parsed = parseConfig(doc({ env: { AWS_PROFILE: 'incorp' } }), 'cfg');
    expect(parsed.env).toEqual({ AWS_PROFILE: 'incorp' });
    expect(parsed.errors).toEqual([]);
  });

  it('is undefined when the file has no block', () => {
    expect(parseConfig(doc({}), 'cfg').env).toBeUndefined();
  });

  it('is no longer reported as an unknown key', () => {
    const parsed = parseConfig(doc({ env: {} }), 'cfg');
    expect(parsed.errors.join(' ')).not.toMatch(/unknown/i);
  });

  it('rejects the whole map on an unsafe key, with the shared message', () => {
    const parsed = parseConfig(doc({ env: { PATH: '/x', DYLD_INSERT_LIBRARIES: '/evil' } }), 'cfg');
    expect(parsed.env).toBeUndefined();
    expect(parsed.errors.join(' ')).toMatch(/dynamic loader/);
  });

  it('rejects a reserved key', () => {
    const parsed = parseConfig(doc({ env: { TERM: 'dumb' } }), 'cfg');
    expect(parsed.env).toBeUndefined();
    expect(parsed.errors.join(' ')).toMatch(/set by the terminal/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run tests/electron/main/config/parse.test.ts`
Expected: FAIL — `parsed.env` is `undefined` in the first case, and the third case reports `env` as an unknown top-level key.

- [ ] **Step 3: Add `env` to the key list and the parsed shape**

In `parse.ts`, add `'env'` to `TOP_LEVEL_KEYS` (after `'claudeCommand'`) with a comment matching the one already above `PROJECT_KEYS`:

```ts
const TOP_LEVEL_KEYS = [
  'version',
  'shell',
  'claudeCommand',
  // Story 108's workspace environment. Listed for the same reason the
  // per-project overrides below are: a hand-written block must be read, not
  // reported as a mistake.
  'env',
  'projects',
  'notifications',
];
```

Add to `ParsedConfig`:

```ts
  /**
   * The workspace environment block, exactly as the file declared it.
   *
   * `undefined` when absent — kept undefined rather than defaulted to `{}` for
   * the same reason `notifications` is kept partial: the write path must be
   * able to tell "the user chose this" from "the file said nothing", which is
   * what stops an untouched file from growing a block it never had.
   */
  env?: Record<string, string>;
```

- [ ] **Step 4: Read it in `parseConfig`, reusing `optionalEnv`**

Alongside the existing top-level reads in `parseConfig`, add:

```ts
  const env =
    document.env === undefined
      ? undefined
      : optionalEnv(document.env, `${label}.env`, errors);
```

and include `env` in the returned object. `optionalEnv` already returns `undefined` and pushes a message on any bad member, which is the all-or-nothing rule.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/electron/main/config/parse.test.ts`
Expected: PASS (5 new tests).

- [ ] **Step 6: Commit**

```bash
git add app/electron/main/config/parse.ts app/tests/electron/main/config/parse.test.ts
git commit -m "feat(config): read a workspace-level env block from the config file"
```

---

### Task 4: Carry `env` through the snapshot, the guard, and the write verb

**Files:**
- Modify: `app/electron/shared/config-contract.ts` (`ConfigSnapshot`, `SetRuntimeRequest:395`, `emptySnapshot`)
- Modify: `app/electron/shared/guards.ts` (`parseSetRuntimeRequest:464`)
- Modify: `app/electron/main/config/write.ts` (`:219` block) and `app/electron/main/config/index.ts` (`setRuntime:455`)
- Test: `app/tests/electron/main/config/parse.test.ts`, `app/tests/electron/shared/guards.runtime.test.ts`

**Interfaces:**
- Consumes: `ParsedConfig.env` (Task 3); `assertEnv(value, label)` — already in `guards.ts:419`.
- Produces: `ConfigSnapshot.env: Record<string, string>` (always resolved, `{}` when unset). `SetRuntimeRequest.env?: Record<string, string>`.

- [ ] **Step 1: Write the failing guard test**

```ts
// append to app/tests/electron/shared/guards.runtime.test.ts
// `parseSetRuntimeRequest` is ALREADY imported at the top of this file — do not re-import it.

describe('parseSetRuntimeRequest env', () => {
  it('accepts a valid map', () => {
    expect(parseSetRuntimeRequest({ env: { AWS_PROFILE: 'incorp' } })).toEqual({
      env: { AWS_PROFILE: 'incorp' },
    });
  });

  it('accepts an empty map — that is how the last variable is removed', () => {
    expect(parseSetRuntimeRequest({ env: {} })).toEqual({ env: {} });
  });

  it('refuses the same keys the project layer refuses', () => {
    for (const key of ['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'BASH_ENV', 'TERM', 'COLORTERM', 'PWD']) {
      expect(() => parseSetRuntimeRequest({ env: { [key]: 'x' } })).toThrow();
    }
  });

  it('still refuses a request that changes nothing', () => {
    expect(() => parseSetRuntimeRequest({})).toThrow(/nothing to change/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run tests/electron/shared/guards.runtime.test.ts`
Expected: FAIL — `env` is rejected as an unexpected key by `assertShape`.

- [ ] **Step 3: Extend the contract types**

In `config-contract.ts`, add to `ConfigSnapshot` (next to `claudeCommand`):

```ts
  /**
   * Environment applied to every session, under any project's own (story 108).
   *
   * Always fully resolved — `{}` rather than absent — for the reason
   * `notifications` is: main reads this on every spawn, and a consumer that
   * must remember to apply a default is one that will forget on one branch.
   */
  env: Record<string, string>;
```

Extend `SetRuntimeRequest`:

```ts
export interface SetRuntimeRequest {
  shell?: string;
  claudeCommand?: string;
  /**
   * The whole map, replacing what is stored — not a patch.
   *
   * `{}` is meaningful and is how the last variable is removed. Unlike `shell`,
   * there is no `null` case: absent already means "leave it alone".
   */
  env?: Record<string, string>;
}
```

Add `env: {}` to the object `emptySnapshot()` returns.

- [ ] **Step 4: Extend the guard**

In `parseSetRuntimeRequest`, add `'env'` to the optional-key list and handle it:

```ts
export function parseSetRuntimeRequest(input: unknown): SetRuntimeRequest {
  const raw = assertShape(input, [], 'setRuntime', [
    'shell',
    'claudeCommand',
    'env',
  ]);
  if (
    raw.shell === undefined &&
    raw.claudeCommand === undefined &&
    raw.env === undefined
  ) {
    return fail('setRuntime: nothing to change');
  }

  return {
    ...(raw.shell !== undefined
      ? { shell: assertText(raw.shell, 'setRuntime.shell') }
      : {}),
    ...(raw.claudeCommand !== undefined
      ? { claudeCommand: assertText(raw.claudeCommand, 'setRuntime.claudeCommand') }
      : {}),
    // Reuses the project layer's helper verbatim. A second implementation
    // would drift, and the drifted copy is the one nobody tests.
    ...(raw.env !== undefined ? { env: assertEnv(raw.env, 'setRuntime.env') } : {}),
  };
}
```

- [ ] **Step 5: Resolve and persist it**

In `write.ts`, add to the returned snapshot next to `shell`:

```ts
      env: validated.env ?? {},
```

In `index.ts`'s `setRuntime`, add the same conditional spread the other two fields use:

```ts
      ...(request.env !== undefined ? { env: request.env } : {}),
```

Apply the identical `env: validated.env ?? {}` line at the load-path snapshot site found in Task 2 Step 1.

- [ ] **Step 6: Run the tests and the type check**

Run: `pnpm vitest run && pnpm type-check`
Expected: PASS. The type check is what proves every `ConfigSnapshot` construction site was updated — `env` is required, so a missed one cannot compile.

- [ ] **Step 7: Commit**

```bash
git add app/electron app/tests
git commit -m "feat(config): carry a workspace env through the snapshot, guard and write verb"
```

---

### Task 5: Merge the two env layers in `effectiveRuntime`

**Files:**
- Modify: `app/electron/main/config/runtime.ts:49`
- Test: `app/tests/electron/main/config/runtime.test.ts`

**Interfaces:**
- Consumes: `ConfigSnapshot.env` (Task 4).
- Produces: `EffectiveRuntime.env` — the merged map. No signature change.

- [ ] **Step 1: Write the failing test**

```ts
// append to app/tests/electron/main/config/runtime.test.ts
describe('effectiveRuntime env layering', () => {
  const snapshot = (env: Record<string, string>) =>
    ({ ...emptySnapshot('/tmp/c.json', '/bin/zsh'), env }) as ConfigSnapshot;

  it('uses the workspace env when the project has none', () => {
    const runtime = effectiveRuntime(snapshot({ A: '1' }), null);
    expect(runtime.env).toEqual({ A: '1' });
  });

  it('merges both layers, project winning per key', () => {
    const project = { id: 'p', env: { A: 'project', B: '2' } } as ProjectConfig;
    const runtime = effectiveRuntime(snapshot({ A: 'workspace', C: '3' }), project);
    expect(runtime.env).toEqual({ A: 'project', B: '2', C: '3' });
  });

  it('returns a fresh object that does not alias either source', () => {
    const workspace = { A: '1' };
    const runtime = effectiveRuntime(snapshot(workspace), null);
    runtime.env.A = 'mutated';
    expect(workspace.A).toBe('1');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run tests/electron/main/config/runtime.test.ts`
Expected: FAIL — the first case returns `{}` because only the project layer is read today.

- [ ] **Step 3: Merge the layers**

Replace `runtime.ts:49`:

```ts
    /**
     * Workspace first, project over it, per key (story 108) — the same
     * "project overrides default" rule `shell` and `claudeCommand` above
     * already follow, so all three runtime values resolve the same way.
     *
     * A fresh object every call: the caller passes this to the pty-host, and
     * handing out either stored map would let a mutation downstream edit the
     * cached config.
     */
    env: { ...snapshot.env, ...(project?.env ?? {}) },
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/electron/main/config/runtime.test.ts`
Expected: PASS (3 new tests).

- [ ] **Step 5: Commit**

```bash
git add app/electron/main/config/runtime.ts app/tests/electron/main/config/runtime.test.ts
git commit -m "feat(config): merge workspace env under per-project env"
```

---

### Task 6: The workspace env editor in Runtime settings

**Files:**
- Modify: `app/src/features/settings/components/runtime-section.tsx` (the `Defaults` group)
- Test: `app/tests/features/settings/runtime-section.test.tsx`

**Interfaces:**
- Consumes: `setRuntimeConfig(request: SetRuntimeRequest): Promise<void>` (`lib/project-config.ts:137`, unchanged — `env` rides the existing request type from Task 4); `EnvEditor` (`env-editor.tsx`, unchanged).
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

```tsx
// app/tests/features/settings/runtime-section.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const setRuntimeConfig = vi.fn();
vi.mock('@lib/project-config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setRuntimeConfig,
}));

describe('RuntimeSection workspace env', () => {
  it('saves a workspace variable through setRuntimeConfig', async () => {
    render(<RuntimeSection />); // with a snapshot providing env: {}
    fireEvent.click(screen.getByRole('button', { name: /add variable/i }));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'AWS_PROFILE' } });
    fireEvent.change(screen.getByLabelText(/value/i), { target: { value: 'incorp' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(setRuntimeConfig).toHaveBeenCalledWith({ env: { AWS_PROFILE: 'incorp' } });
  });

  it('states that the rc file runs afterward', () => {
    render(<RuntimeSection />);
    expect(screen.getByText(/rc file runs afterward and can override/i)).toBeInTheDocument();
  });
});
```

Match the existing settings component tests for render harness and snapshot stubbing — read `app/tests/features/settings/` first and follow whatever they already do rather than inventing a second pattern.

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run tests/features/settings/runtime-section.test.tsx`
Expected: FAIL — there is no add-variable control in the Defaults group.

- [ ] **Step 3: Add the editor to the Defaults group**

In `runtime-section.tsx`, inside the existing `Defaults` `SettingsGroup`, below the two-column grid:

```tsx
        <div className="flex flex-col gap-1.5 pt-1">
          <p className="text-[11.5px] text-subtle">
            Environment for every session. Set before the shell starts — a login
            shell’s rc file runs afterward and can override these. Prefer your rc
            file for tokens: this file is stored in plain text.
          </p>
          <EnvEditor
            value={snapshot.env}
            onSave={(env) => void setRuntimeConfig({ env })}
          />
        </div>
```

`EnvEditor` is already imported at `runtime-section.tsx:6`. Do not modify it: it is bound by props alone and already carries the validation, the draft state and the explicit commit.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/features/settings/runtime-section.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Run lint and the boundary check**

Run: `pnpm lint && pnpm verify:boundaries`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/features/settings/components/runtime-section.tsx app/tests/features/settings
git commit -m "feat(settings): edit the workspace environment in Runtime settings"
```

---

### Task 7: The environment diagnostic

**Files:**
- Modify: `app/electron/shared/config-contract.ts` (add `EnvDiagnostic`)
- Create: `app/electron/main/config/env-diagnostic.ts`
- Modify: `app/electron/shared/ipc-contract.ts` (add `configDiagnoseEnv`), `app/electron/preload/index.ts`, `app/electron/main/ipc/index.ts`, `app/src/lib/project-config.ts`
- Modify: `app/src/features/settings/components/runtime-section.tsx`
- Test: `app/tests/electron/main/config/env-diagnostic.test.ts`

**Interfaces:**
- Consumes: `effectiveRuntime` (Task 5); `EffectiveRuntime.shell`, `.env`.
- Produces:

```ts
export interface EnvVarVerdict {
  key: string;
  configured: string;
  actual: string | null;
  /** True when the shell reported a different value than was injected. */
  overridden: boolean;
}

export interface EnvDiagnostic {
  projectId: string | null;
  shell: string;
  /** Present when the probe could not run; `vars` is empty when set. */
  error: string | null;
  vars: EnvVarVerdict[];
}
```

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
// app/tests/electron/main/config/env-diagnostic.test.ts
import { describe, expect, it } from 'vitest';

import { compareEnv } from '../../../../electron/main/config/env-diagnostic';

describe('compareEnv', () => {
  it('marks a variable the shell kept as applied', () => {
    const vars = compareEnv({ A: '1' }, 'A=1\nB=2\n');
    expect(vars).toEqual([{ key: 'A', configured: '1', actual: '1', overridden: false }]);
  });

  it('marks a variable the rc file changed as overridden', () => {
    const vars = compareEnv({ AWS_PROFILE: 'hive' }, 'AWS_PROFILE=incorp\n');
    expect(vars[0]).toMatchObject({ actual: 'incorp', overridden: true });
  });

  it('marks a variable the shell dropped entirely', () => {
    expect(compareEnv({ A: '1' }, 'B=2\n')[0]).toMatchObject({
      actual: null,
      overridden: true,
    });
  });

  it('keeps a value containing "=" intact', () => {
    expect(compareEnv({ A: 'x=y' }, 'A=x=y\n')[0]).toMatchObject({
      actual: 'x=y',
      overridden: false,
    });
  });

  it('reports only configured variables, not the shell’s whole environment', () => {
    expect(compareEnv({ A: '1' }, 'A=1\nPATH=/usr/bin\nHOME=/root\n')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run tests/electron/main/config/env-diagnostic.test.ts`
Expected: FAIL — cannot resolve `../../../../electron/main/config/env-diagnostic`.

- [ ] **Step 3: Write the module**

```ts
// app/electron/main/config/env-diagnostic.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { EffectiveRuntime, EnvDiagnostic, EnvVarVerdict } from '@shared/config-contract';

/**
 * Diff what was injected against what the shell actually ended up with.
 *
 * Split from the probe so the parsing is unit-testable without spawning
 * anything — the same separation `probe.ts` has from `diagnoseCommand`.
 *
 * Only configured variables are reported. Dumping the shell's whole
 * environment would bury the answer and would put the user's secrets on
 * screen.
 */
export function compareEnv(
  configured: Record<string, string>,
  printenv: string,
): EnvVarVerdict[] {
  const actual = new Map<string, string>();
  for (const rawLine of printenv.split('\n')) {
    // Split on the FIRST `=` only: values legitimately contain more.
    const at = rawLine.indexOf('=');
    if (at <= 0) continue;
    actual.set(rawLine.slice(0, at), rawLine.slice(at + 1));
  }

  return Object.entries(configured).map(([key, value]) => {
    const found = actual.get(key) ?? null;
    return {
      key,
      configured: value,
      actual: found,
      overridden: found !== value,
    };
  });
}

/**
 * Run the resolved shell once and report what survived.
 *
 * `execFile` semantics with `shell: false`, the rule `integrations/gh.ts`
 * states: the shell is the *program*, never an interpreter for a string this
 * process assembled. Read-only, so it does not go through `writeConfig` —
 * matching `diagnoseCommand`.
 */
export async function diagnoseEnv(
  runtime: EffectiveRuntime,
  projectId: string | null,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<EnvDiagnostic> {
  try {
    const printenv = await execFileAsync(runtime.shell, ['-l', '-i', '-c', 'printenv'], {
      env: { ...baseEnv, ...runtime.env },
      encoding: 'utf8',
      timeout: 5_000,
      // An rc file that writes to stderr is normal and is not our business.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { projectId, shell: runtime.shell, error: null, vars: compareEnv(runtime.env, printenv) };
  } catch (cause) {
    /**
     * A failed probe is a failed *observation*, never a configuration error.
     * Reporting it as the latter would tell the user their settings are wrong
     * when all that happened is that a diagnostic could not run.
     */
    return {
      projectId,
      shell: runtime.shell,
      error: cause instanceof Error ? cause.message : String(cause),
      vars: [],
    };
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/electron/main/config/env-diagnostic.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire the channel**

Follow `configDiagnoseCommand` exactly, in the four places it appears — it is the closest possible template, being the other read-only diagnostic:

1. `ipc-contract.ts` — add `configDiagnoseEnv: 'config:diagnose-env'` beside it.
2. `main/ipc/index.ts` — register the handler, reusing the same request guard `configDiagnoseCommand` uses (payload is `{ id?: string }`) and calling `diagnoseEnv(effectiveRuntime(snapshot, project), id ?? null)`.
3. `preload/index.ts` — add `diagnoseEnv` next to `diagnoseCommand:120`.
4. `src/lib/project-config.ts` — add `diagnoseSessionEnv`, copying `diagnoseAgentCommand:248` including its `return null` on a missing bridge or a thrown channel.

Run: `pnpm type-check`
Expected: PASS.

- [ ] **Step 6: Add the UI group**

In `runtime-section.tsx`, add the state and handler beside the existing
`diagnostic` pair, then the group. `runEnvDiagnostic` mirrors `runDiagnostic`
exactly, including passing `{}` rather than `{ id: '' }` for the default:

```tsx
  const [envDiagnostic, setEnvDiagnostic] = useState<EnvDiagnostic | null>(null);

  const runEnvDiagnostic = async () => {
    const result = await diagnoseSessionEnv(
      selectedId === '' ? {} : { id: selectedId },
    );
    setEnvDiagnostic(result);
  };
```

Then add a `SettingsGroup` below the existing `Command diagnostic`, driven by the same `selectedId` so both diagnostics describe the same target:

```tsx
      <SettingsGroup
        title="Environment diagnostic"
        description="Which variables survived the shell’s rc file."
      >
        <button
          type="button"
          onClick={() => void runEnvDiagnostic()}
          className="w-fit rounded-[6px] border border-border px-2.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink"
        >
          {selectedId === '' ? 'Check the default shell' : 'Check this project’s shell'}
        </button>
        {envDiagnostic ? <EnvDiagnosticView diagnostic={envDiagnostic} /> : null}
      </SettingsGroup>
```

Clear `envDiagnostic` in the project `onChange` handler alongside `setDiagnostic(null)` — for the reason already commented there: a verdict describing the old project's shell would be actively misleading next to a new selection.

Write `EnvDiagnosticView` in `app/src/features/settings/components/env-diagnostic-view.tsx`, following `command-diagnostic-view.tsx` for markup and tone. It renders `error` when set, otherwise one row per verdict: the key, the configured value, and — when `overridden` — the actual value with the note `overridden by your rc file` (or `dropped by your rc file` when `actual` is `null`).

- [ ] **Step 7: Run everything**

Run: `pnpm vitest run && pnpm type-check && pnpm lint && pnpm verify:boundaries`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/electron app/src app/tests
git commit -m "feat(settings): add an environment diagnostic showing rc-file overrides"
```

---

### Task 8: End-to-end coverage

**Files:**
- Modify: `app/tests/e2e/electron/runtime-settings.spec.ts`
- Modify: `app/tests/conformance/environment.conformance.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Add the conformance assertion**

In `environment.conformance.mjs`, extend the existing environment assertions: spawn with a merged map and assert the child's environment contains both a workspace-only key and a project key that overrode a workspace one. Follow the file's existing harness usage; do not add a second harness.

Run: `pnpm test:pty`
Expected: PASS.

- [ ] **Step 2: Add the e2e spec**

In `runtime-settings.spec.ts`, seed a config with `shell: '/bin/sh'` (explicit, so this spec is unaffected by the new default), add a workspace env var through the UI, and assert the written config file contains a top-level `env` block. Then seed a project override for the same key and assert `effectiveRuntime` prefers it.

Run: `pnpm test:e2e:electron`
Expected: PASS.

- [ ] **Step 3: Full verification**

Run: `pnpm vitest run && pnpm type-check && pnpm lint && pnpm verify:boundaries && pnpm test:e2e:electron`
Expected: all PASS. Paste the real output into the commit body — do not summarise it.

- [ ] **Step 4: Commit**

```bash
git add app/tests
git commit -m "test: cover workspace env end to end and in pty conformance"
```

---

## Self-Review

**Spec coverage.** Decision 1 (`defaultShell` from the password database, living in main because `config-contract.ts` bans Node APIs) → Tasks 1–2, including the correction of the three false `$SHELL` comments. Decision 2 (workspace env layer, guard parity, `effectiveRuntime` merge) → Tasks 3–5. Decision 3 (rc file wins, stated in the UI) → Task 6. Decision 4 (secrets stay in the rc file) → Task 6's copy, as guidance rather than a guard, exactly as the spec argues. Decision 5 (env diagnostic, scoped by project like `diagnoseCommand`) → Task 7. The spec's Testing section maps as: `defaultShell` unit → Task 1; resolution unit → Task 5; guard parity → Task 4 Step 1; conformance → Task 8 Step 1; e2e → Task 8 Step 2; regression audit → Task 2 Step 6. "Out of scope: Windows" → Global Constraints.

**Type consistency.** `defaultShell(userInfo, platform)` is defined in Task 1 and called with zero arguments in Task 2, which the defaults permit. `ParsedConfig.env` (Task 3) is read as `validated.env` in Task 4. `ConfigSnapshot.env` (Task 4) is read as `snapshot.env` in Tasks 5 and 6. `SetRuntimeRequest.env` (Task 4) is the payload of `setRuntimeConfig({ env })` in Task 6. `EnvDiagnostic`, `EnvVarVerdict`, `compareEnv` and `diagnoseEnv` are defined in Task 7 and used under those names within it; the renderer helper is `diagnoseSessionEnv` in both the wiring step and the handler.

**Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N", no code step without a code block. Two steps deliberately direct the implementer to read existing files rather than restating them: Task 6 Step 1 (the settings render harness) and Task 7 Step 5 (the four `configDiagnoseCommand` wiring sites). Both name the exact file to copy, because inventing a second harness or a second channel shape is the failure mode worth preventing.

**One judgement call recorded.** Task 7 is the only task that is new mechanism rather than composition, and it is separable: `compareEnv` is pure and unit-tested apart from any spawn, so if the diagnostic is cut later, Tasks 1–6 stand alone and nothing else references it.
