# HIVE-52 — Settings: Add a Local Project Folder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a user on a fresh install opens Settings, clicks **Add project**, picks a folder, and starts a session in it — no console line, no hand-written JSON.

**Architecture:** bottom-up through the stack. The main-process config layer learns schema v2 and gains one atomic write path (`writeConfig`), then three guarded IPC channels expose it, then the renderer gains a fifth view state and a new `settings` feature slice. Every mutating verb returns a fresh `ConfigSnapshot`, so the renderer never follows a write with a reload.

**Tech Stack:** Electron (main/preload/renderer), TypeScript strict, React 19, Zustand, Tailwind v4, Vitest, Playwright.

**Spec:** [`docs/superpowers/specs/2026-08-03-hive-52-settings-add-local-project-design.md`](../specs/2026-08-03-hive-52-settings-add-local-project-design.md) — read it first. The story is [`stories/101-settings-add-local-project.md`](../../../stories/101-settings-add-local-project.md).

## Global Constraints

- `pnpm lint` and `pnpm type-check` must both pass before any task is done. No inline rule disables.
- `tests/` **mirrors** `src/` and `electron/`. 80% coverage on lines, statements, branches, functions.
- Colour comes from `--cc-*` tokens only. **Raw hex literals in component code are banned.** Missing colour → add a token.
- kebab-case filenames. Absolute `@/` imports, never `../`.
- `electron/shared/**` is types and constants only — no runtime imports, no Node APIs, no DOM APIs. The renderer imports from it **type-only**.
- `electron/main/**` may not import `src/**`. `src/**` may not import `electron/main/**`.
- Icons come from `@phosphor-icons/react`.
- `src/data/fixtures.ts` ends this story **byte-identical**.
- **`Cmd+,` is out of scope** (deferred to story 060). Do not add a keydown listener.
- Commit after every task with the `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` trailer.

## File Structure

**Created**
| File | Responsibility |
|---|---|
| `app/electron/main/config/write.ts` | `writeConfig` — the single atomic, comment-preserving write path |
| `app/electron/main/config/identity.ts` | `deriveProjectId` — basename → stable kebab id, collision suffixing |
| `app/src/features/settings/components/settings-overlay.tsx` | The full-stage overlay shell + section nav |
| `app/src/features/settings/components/projects-section.tsx` | The Projects pane: card, rows, add, errors |
| `app/src/features/settings/components/project-row.tsx` | One project row |
| `app/tests/electron/main/config/{parse,resolve,write,identity}.test.ts` | Config-layer unit tests |
| `app/tests/features/settings/components/*.test.tsx` | Settings slice tests |
| `app/tests/e2e/electron/settings.spec.ts` | The end-to-end proof |

**Modified** — `config-contract.ts`, `parse.ts`, `resolve.ts`, `config/index.ts`, `guards.ts`, `ipc-contract.ts`, `main/ipc/index.ts`, `preload/index.ts`, `eslint.config.mjs`, `resolve-view.ts`, `ui-store.ts`, `hive-store.ts`, `entity.ts`, `project-config.ts`, `icon.tsx`, `center-stage.tsx`, `header.tsx`, `new-session-picker.tsx`.

---

### Task 1: Schema v2 contract

**Files:**
- Modify: `app/electron/shared/config-contract.ts`

**Interfaces:**
- Produces: `ProjectOrigin`, `ProjectConfig` (now with `name`, `icon`, `origin`, `isRepo`), `CONFIG_VERSION = 2`, `SUPPORTED_CONFIG_VERSIONS`, `DEFAULT_PROJECT_ICON`, `AddProjectRequest`, `RemoveProjectRequest`.

This task is types only. It will break `parse.ts`, `resolve.ts` and `config/index.ts` — Tasks 2–4 repair them in order. Do not fix them here; `pnpm type-check` is expected to fail at the end of this task and passes again at Task 4.

- [ ] **Step 1: Add the new types**

In `config-contract.ts`, replace the `ProjectConfig` interface and `CONFIG_VERSION`:

```ts
/** Where a project entry came from. `cloned` is written by story 102. */
export type ProjectOrigin = 'local' | 'cloned';

export interface ProjectConfig {
  /** Stable, derived once from the directory basename. Sessions reference it. */
  id: string;
  /** Display name. Defaults to the resolved directory's basename. */
  name: string;
  /** The resolved, symlink-free absolute path — or `null` when unusable. */
  path: string | null;
  /** Phosphor icon name, as `Icon` spells them. */
  icon: string;
  origin: ProjectOrigin;
  status: ProjectStatus;
  /**
   * Whether the resolved directory is a git repository.
   *
   * Derived on load and **never written to the file** — like {@link status}.
   * Keeping it out of the config means a hand-edited file cannot lie about it,
   * and a directory that is `git init`-ed after being added reports correctly
   * on the next load.
   */
  isRepo: boolean;
}

/** The schema version this build writes. */
export const CONFIG_VERSION = 2;

/**
 * Versions the reader accepts.
 *
 * A v1 file is upgraded **in memory** and rewritten as v2 only when the user
 * first saves something. Reading someone's file and rewriting it before they
 * asked for anything is a surprise, not a migration.
 */
export const SUPPORTED_CONFIG_VERSIONS = [1, 2] as const;

/** What a project entry gets when the file names no icon. */
export const DEFAULT_PROJECT_ICON = 'ph-folder';

/** Payload of `config:add-project`. Re-validated in main; never trusted. */
export interface AddProjectRequest {
  /** A path the user chose. */
  path: string;
  /** Optional display name. Defaults to the directory basename. */
  name?: string;
}

/** Payload of `config:remove-project`. */
export interface RemoveProjectRequest {
  id: string;
}
```

- [ ] **Step 2: Verify the expected breakage is only where predicted**

Run: `cd app && pnpm type-check 2>&1 | grep -oE '(electron|src)/[^(]+' | sort -u`
Expected: errors only in `electron/main/config/parse.ts`, `electron/main/config/resolve.ts`, `electron/main/config/index.ts`. Any other file means something else consumes `ProjectConfig` and must be added to the plan.

- [ ] **Step 3: Commit**

```bash
git add app/electron/shared/config-contract.ts
git commit -m "feat(config): schema v2 contract types

CONFIG_VERSION becomes 2 and ProjectConfig gains name, icon, origin and a
derived isRepo. AddProjectRequest and RemoveProjectRequest join the contract.
parse/resolve/index are repaired in the next three commits.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `parse.ts` accepts v1 and v2

**Files:**
- Modify: `app/electron/main/config/parse.ts`
- Test: `app/tests/electron/main/config/parse.test.ts` (**new**)

**Interfaces:**
- Consumes: `SUPPORTED_CONFIG_VERSIONS`, `ProjectOrigin` (Task 1).
- Produces: `RawProject` gains optional `name`, `icon`, `origin`. `ParsedConfig` gains `version: number | null` and `fatal: boolean`.

**Why `fatal`:** `checkKeys` returns `false` only for a forbidden key — an *unknown* top-level key is pushed into `errors` and tolerated. So `errors.length > 0` cannot be the write path's refusal test, or a file with one unknown key (exactly what the spec says must be preserved) could never be written again. `fatal` marks only the four wholesale-rejection paths.

- [ ] **Step 1: Write the failing test**

Create `app/tests/electron/main/config/parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { parseConfig } from '@electron-main/config/parse';

describe('parseConfig — schema versions', () => {
  it('accepts version 1 and reports it', () => {
    const parsed = parseConfig(
      JSON.stringify({ version: 1, projects: [{ id: 'a', path: '~/a' }] }),
      'config',
    );
    expect(parsed.version).toBe(1);
    expect(parsed.fatal).toBe(false);
    expect(parsed.projects).toEqual([{ id: 'a', path: '~/a' }]);
  });

  it('accepts version 2 with the new entry fields', () => {
    const parsed = parseConfig(
      JSON.stringify({
        version: 2,
        projects: [
          { id: 'a', name: 'Alpha', path: '~/a', icon: 'ph-folder', origin: 'local' },
        ],
      }),
      'config',
    );
    expect(parsed.fatal).toBe(false);
    expect(parsed.projects[0]).toEqual({
      id: 'a',
      name: 'Alpha',
      path: '~/a',
      icon: 'ph-folder',
      origin: 'local',
    });
  });

  it('refuses an unsupported version and marks it fatal', () => {
    const parsed = parseConfig(JSON.stringify({ version: 3 }), 'config');
    expect(parsed.fatal).toBe(true);
    expect(parsed.errors[0]).toMatch(/unsupported version 3/);
  });

  it('marks malformed JSON and a forbidden key fatal', () => {
    expect(parseConfig('{oops', 'config').fatal).toBe(true);
    expect(parseConfig('{"__proto__":{}}', 'config').fatal).toBe(true);
  });

  it('tolerates an unknown top-level key without being fatal', () => {
    const parsed = parseConfig(
      JSON.stringify({ version: 2, future: 'x', projects: [] }),
      'config',
    );
    expect(parsed.fatal).toBe(false);
    expect(parsed.errors[0]).toMatch(/unknown key "future"/);
  });

  it('rejects an entry whose origin is not a known value', () => {
    const parsed = parseConfig(
      JSON.stringify({ version: 2, projects: [{ id: 'a', path: '~/a', origin: 'nope' }] }),
      'config',
    );
    expect(parsed.projects).toEqual([]);
    expect(parsed.errors.some((e) => /origin/.test(e))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd app && pnpm vitest run tests/electron/main/config/parse.test.ts`
Expected: FAIL — `parsed.version` and `parsed.fatal` are undefined.

If the `@electron-main` alias does not resolve, check `vite.aliases.mjs` for the alias that maps `electron/main` and use that name instead; do not add a new alias.

- [ ] **Step 3: Implement**

In `parse.ts`:

```ts
import {
  DEFAULT_PROJECT_ICON,
  SUPPORTED_CONFIG_VERSIONS,
  type ProjectOrigin,
} from '@shared/config-contract';
```

Extend the interfaces:

```ts
export interface RawProject {
  id: string;
  path: string;
  name?: string;
  icon?: string;
  origin?: ProjectOrigin;
}

export interface ParsedConfig {
  shell: string | null;
  claudeCommand: string | null;
  projects: RawProject[];
  errors: string[];
  /** The version the file declared, or `null` when it was unreadable. */
  version: number | null;
  /**
   * True when the reader rejected the file wholesale.
   *
   * Only the four paths that `return empty` set this. An unknown key or a bad
   * entry is advisory: the rest of the file still applies, and the write path
   * must not treat it as a reason to refuse.
   */
  fatal: boolean;
}
```

Add `const PROJECT_KEYS = ['id', 'path', 'name', 'icon', 'origin'];` (replacing the two-element version) and:

```ts
const ORIGINS: readonly string[] = ['local', 'cloned'];

function isOrigin(value: unknown): value is ProjectOrigin {
  return typeof value === 'string' && ORIGINS.includes(value);
}
```

In `parseConfig`, build `empty` as `{ shell: null, claudeCommand: null, projects: [], errors, version: null, fatal: true }`. Every existing `return empty` then reports fatal automatically. Replace the version check:

```ts
  const version = document.version;
  if (typeof version !== 'number' || !SUPPORTED_CONFIG_VERSIONS.includes(version as 1 | 2)) {
    errors.push(
      `${label}: unsupported version ${JSON.stringify(version)} — expected one of ${SUPPORTED_CONFIG_VERSIONS.join(', ')}`,
    );
    return empty;
  }
```

Every **non-fatal** return must now carry `version` and `fatal: false`. There are three such returns (`projects` undefined, `projects` not an array, and the final one) — update all three, e.g.:

```ts
  return { shell, claudeCommand, projects, errors, version, fatal: false };
```

Note `checkKeys(document, …)` returning `false` still `return empty`, which is now `fatal: true` — correct, that is the forbidden-key path.

In the entry loop, after the `path` check, read the three optional fields and `push`:

```ts
    let name: string | undefined;
    if (entry.name !== undefined) {
      if (typeof entry.name !== 'string' || entry.name.trim() === '') {
        errors.push(`${at}.name: expected a non-empty string`);
        return;
      }
      name = entry.name;
    }

    let icon: string | undefined;
    if (entry.icon !== undefined) {
      if (typeof entry.icon !== 'string' || entry.icon.trim() === '') {
        errors.push(`${at}.icon: expected a non-empty string`);
        return;
      }
      icon = entry.icon;
    }

    let origin: ProjectOrigin | undefined;
    if (entry.origin !== undefined) {
      if (!isOrigin(entry.origin)) {
        errors.push(`${at}.origin: expected "local" or "cloned"`);
        return;
      }
      origin = entry.origin;
    }

    projects.push({
      id,
      path: entry.path,
      ...(name !== undefined ? { name } : {}),
      ...(icon !== undefined ? { icon } : {}),
      ...(origin !== undefined ? { origin } : {}),
    });
```

The conditional spread matches the idiom `parseSpawnRequest` already uses — an `undefined`-valued own key is never created, so `checkKeys` on a later round trip does not see a key the user never wrote. `DEFAULT_PROJECT_ICON` is imported for Task 3's use; if lint flags it unused here, drop it from this file's imports.

- [ ] **Step 4: Run the tests**

Run: `cd app && pnpm vitest run tests/electron/main/config/parse.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add app/electron/main/config/parse.ts app/tests/electron/main/config/parse.test.ts
git commit -m "feat(config): parse accepts v1 and v2, reports fatal separately

PROJECT_KEYS grows to name/icon/origin. ParsedConfig gains version and a
fatal flag so the write path can tell wholesale rejection from an advisory
unknown-key error — the latter must not block a write, since preserving
unknown keys is the point.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `resolve.ts` — `isRepo`, `name`, `icon`, `origin`

**Files:**
- Modify: `app/electron/main/config/resolve.ts`
- Test: `app/tests/electron/main/config/resolve.test.ts` (**new**)

**Interfaces:**
- Consumes: `RawProject` (Task 2), `ProjectConfig`/`DEFAULT_PROJECT_ICON` (Task 1).
- Produces: `resolveProject(raw: RawProject): ProjectConfig` now returns all seven fields. `resolveProjects` signature unchanged.

- [ ] **Step 1: Write the failing test**

Create `app/tests/electron/main/config/resolve.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveProject } from '@electron-main/config/resolve';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hive-resolve-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveProject — isRepo', () => {
  it('is true when .git is a directory', () => {
    const dir = join(root, 'repo');
    mkdirSync(join(dir, '.git'), { recursive: true });
    expect(resolveProject({ id: 'repo', path: dir }).isRepo).toBe(true);
  });

  it('is true when .git is a file — the worktree and submodule case', () => {
    const dir = join(root, 'wt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    expect(resolveProject({ id: 'wt', path: dir }).isRepo).toBe(true);
  });

  it('is false for a plain directory', () => {
    const dir = join(root, 'plain');
    mkdirSync(dir, { recursive: true });
    expect(resolveProject({ id: 'plain', path: dir }).isRepo).toBe(false);
  });

  it('is false when the path never resolved', () => {
    const resolved = resolveProject({ id: 'gone', path: join(root, 'nope') });
    expect(resolved.status).toBe('missing');
    expect(resolved.isRepo).toBe(false);
  });
});

describe('resolveProject — v1 upgrade defaults', () => {
  it('defaults name to the resolved basename, icon and origin to constants', () => {
    const dir = join(root, 'my-project');
    mkdirSync(dir, { recursive: true });
    const resolved = resolveProject({ id: 'my-project', path: dir });
    expect(resolved.name).toBe('my-project');
    expect(resolved.icon).toBe('ph-folder');
    expect(resolved.origin).toBe('local');
  });

  it('prefers the declared name, icon and origin', () => {
    const dir = join(root, 'my-project');
    mkdirSync(dir, { recursive: true });
    const resolved = resolveProject({
      id: 'my-project',
      path: dir,
      name: 'My Project',
      icon: 'ph-globe-hemisphere-west',
      origin: 'cloned',
    });
    expect(resolved.name).toBe('My Project');
    expect(resolved.icon).toBe('ph-globe-hemisphere-west');
    expect(resolved.origin).toBe('cloned');
  });

  it('falls back to the id when the path is unusable and no name was given', () => {
    expect(resolveProject({ id: 'ghost', path: 'relative/x' }).name).toBe('ghost');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd app && pnpm vitest run tests/electron/main/config/resolve.test.ts`
Expected: FAIL — `isRepo`/`name`/`icon`/`origin` are undefined.

- [ ] **Step 3: Implement**

In `resolve.ts`, extend the imports:

```ts
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

import {
  DEFAULT_PROJECT_ICON,
  type ProjectConfig,
} from '@shared/config-contract';
```

Add above `resolveProject`:

```ts
/**
 * Whether a directory is a git repository.
 *
 * `existsSync`, not `statSync().isDirectory()`: inside a git **worktree** or a
 * submodule, `.git` is a *file* holding a `gitdir:` pointer, and a
 * directory-only check would report a perfectly real repository as not one.
 */
function looksLikeRepo(real: string): boolean {
  return existsSync(join(real, '.git'));
}

/** The fields every verdict carries, resolved or not. */
function decorate(raw: RawProject, real: string | null) {
  return {
    id: raw.id,
    name: raw.name ?? (real === null ? raw.id : basename(real)),
    icon: raw.icon ?? DEFAULT_PROJECT_ICON,
    origin: raw.origin ?? ('local' as const),
  };
}
```

Rewrite each `return` in `resolveProject` to spread `decorate`:

```ts
export function resolveProject(raw: RawProject): ProjectConfig {
  const expanded = expandHome(raw.path);

  if (!isAbsolute(expanded)) {
    return { ...decorate(raw, null), path: null, status: 'not-absolute', isRepo: false };
  }

  let real: string;
  try {
    real = realpathSync(expanded);
  } catch {
    return { ...decorate(raw, null), path: null, status: 'missing', isRepo: false };
  }

  try {
    if (!statSync(real).isDirectory()) {
      return { ...decorate(raw, null), path: null, status: 'not-a-directory', isRepo: false };
    }
  } catch {
    return { ...decorate(raw, null), path: null, status: 'missing', isRepo: false };
  }

  return { ...decorate(raw, real), path: real, status: 'ok', isRepo: looksLikeRepo(real) };
}
```

In `resolveProjects`, the duplicate-id branch also needs the new fields:

```ts
      return {
        ...decorate(raw, null),
        path: null,
        status: 'duplicate-id' as const,
        isRepo: false,
      };
```

- [ ] **Step 4: Run the tests**

Run: `cd app && pnpm vitest run tests/electron/main/config/resolve.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add app/electron/main/config/resolve.ts app/tests/electron/main/config/resolve.test.ts
git commit -m "feat(config): resolve derives isRepo, name, icon and origin

isRepo uses existsSync on .git rather than a directory check, so a git
worktree or submodule — where .git is a file holding a gitdir: pointer — is
correctly reported as a repository. name defaults to the resolved basename.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `config/index.ts` compiles again + v1 stays v1 on disk

**Files:**
- Modify: `app/electron/main/config/index.ts`
- Test: `app/tests/electron/main/config/index.test.ts` (extend)

**Interfaces:**
- Produces: `loadConfig` unchanged in signature; a v1 file loads with defaults applied in memory and is **not** rewritten.

- [ ] **Step 1: Write the failing test**

Append to `app/tests/electron/main/config/index.test.ts` (reuse the file's existing `writeConfig` helper at line 43 and its `HIVE_CONFIG_PATH` setup):

```ts
describe('schema v1 compatibility', () => {
  it('reads a v1 file, defaults the new fields, and leaves the file alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-v1-'));
    const projectDir = join(dir, 'legacy');
    mkdirSync(projectDir, { recursive: true });
    const path = join(dir, 'config.json');
    const original = `${JSON.stringify({ version: 1, projects: [{ id: 'legacy', path: projectDir }] }, null, 2)}\n`;
    writeFileSync(path, original);
    process.env.HIVE_CONFIG_PATH = path;

    const snapshot = reloadConfig();
    const entry = snapshot.projects[0];

    expect(entry.status).toBe('ok');
    expect(entry.name).toBe('legacy');
    expect(entry.icon).toBe('ph-folder');
    expect(entry.origin).toBe('local');
    // Reading must not rewrite. The upgrade is in memory until the user saves.
    expect(readFileSync(path, 'utf8')).toBe(original);

    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd app && pnpm vitest run tests/electron/main/config/index.test.ts`
Expected: FAIL if any type or default is wrong; the "file unchanged" assertion should already pass, since nothing writes on the read path.

- [ ] **Step 3: Implement**

`index.ts` needs no logic change — the defaults now come from `resolveProject`. Fix only what the compiler complains about (imports, if any). Confirm the whole tree compiles:

Run: `cd app && pnpm type-check`
Expected: PASS. Task 1's predicted breakage is now fully repaired.

- [ ] **Step 4: Run the full unit suite**

Run: `cd app && pnpm test`
Expected: PASS. If an existing `index.test.ts` case asserts a three-field `ProjectConfig` with `toEqual`, update it to the seven-field shape — that is the contract change, not a regression.

- [ ] **Step 5: Commit**

```bash
git add app/electron/main/config/index.ts app/tests/electron/main/config/index.test.ts
git commit -m "test(config): a v1 file loads with defaults and is not rewritten

Closes the schema-v2 read path. The upgrade is in memory only; the file on
disk stays v1 until the user saves something through the UI.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `identity.ts` — deriving a project id

**Files:**
- Create: `app/electron/main/config/identity.ts`
- Test: `app/tests/electron/main/config/identity.test.ts` (**new**)

**Interfaces:**
- Produces: `deriveProjectId(directoryName: string, taken: ReadonlySet<string>): string`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

import { deriveProjectId } from '@electron-main/config/identity';

const none = new Set<string>();

describe('deriveProjectId', () => {
  it('kebab-cases the directory name', () => {
    expect(deriveProjectId('My Project', none)).toBe('my-project');
    expect(deriveProjectId('The_Hive', none)).toBe('the-hive');
    expect(deriveProjectId('apfm.web', none)).toBe('apfm-web');
  });

  it('strips characters outside [a-z0-9-] and collapses runs', () => {
    expect(deriveProjectId('a  b//c', none)).toBe('a-b-c');
    expect(deriveProjectId('--lead--', none)).toBe('lead');
    expect(deriveProjectId('Ünïcødé', none)).toBe('nicd');
  });

  it('truncates to 40 characters', () => {
    expect(deriveProjectId('x'.repeat(60), none)).toHaveLength(40);
  });

  it('suffixes a collision with -2, then -3', () => {
    expect(deriveProjectId('repo', new Set(['repo']))).toBe('repo-2');
    expect(deriveProjectId('repo', new Set(['repo', 'repo-2']))).toBe('repo-3');
  });

  it('falls back when nothing survives sanitising', () => {
    expect(deriveProjectId('///', none)).toBe('project');
    expect(deriveProjectId('///', new Set(['project']))).toBe('project-2');
  });

  it('keeps a truncated id within 40 characters after suffixing', () => {
    const id = deriveProjectId('y'.repeat(60), new Set(['y'.repeat(40)]));
    expect(id.length).toBeLessThanOrEqual(40);
    expect(id.endsWith('-2')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd app && pnpm vitest run tests/electron/main/config/identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `app/electron/main/config/identity.ts`:

```ts
/**
 * Deriving a project's stable id (story 101).
 *
 * The id is machinery, not a label: sessions reference projects through
 * `entity.project`, so an id that drifted when a folder was renamed would
 * strand every session that named it. It is derived **once**, at add time, and
 * never recomputed. The display `name` is the editable one (story 103).
 */

const MAX_LENGTH = 40;

/** Used when sanitising leaves nothing — an unnamed id is worse than a dull one. */
const FALLBACK = 'project';

function kebab(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned === '' ? FALLBACK : cleaned.slice(0, MAX_LENGTH).replace(/-$/, '');
}

/**
 * A unique id for a directory basename.
 *
 * A collision takes a `-2`, `-3` suffix. The base is trimmed first when needed
 * so the suffixed id still fits `MAX_LENGTH` — an id that silently exceeded its
 * own bound would be a bug the first time someone added two long paths.
 */
export function deriveProjectId(
  directoryName: string,
  taken: ReadonlySet<string>,
): string {
  const base = kebab(directoryName);
  if (!taken.has(base)) return base;

  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const trimmed = base.slice(0, MAX_LENGTH - suffix.length).replace(/-$/, '');
    const candidate = `${trimmed}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd app && pnpm vitest run tests/electron/main/config/identity.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add app/electron/main/config/identity.ts app/tests/electron/main/config/identity.test.ts
git commit -m "feat(config): derive stable project ids from directory names

Kebab-cased, [a-z0-9-] only, 40 characters, -2/-3 on collision, and never
recomputed — sessions reference projects by id, so a drifting id would
strand them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `write.ts` — the atomic, comment-preserving write path

**Files:**
- Create: `app/electron/main/config/write.ts`
- Test: `app/tests/electron/main/config/write.test.ts` (**new**)

**Interfaces:**
- Consumes: `parseConfig` + `ParsedConfig.fatal` (Task 2), `resolveProjects` (Task 3), `configPath()` from `config/index.ts`.
- Produces: `type ConfigDocument = Record<string, unknown>`, `type Mutation = (draft: ConfigDocument) => ConfigDocument`, `writeConfig(mutate: Mutation): ConfigSnapshot`.

**Import direction:** `write.ts` imports `configPath` from `./index`, and Task 7 has `index.ts` import `writeConfig` from `./write`. That is a cycle. Avoid it by moving `configPath` into write.ts's reach: in this task, **extract `configPath` and `describe` into `app/electron/main/config/paths.ts`** and have `index.ts` re-export `configPath` so existing importers are untouched.

- [ ] **Step 1: Extract `paths.ts` first**

Create `app/electron/main/config/paths.ts` with the exact bodies of `configPath()` and `describe()` moved verbatim from `index.ts` (including their doc comments), importing `CONFIG_PATH_ENV`, `homedir`, `join`. In `index.ts`, delete both and add:

```ts
import { configPath, describe } from './paths';

export { configPath };
```

Run: `cd app && pnpm test && pnpm type-check`
Expected: PASS — pure move, no behaviour change.

- [ ] **Step 2: Write the failing test**

Create `app/tests/electron/main/config/write.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseConfig } from '@electron-main/config/parse';
import { writeConfig } from '@electron-main/config/write';

let dir: string;
let path: string;
let projectDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-write-'));
  path = join(dir, 'config.json');
  projectDir = join(dir, 'repo');
  mkdirSync(projectDir, { recursive: true });
  process.env.HIVE_CONFIG_PATH = path;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HIVE_CONFIG_PATH;
});

const seed = (doc: unknown): string => {
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  writeFileSync(path, text);
  return text;
};

describe('writeConfig', () => {
  it('round-trips: what it writes, parseConfig reads back identically', () => {
    seed({ version: 2, projects: [] });

    const snapshot = writeConfig((draft) => ({
      ...draft,
      projects: [{ id: 'repo', name: 'Repo', path: projectDir, icon: 'ph-folder', origin: 'local' }],
    }));

    expect(snapshot.errors).toEqual([]);
    const parsed = parseConfig(readFileSync(path, 'utf8'), 'config');
    expect(parsed.fatal).toBe(false);
    expect(parsed.projects[0].id).toBe('repo');
    expect(snapshot.projects[0].status).toBe('ok');
  });

  it('preserves "//" comment keys and unknown top-level keys', () => {
    seed({
      '//': 'this file documents itself',
      version: 2,
      '//projects': 'one entry per repository',
      projects: [],
      future: { untouched: true },
    });

    writeConfig((draft) => ({ ...draft, projects: [] }));

    const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(after['//']).toBe('this file documents itself');
    expect(after['//projects']).toBe('one entry per repository');
    expect(after.future).toEqual({ untouched: true });
    expect(Object.keys(after)).toEqual(['//', 'version', '//projects', 'projects', 'future']);
  });

  it('writes version 2, upgrading a v1 file on first save', () => {
    seed({ version: 1, projects: [] });
    writeConfig((draft) => ({ ...draft, projects: [] }));
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(2);
  });

  it('refuses a mutation whose result the reader would reject, leaving the file byte-identical', () => {
    const before = seed({ version: 2, projects: [] });

    const snapshot = writeConfig((draft) => ({ ...draft, version: 99 }));

    expect(snapshot.errors.some((e) => /unsupported version/.test(e))).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('refuses to write when the file on disk is already unreadable', () => {
    writeFileSync(path, '{ not json');
    const snapshot = writeConfig((draft) => ({ ...draft, projects: [] }));
    expect(snapshot.errors.some((e) => /not valid JSON/.test(e))).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
  });

  it('leaves no temp file behind', () => {
    seed({ version: 2, projects: [] });
    writeConfig((draft) => ({ ...draft, projects: [] }));
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('re-reads from disk: an out-of-band edit is not clobbered', () => {
    seed({ version: 2, shell: '/bin/zsh', projects: [] });
    // Simulate the user editing the file in a text editor after load.
    seed({ version: 2, shell: '/bin/fish', projects: [] });

    writeConfig((draft) => ({ ...draft, projects: [] }));

    expect(JSON.parse(readFileSync(path, 'utf8')).shell).toBe('/bin/fish');
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `cd app && pnpm vitest run tests/electron/main/config/write.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `app/electron/main/config/write.ts`:

```ts
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  CONFIG_VERSION,
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_SHELL,
  emptySnapshot,
  type ConfigSnapshot,
} from '@shared/config-contract';

import { parseConfig } from './parse';
import { configPath, describe } from './paths';
import { resolveProjects } from './resolve';

/**
 * The single write path for the workspace config (story 101).
 *
 * Every mutation goes through here; there is no per-field patch. The ordering
 * is the whole design:
 *
 * 1. **Re-read from disk**, never the cached snapshot — the user may have
 *    edited the file in an editor since the app loaded, and writing the cache
 *    back would silently discard that.
 * 2. **Apply the mutation in memory.**
 * 3. **Validate the whole result with the read path's own parser.** Two
 *    validators is one validator and one bug. A write that would produce a file
 *    the reader rejects is refused *before* anything touches disk.
 * 4. **Write atomically** — temp file in the same directory, then `rename`. A
 *    half-written config is the one failure that makes the app unlaunchable,
 *    and `rename` is the only cheap way to make it impossible. Same directory
 *    because `rename` is only atomic within a filesystem.
 * 5. **Return the fresh snapshot**, so the renderer never follows a write with
 *    a reload.
 *
 * Nothing here throws at the user's data. On any failure the old file is still
 * on disk, still valid, and the reason comes back in `errors`.
 */

const LABEL = 'config';

/** The parsed config document, comments and unknown keys included. */
export type ConfigDocument = Record<string, unknown>;

export type Mutation = (draft: ConfigDocument) => ConfigDocument;

function failed(path: string, message: string): ConfigSnapshot {
  const snapshot = emptySnapshot(path);
  snapshot.errors.push(message);
  return snapshot;
}

export function writeConfig(mutate: Mutation): ConfigSnapshot {
  const path = configPath();

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    // Includes ENOENT. A config that is not there cannot be safely rewritten
    // from a mutation whose base we never saw; the caller reloads and retries.
    return failed(path, `${LABEL}: could not read ${path} (${describe(cause)}) — nothing was written`);
  }

  const current = parseConfig(text, LABEL);
  if (current.fatal) {
    // The file on disk is one this build does not understand. Rewriting it
    // would destroy content we could not read.
    return failed(
      path,
      `${LABEL}: ${path} could not be read (${current.errors[0] ?? 'unknown reason'}) — nothing was written`,
    );
  }

  let document: ConfigDocument;
  try {
    document = JSON.parse(text) as ConfigDocument;
  } catch (cause) {
    return failed(path, `${LABEL}: could not parse ${path} (${describe(cause)}) — nothing was written`);
  }

  // The version we emit is always current: a v1 file becomes v2 on the first
  // save, which is the only moment a migration is not a surprise.
  const next = { ...mutate(document), version: CONFIG_VERSION };

  // Key order survives because JSON.stringify walks own string keys in
  // insertion order, and the spread above preserves the order of the parsed
  // document — comments and unknown keys included. New keys land at the end.
  const serialised = `${JSON.stringify(next, null, 2)}\n`;

  const validated = parseConfig(serialised, LABEL);
  if (validated.fatal) {
    return failed(
      path,
      `${LABEL}: refusing to write a file this build could not read back (${validated.errors[0] ?? 'unknown reason'})`,
    );
  }

  const temp = join(dirname(path), `config.json.${process.pid}.tmp`);
  try {
    writeFileSync(temp, serialised, 'utf8');
    renameSync(temp, path);
  } catch (cause) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may not exist if writeFileSync was what failed. Nothing
      // to clean up, and reporting a cleanup failure would bury the real cause.
    }
    return failed(path, `${LABEL}: could not write ${path} (${describe(cause)}) — the previous config is unchanged`);
  }

  const projects = resolveProjects(validated.projects, validated.errors);

  return {
    configPath: path,
    templateWritten: false,
    shell: validated.shell ?? DEFAULT_SHELL,
    claudeCommand: validated.claudeCommand ?? DEFAULT_CLAUDE_COMMAND,
    projects,
    errors: validated.errors,
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `cd app && pnpm vitest run tests/electron/main/config/write.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add app/electron/main/config/write.ts app/electron/main/config/paths.ts app/electron/main/config/index.ts app/tests/electron/main/config/write.test.ts
git commit -m "feat(config): writeConfig — atomic, comment-preserving, one write path

Re-reads from disk so an out-of-band edit is never clobbered, validates the
result with the read path's own parser, writes to a temp file in the same
directory and renames over the target. Comment keys and unknown top-level
keys survive because the parsed document is spread, not rebuilt.

configPath and describe move to paths.ts to keep write.ts and index.ts from
importing each other.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `addProject` and `removeProject`

**Files:**
- Modify: `app/electron/main/config/index.ts`
- Test: `app/tests/electron/main/config/index.test.ts` (extend)

**Interfaces:**
- Consumes: `writeConfig` (Task 6), `deriveProjectId` (Task 5), `resolveProject` (Task 3), `AddProjectRequest`/`RemoveProjectRequest` (Task 1).
- Produces: `addProject(request: AddProjectRequest): ConfigSnapshot`, `removeProject(request: RemoveProjectRequest): ConfigSnapshot`. Both refresh the module cache.

- [ ] **Step 1: Write the failing test**

Append to `app/tests/electron/main/config/index.test.ts`:

```ts
describe('addProject', () => {
  it('adds a directory, deriving id and name from the basename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-add-'));
    const repo = join(dir, 'my-repo');
    mkdirSync(repo, { recursive: true });
    const path = join(dir, 'config.json');
    writeFileSync(path, `${JSON.stringify({ version: 2, projects: [] }, null, 2)}\n`);
    process.env.HIVE_CONFIG_PATH = path;
    reloadConfig();

    const snapshot = addProject({ path: repo });

    expect(snapshot.errors).toEqual([]);
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0].id).toBe('my-repo');
    expect(snapshot.projects[0].name).toBe('my-repo');
    expect(snapshot.projects[0].status).toBe('ok');
    // The cache is refreshed, so main and renderer cannot disagree.
    expect(getConfig().projects).toHaveLength(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a relative path, a file, and a missing directory without writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-add-bad-'));
    const file = join(dir, 'notes.txt');
    writeFileSync(file, 'not a directory');
    const path = join(dir, 'config.json');
    writeFileSync(path, `${JSON.stringify({ version: 2, projects: [] }, null, 2)}\n`);
    process.env.HIVE_CONFIG_PATH = path;
    reloadConfig();

    expect(addProject({ path: 'relative/path' }).errors[0]).toMatch(/not-absolute/);
    expect(addProject({ path: file }).errors[0]).toMatch(/not-a-directory/);
    expect(addProject({ path: join(dir, 'nope') }).errors[0]).toMatch(/missing/);

    expect(getConfig().projects).toHaveLength(0);
    expect(JSON.parse(readFileSync(path, 'utf8')).projects).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
  });

  it('expands ~ in an added path', () => {
    const home = mkdtempSync(join(tmpdir(), 'hive-home-'));
    const repo = join(home, 'tilde-repo');
    mkdirSync(repo, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    const path = join(home, 'config.json');
    writeFileSync(path, `${JSON.stringify({ version: 2, projects: [] }, null, 2)}\n`);
    process.env.HIVE_CONFIG_PATH = path;
    reloadConfig();

    const snapshot = addProject({ path: '~/tilde-repo' });

    expect(snapshot.projects[0].status).toBe('ok');
    // Stored as the user wrote it; resolved only for identity and duplicates.
    expect(JSON.parse(readFileSync(path, 'utf8')).projects[0].path).toBe('~/tilde-repo');

    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it('is a no-op when the resolved path is already added', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-dupe-'));
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    const path = join(dir, 'config.json');
    writeFileSync(path, `${JSON.stringify({ version: 2, projects: [] }, null, 2)}\n`);
    process.env.HIVE_CONFIG_PATH = path;
    reloadConfig();

    addProject({ path: repo });
    const second = addProject({ path: repo });

    expect(second.projects).toHaveLength(1);
    expect(second.errors.some((e) => /already added/.test(e))).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it('suffixes a colliding id derived from the same basename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-collide-'));
    const first = join(dir, 'one', 'api');
    const second = join(dir, 'two', 'api');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    const path = join(dir, 'config.json');
    writeFileSync(path, `${JSON.stringify({ version: 2, projects: [] }, null, 2)}\n`);
    process.env.HIVE_CONFIG_PATH = path;
    reloadConfig();

    addProject({ path: first });
    const snapshot = addProject({ path: second });

    expect(snapshot.projects.map((p) => p.id)).toEqual(['api', 'api-2']);

    rmSync(dir, { recursive: true, force: true });
  });

  it('honours an explicit name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-named-'));
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    const path = join(dir, 'config.json');
    writeFileSync(path, `${JSON.stringify({ version: 2, projects: [] }, null, 2)}\n`);
    process.env.HIVE_CONFIG_PATH = path;
    reloadConfig();

    expect(addProject({ path: repo, name: 'My Repo' }).projects[0].name).toBe('My Repo');
    expect(addProject({ path: repo, name: 'My Repo' }).projects[0].id).toBe('repo');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('removeProject', () => {
  it('drops exactly one entry and leaves every other line intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-remove-'));
    const keep = join(dir, 'keep');
    const drop = join(dir, 'drop');
    mkdirSync(keep, { recursive: true });
    mkdirSync(drop, { recursive: true });
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          '//': 'kept',
          version: 2,
          projects: [
            { id: 'keep', name: 'Keep', path: keep, icon: 'ph-folder', origin: 'local' },
            { id: 'drop', name: 'Drop', path: drop, icon: 'ph-folder', origin: 'local' },
          ],
        },
        null,
        2,
      )}\n`,
    );
    process.env.HIVE_CONFIG_PATH = path;
    reloadConfig();

    const snapshot = removeProject({ id: 'drop' });

    expect(snapshot.errors).toEqual([]);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after['//']).toBe('kept');
    expect(after.projects.map((p: { id: string }) => p.id)).toEqual(['keep']);

    rmSync(dir, { recursive: true, force: true });
  });

  it('reports an unknown id without writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-ghost-'));
    const path = join(dir, 'config.json');
    const before = `${JSON.stringify({ version: 2, projects: [] }, null, 2)}\n`;
    writeFileSync(path, before);
    process.env.HIVE_CONFIG_PATH = path;
    reloadConfig();

    const snapshot = removeProject({ id: 'ghost' });

    expect(snapshot.errors.some((e) => /no project with id "ghost"/.test(e))).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(before);

    rmSync(dir, { recursive: true, force: true });
  });
});
```

Add `import * as os from 'node:os';` and `vi` to the file's imports for the tilde case; the rest reuse imports the file already has.

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd app && pnpm vitest run tests/electron/main/config/index.test.ts`
Expected: FAIL — `addProject` / `removeProject` are not exported.

- [ ] **Step 3: Implement**

In `config/index.ts`:

```ts
import { basename } from 'node:path';

import type {
  AddProjectRequest,
  RemoveProjectRequest,
} from '@shared/config-contract';

import { deriveProjectId } from './identity';
import { resolveProject } from './resolve';
import { writeConfig, type ConfigDocument } from './write';

/** Read the `projects` array off a raw document, tolerating a missing one. */
function projectsOf(document: ConfigDocument): Record<string, unknown>[] {
  const raw = document.projects;
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
}

/**
 * Add a local directory (story 101).
 *
 * The incoming path re-runs the **entire** story 090 resolution — expand `~`,
 * require absolute, `realpath`, require a directory. The native dialog is a UX
 * step, not a capability grant: a renderer that skipped the dialog and posted a
 * path directly gets exactly the same treatment, because main's validation is
 * the actual gate.
 */
export function addProject(request: AddProjectRequest): ConfigSnapshot {
  const probe = resolveProject({ id: 'probe', path: request.path });
  if (probe.status !== 'ok' || probe.path === null) {
    const snapshot = { ...getConfig() };
    snapshot.errors = [
      `config: cannot add ${request.path} (${probe.status})`,
    ];
    return snapshot;
  }
  const real = probe.path;

  const existing = getConfig().projects.find((entry) => entry.path === real);
  if (existing) {
    const snapshot = { ...getConfig() };
    snapshot.errors = [`config: ${real} is already added as "${existing.id}"`];
    return snapshot;
  }

  const taken = new Set(getConfig().projects.map((entry) => entry.id));
  const id = deriveProjectId(basename(real), taken);

  const next = writeConfig((draft) => ({
    ...draft,
    projects: [
      ...projectsOf(draft),
      {
        id,
        name: request.name ?? basename(real),
        path: request.path,
        icon: DEFAULT_PROJECT_ICON,
        origin: 'local',
      },
    ],
  }));

  cached = next;
  return next;
}

/**
 * Remove one entry by id.
 *
 * Whether removal is *allowed* — a project owning live sessions — is the
 * renderer's gate for this story; story 103 owns the confirmation flow.
 */
export function removeProject(request: RemoveProjectRequest): ConfigSnapshot {
  const present = getConfig().projects.some((entry) => entry.id === request.id);
  if (!present) {
    const snapshot = { ...getConfig() };
    snapshot.errors = [`config: no project with id "${request.id}"`];
    return snapshot;
  }

  const next = writeConfig((draft) => ({
    ...draft,
    projects: projectsOf(draft).filter((entry) => entry.id !== request.id),
  }));

  cached = next;
  return next;
}
```

Import `DEFAULT_PROJECT_ICON` from `@shared/config-contract`. Note `path: request.path` is stored **as the user wrote it** (tilde and all), matching the schema comment "as written by the user or the dialog"; `real` is only used for identity and duplicate detection.

- [ ] **Step 4: Run the tests**

Run: `cd app && pnpm vitest run tests/electron/main/config/index.test.ts && pnpm type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/electron/main/config/index.ts app/tests/electron/main/config/index.test.ts
git commit -m "feat(config): addProject and removeProject on top of writeConfig

addProject re-runs the whole 090 resolution on the incoming path before it is
written — the dialog is a UX step, not a capability grant. Both refresh the
module cache so main and the renderer cannot disagree about what was written.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Payload guards

**Files:**
- Modify: `app/electron/shared/guards.ts`
- Test: `app/tests/electron/shared/guards.test.ts` (extend)

**Interfaces:**
- Produces: `parseAddProjectRequest(input: unknown): AddProjectRequest`, `parseRemoveProjectRequest(input: unknown): RemoveProjectRequest`.

- [ ] **Step 1: Write the failing test**

```ts
describe('parseAddProjectRequest', () => {
  it('accepts a path alone and a path with a name', () => {
    expect(parseAddProjectRequest({ path: '/tmp/x' })).toEqual({ path: '/tmp/x' });
    expect(parseAddProjectRequest({ path: '/tmp/x', name: 'X' })).toEqual({
      path: '/tmp/x',
      name: 'X',
    });
  });

  it('rejects __proto__', () => {
    expect(() =>
      parseAddProjectRequest(JSON.parse('{"path":"/tmp/x","__proto__":{}}')),
    ).toThrow(/forbidden key/);
  });

  it('rejects a non-string path, a missing path, and an unexpected key', () => {
    expect(() => parseAddProjectRequest({ path: 7 })).toThrow(/expected a string/);
    expect(() => parseAddProjectRequest({})).toThrow(/missing key "path"/);
    expect(() => parseAddProjectRequest({ path: '/x', nope: 1 })).toThrow(/unexpected key/);
  });

  it('rejects an empty path', () => {
    expect(() => parseAddProjectRequest({ path: '   ' })).toThrow(/non-empty/);
  });
});

describe('parseRemoveProjectRequest', () => {
  it('accepts an id and rejects a malformed one', () => {
    expect(parseRemoveProjectRequest({ id: 'the-hive' })).toEqual({ id: 'the-hive' });
    expect(() => parseRemoveProjectRequest({ id: '../etc' })).toThrow(/malformed id/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd app && pnpm vitest run tests/electron/shared/guards.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

Append to `guards.ts`, after the PTY guards:

```ts
/**
 * A filesystem path arriving from the renderer (story 101).
 *
 * Shape only. Whether the path is absolute, exists, or is a directory is
 * **main's** job and is re-checked there from scratch — this guard's contract
 * is that what reaches `addProject` is a non-empty string, not that it is safe.
 */
function assertPath(value: unknown, label: string): string {
  const path = assertString(value, label);
  if (path.trim() === '') return fail(`${label}: expected a non-empty string`);
  return path;
}

export function parseAddProjectRequest(input: unknown): AddProjectRequest {
  const raw = assertShape(input, ['path'], 'addProject', ['name']);
  const name = raw.name === undefined ? undefined : assertPath(raw.name, 'addProject.name');
  return {
    path: assertPath(raw.path, 'addProject.path'),
    ...(name !== undefined ? { name } : {}),
  };
}

export function parseRemoveProjectRequest(input: unknown): RemoveProjectRequest {
  const raw = assertShape(input, ['id'], 'removeProject');
  return { id: assertId(raw.id, 'removeProject.id') };
}
```

Import the two request types from `./config-contract`. `assertShape` supplies `__proto__` rejection and unknown-key rejection for free — do not re-implement either.

- [ ] **Step 4: Run the tests**

Run: `cd app && pnpm vitest run tests/electron/shared/guards.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/electron/shared/guards.ts app/tests/electron/shared/guards.test.ts
git commit -m "feat(ipc): guards for the two config mutation payloads

Built on assertShape, which supplies __proto__ and unknown-key rejection.
Shape only — whether the path is absolute or a directory is re-checked in
main from scratch.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Three channels — contract, main handlers, preload

**Files:**
- Modify: `app/electron/shared/ipc-contract.ts`, `app/electron/main/ipc/index.ts`, `app/electron/preload/index.ts`
- Test: `app/tests/electron/preload/bridge.test.ts`, `app/tests/e2e/electron/security.spec.ts` (both update)

**Interfaces:**
- Produces: `CH.configChooseDirectory` / `CH.configAddProject` / `CH.configRemoveProject`; `HiveBridge.config` gains `chooseDirectory`, `addProject`, `removeProject`; `BRIDGE_CONFIG_KEYS` becomes five entries.

- [ ] **Step 1: Update the two surface tests first — the alarm is the test working**

In `bridge.test.ts`, replace the line asserting `not.toContain('set')` (it and its comment are now false) with a check that the mutating verbs route to their channels, following the file's existing routing idiom. In `security.spec.ts:106-108`, replace the hard-coded array and rewrite its comment in the idiom the file already uses for `onLost` and `restart`:

```ts
  // Story 101 makes the config writable. The widening is deliberate and
  // bounded: main re-validates every path from scratch, and no verb accepts a
  // destination — the bridge can write to exactly one file.
  expect(surface.config).toEqual([
    'addProject',
    'chooseDirectory',
    'get',
    'reload',
    'removeProject',
  ]);
```

- [ ] **Step 2: Run to confirm both fail**

Run: `cd app && pnpm vitest run tests/electron/preload/bridge.test.ts`
Expected: FAIL. (`security.spec.ts` runs under Playwright in Task 15.)

- [ ] **Step 3: Implement the contract**

In `ipc-contract.ts`, add to `CH` next to the existing config entries:

```ts
  configChooseDirectory: 'config:choose-directory',
  configAddProject: 'config:add-project',
  configRemoveProject: 'config:remove-project',
```

Rewrite the `HiveBridge.config` doc comment — **rewritten, not deleted**; the old reasoning was correct and the condition changed — and extend the type:

```ts
  /**
   * The workspace config (stories 090, 101).
   *
   * No longer read-only. Story 090's comment here said there was no `set`
   * "because a settings UI that writes this file is out of scope"; story 101
   * is that settings UI, so the reasoning stands and the condition changed.
   *
   * What bounds the widening: the bridge can write to **exactly one file**, no
   * verb accepts a destination path, and every path arriving from the renderer
   * is re-validated in main from scratch — expanded, made absolute,
   * `realpath`'d, confirmed to be a directory — exactly as a path arriving
   * from the file is. `chooseDirectory` is a UX step, not a capability grant.
   *
   * Every mutating verb returns the fresh snapshot, so the renderer never
   * follows a write with a reload and can never render a stale list.
   */
  config: {
    get(): Promise<ConfigSnapshot>;
    reload(): Promise<ConfigSnapshot>;
    /** Native directory dialog, owned by main. Resolves null when cancelled. */
    chooseDirectory(): Promise<string | null>;
    addProject(request: AddProjectRequest): Promise<ConfigSnapshot>;
    removeProject(request: RemoveProjectRequest): Promise<ConfigSnapshot>;
  };
```

Import both request types type-only from `./config-contract`, and update:

```ts
export const BRIDGE_CONFIG_KEYS = [
  'get',
  'reload',
  'chooseDirectory',
  'addProject',
  'removeProject',
] as const;
```

- [ ] **Step 4: Implement the main handlers**

In `main/ipc/index.ts`, add `dialog` to the `electron` import and extend the config block:

```ts
  /**
   * Config mutation (story 101).
   *
   * `chooseDirectory` takes no payload, so — like `get` and `reload` — the
   * sender check `handle` applies is its whole validation. The other two carry
   * a payload and are guarded before they reach main's own re-validation.
   */
  handle(CH.configChooseDirectory, async (event): Promise<string | null> => {
    // The parent window is resolved from the event rather than captured: there
    // is no mainWindow singleton, and on macOS the window can be closed and
    // re-created, so a held reference goes stale. `assertSender` has already
    // proven this sender is the main frame.
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return null;

    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  handle(CH.configAddProject, (_event, payload): ConfigSnapshot =>
    addProject(parseAddProjectRequest(payload)),
  );

  handle(CH.configRemoveProject, (_event, payload): ConfigSnapshot =>
    removeProject(parseRemoveProjectRequest(payload)),
  );
```

- [ ] **Step 5: Implement the preload**

In `preload/index.ts`, extend the `config` object:

```ts
  config: {
    get: (): Promise<ConfigSnapshot> => ipcRenderer.invoke(CH.configGet),
    reload: (): Promise<ConfigSnapshot> => ipcRenderer.invoke(CH.configReload),
    chooseDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke(CH.configChooseDirectory),
    addProject: (request: AddProjectRequest): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configAddProject, request),
    removeProject: (request: RemoveProjectRequest): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configRemoveProject, request),
  },
```

All three use `invoke` — every one needs a result.

- [ ] **Step 6: Run the tests**

Run: `cd app && pnpm vitest run tests/electron/preload/bridge.test.ts && pnpm type-check && pnpm lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/electron/shared/ipc-contract.ts app/electron/main/ipc/index.ts app/electron/preload/index.ts app/tests/electron/preload/bridge.test.ts app/tests/e2e/electron/security.spec.ts
git commit -m "feat(ipc): three config mutation channels

chooseDirectory resolves its parent window via fromWebContents rather than a
singleton, which does not exist — main resolves windows per call because on
macOS the window can be closed and re-created.

The HiveBridge.config doc comment is rewritten rather than deleted: 090's
reasoning was correct and the condition changed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: The fifth view state

**Files:**
- Modify: `app/src/lib/resolve-view.ts`
- Test: `app/tests/lib/resolve-view.test.ts` (extend)

**Interfaces:**
- Produces: `ViewState` gains `'settings'`; `ViewInput` gains `settings: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
it('settings wins over every other state, including the picker', () => {
  expect(
    resolveView({ activeTab: 'orch', picker: true, settings: true, entity: null }),
  ).toBe('settings');
  expect(
    resolveView({ activeTab: 's1', picker: false, settings: true, entity: session }),
  ).toBe('settings');
});

it('is not an entity view', () => {
  expect(isEntityView('settings')).toBe(false);
});
```

Update every existing call in the file to pass `settings: false`.

- [ ] **Step 2: Run it**

Run: `cd app && pnpm vitest run tests/lib/resolve-view.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
export type ViewState = 'settings' | 'picker' | 'orchestrator' | 'session' | 'agent';
```

Add `settings: boolean;` to `ViewInput` with the doc `/** Whether the settings overlay is open. */`, add a new rule **1** to the precedence comment (renumbering the existing two to 2 and 3):

```
 * 1. **Settings wins over the picker.** The realistic route into settings *is*
 *    the picker discovering it has no projects to offer, and two stacked
 *    overlays is the result of not deciding this. Like the picker, it
 *    deliberately does not change `activeTab`.
```

and:

```ts
export function resolveView({ activeTab, picker, settings, entity }: ViewInput): ViewState {
  if (settings) return 'settings';
  if (picker) return 'picker';
  if (activeTab === ORCH_TAB) return 'orchestrator';
  if (!entity) return 'orchestrator';

  return entity.kind === 'agent' ? 'agent' : 'session';
}
```

`isEntityView` needs no change — `'settings'` falls through correctly.

- [ ] **Step 4: Run the tests**

Run: `cd app && pnpm vitest run tests/lib/resolve-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/resolve-view.ts app/tests/lib/resolve-view.test.ts
git commit -m "feat(settings): the fifth view state

Settings wins over the picker: the realistic route in is the picker
discovering it has nothing to offer.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: `ui-store` — the settings flag

**Files:**
- Modify: `app/src/stores/ui-store.ts`
- Test: `app/tests/stores/ui-store.test.ts` (extend)

**Interfaces:**
- Produces: `settings: boolean`, `openSettings()`, `closeSettings()`, `useSettingsOpen()`, `useSettingsActions()`.

- [ ] **Step 1: Write the failing test**

```ts
it('openSettings clears the picker and leaves activeTab untouched', () => {
  const store = useUiStore.getState();
  store.openTab('s1');
  store.openPicker();
  useUiStore.getState().openSettings();

  const state = useUiStore.getState();
  expect(state.settings).toBe(true);
  expect(state.picker).toBe(false);
  expect(state.activeTab).toBe('s1');
});

it('closeSettings changes nothing else — nothing was changed on open', () => {
  useUiStore.getState().openTab('s1');
  useUiStore.getState().openSettings();
  useUiStore.getState().closeSettings();

  expect(useUiStore.getState().settings).toBe(false);
  expect(useUiStore.getState().activeTab).toBe('s1');
});

it('reset clears the settings flag', () => {
  useUiStore.getState().openSettings();
  useUiStore.getState().reset();
  expect(useUiStore.getState().settings).toBe(false);
});
```

- [ ] **Step 2: Run it**

Expected: FAIL — `openSettings` is not a function.

- [ ] **Step 3: Implement**

Add `settings: boolean; // full-stage settings overlay open` to the state block next to `picker`, declare `openSettings: () => void;` and `closeSettings: () => void;` in the actions block, add `settings: false,` to **`initialUiState`** (which `reset()` reuses — omitting it is the bug this task's third test catches), and implement:

```ts
  /**
   * Open settings, dismissing the picker.
   *
   * The realistic route here is the picker discovering it has no projects to
   * offer; leaving it open would stack two full-stage overlays. Like the
   * picker, this never touches `activeTab` — closing settings has to return
   * the user to the terminal they were watching.
   */
  openSettings: () => set({ settings: true, picker: false }),
  closeSettings: () => set({ settings: false }),
```

Add the selectors next to the picker's, following the same idiom:

```ts
const settingsActionsSelector = (state: UiState) => ({
  openSettings: state.openSettings,
  closeSettings: state.closeSettings,
});

/** Whether the settings overlay is open. */
export const useSettingsOpen = () => useUiStore((state) => state.settings);

/** Settings actions, referentially stable across unrelated state changes. */
export const useSettingsActions = () =>
  useUiStore(useShallow(settingsActionsSelector));
```

- [ ] **Step 4: Run the tests**

Run: `cd app && pnpm vitest run tests/stores/ui-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/stores/ui-store.ts app/tests/stores/ui-store.test.ts
git commit -m "feat(settings): ui-store settings flag

openSettings clears the picker and never touches activeTab. The flag goes in
initialUiState too, which reset() reuses.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: The merge rule

**Files:**
- Modify: `app/src/types/entity.ts`, `app/src/stores/hive-store.ts`, `app/src/lib/project-config.ts`
- Test: `app/tests/stores/hive-store.selectors.test.tsx` (extend), `app/tests/lib/project-config.test.ts` (extend)

**Interfaces:**
- Consumes: `ConfigSnapshot` with the v2 `ProjectConfig` (Tasks 1–3).
- Produces: `Project` gains `name: string` and `source: 'config' | 'demo'`; `useProjects()` merges; `addProjectToConfig`/`removeProjectFromConfig` in `project-config.ts`.

**Ordering is load-bearing:** config projects keep **file order**, never sorted, with demo projects appended. Story 103's drag-reorder rewrites the array's order and the left rail reads it positionally.

- [ ] **Step 1: Write the failing test**

```ts
describe('useProjects — the merge rule', () => {
  it('returns the fixtures unchanged when there is no snapshot', () => {
    setProjectConfigForTest(null);
    expect(renderProjects().every((p) => p.source === 'demo')).toBe(true);
  });

  it('returns the fixtures unchanged when the snapshot has no projects', () => {
    setProjectConfigForTest({ ...emptySnapshot('/tmp/c.json') });
    expect(renderProjects().every((p) => p.source === 'demo')).toBe(true);
  });

  it('returns config projects plus fixture projects that still own live sessions', () => {
    setProjectConfigForTest(snapshotWith([entry('the-hive', '/tmp/the-hive')]));
    const projects = renderProjects();

    expect(projects[0]).toMatchObject({ id: 'the-hive', source: 'config' });
    // apfm-web owns fixture sessions, so it survives, marked demo.
    expect(projects.find((p) => p.id === 'apfm-web')?.source).toBe('demo');
  });

  it('collapses a shared id to one row, config winning', () => {
    setProjectConfigForTest(snapshotWith([entry('apfm-web', '/tmp/apfm')]));
    const rows = renderProjects().filter((p) => p.id === 'apfm-web');

    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('config');
  });

  it('preserves config file order and never sorts', () => {
    setProjectConfigForTest(
      snapshotWith([entry('zeta', '/tmp/z'), entry('alpha', '/tmp/a')]),
    );
    const ids = renderProjects().filter((p) => p.source === 'config').map((p) => p.id);
    expect(ids).toEqual(['zeta', 'alpha']);
  });
});
```

- [ ] **Step 2: Run it**

Expected: FAIL — `source` is undefined.

- [ ] **Step 3: Implement**

`entity.ts`:

```ts
export interface Project {
  id: string;
  /** Display name. The fixtures' name is their id (story 101). */
  name: string;
  icon: string;
  /**
   * Where this row came from.
   *
   * `demo` is a fixture project kept alive because it still owns live fixture
   * sessions — the work panel, orchestrator table and `resolve-transport` all
   * reach sessions through `entity.project`, so dropping it would strand them.
   */
  source: 'config' | 'demo';
}
```

Add `name: project.id` and `source: 'demo'` to the fixture projects **in the store's initial state derivation**, not in `src/data/fixtures.ts` — that file must end byte-identical.

In `hive-store.ts`, replace `useProjects`:

```ts
/**
 * The project list: the config's, merged with the fixtures (story 101).
 *
 * | Situation | The list is |
 * |---|---|
 * | No snapshot — browser demo, first frames of launch | fixtures, unchanged |
 * | Snapshot with zero projects | fixtures, unchanged |
 * | Snapshot with projects | config's, plus fixture projects that still own live sessions, marked `demo` |
 *
 * Config order is the file's order and is never sorted — story 103's reorder
 * rewrites that array and the left rail reads it positionally.
 */
export const useProjects = (): Project[] => {
  const fixtures = useHiveStore(useShallow((state) => state.projects));
  const owned = useHiveStore(useShallow(projectsOwningSessions));
  const snapshot = useProjectConfig();

  return useMemo(() => {
    const configured = snapshot?.projects ?? [];
    if (configured.length === 0) return fixtures;

    const rows: Project[] = configured.map((entry) => ({
      id: entry.id,
      name: entry.name,
      icon: entry.icon,
      source: 'config' as const,
    }));
    const claimed = new Set(rows.map((row) => row.id));

    for (const fixture of fixtures) {
      if (claimed.has(fixture.id)) continue;   // config wins
      if (!owned.has(fixture.id)) continue;    // no live sessions, drop it
      rows.push(fixture);
    }
    return rows;
  }, [fixtures, owned, snapshot]);
};
```

Add the supporting selector next to it:

```ts
/** Ids of fixture projects that still own at least one session. */
const projectsOwningSessions = (state: HiveState): Set<string> => {
  const ids = new Set<string>();
  for (const id of state.order) {
    const entity = state.entities[id];
    if (entity && isSession(entity)) ids.add(entity.project);
  }
  return ids;
};
```

`useShallow` on a `Set` compares by reference and would defeat the memo — wrap the selector so it returns a stable array and build the `Set` inside `useMemo` instead, or memoise with the array. Verify with the "does not re-render on unrelated status change" assertion the existing selector tests use.

In `project-config.ts`, add the two wrappers next to `loadProjectConfig`:

```ts
/** Add a directory the user chose. Main re-validates it; this never guesses. */
export const addProjectToConfig = (request: AddProjectRequest): Promise<void> =>
  read((bridge) => bridge.config.addProject(request));

/** Remove one entry by id. */
export const removeProjectFromConfig = (request: RemoveProjectRequest): Promise<void> =>
  read((bridge) => bridge.config.removeProject(request));

/** Open the native directory dialog. Resolves null when cancelled or absent. */
export const chooseProjectDirectory = async (): Promise<string | null> => {
  const bridge = window.hive;
  if (!bridge) return null;
  return bridge.config.chooseDirectory();
};
```

`read` already installs the returned snapshot and emits, so a mutating verb needs no follow-up reload — that is what "every mutating verb returns `ConfigSnapshot`" buys.

- [ ] **Step 4: Run the tests**

Run: `cd app && pnpm vitest run tests/stores tests/lib && pnpm type-check`
Expected: PASS.

- [ ] **Step 5: Prove the fixtures are untouched**

Run: `git diff --exit-code app/src/data/`
Expected: no output, exit 0. This is an acceptance criterion.

- [ ] **Step 6: Commit**

```bash
git add app/src/types/entity.ts app/src/stores/hive-store.ts app/src/lib/project-config.ts app/tests/
git commit -m "feat(settings): config becomes the source of truth for the project list

Config projects in file order, never sorted, plus fixture projects that still
own live sessions marked demo — the work panel, orchestrator table and
resolve-transport all reach sessions through entity.project. A shared id
collapses to one row and config wins.

src/data/fixtures.ts is unchanged; the merge is a selector.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: The settings slice

**Files:**
- Create: `app/src/features/settings/components/{settings-overlay,projects-section,project-row}.tsx`
- Modify: `app/eslint.config.mjs`, `app/src/components/ui/icon.tsx`
- Test: `app/tests/features/settings/components/*.test.tsx` (**new**)

**Interfaces:**
- Consumes: `useSettingsActions` (Task 11), `useProjects` (Task 12), `chooseProjectDirectory` / `addProjectToConfig` / `removeProjectFromConfig` (Task 12).
- Produces: `<SettingsOverlay />`.

**Register the slice first.** Add `'settings'` to `FEATURE_SLICES` in `eslint.config.mjs` in alphabetical position (between `'sessions'` and `'simulation'`) **before** creating the directory — a slice that is not listed gets no isolation zone and silently becomes importable from everywhere.

- [ ] **Step 1: Register the slice and add the Folder icon**

In `eslint.config.mjs`, add `'settings',` to `FEATURE_SLICES`. In `src/components/ui/icon.tsx`, add `Folder` to the `@phosphor-icons/react` import and `'ph-folder': Folder,` to the map.

Run: `cd app && pnpm verify:boundaries`
Expected: PASS, and the check count rises by the number of zones per slice.

- [ ] **Step 2: Write the failing tests**

Create `app/tests/features/settings/components/projects-section.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectsSection } from '@features/settings/components/projects-section';

const chooseProjectDirectory = vi.fn();
const addProjectToConfig = vi.fn();
const removeProjectFromConfig = vi.fn();

vi.mock('@/lib/project-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/project-config')>()),
  chooseProjectDirectory: () => chooseProjectDirectory(),
  addProjectToConfig: (r: unknown) => addProjectToConfig(r),
  removeProjectFromConfig: (r: unknown) => removeProjectFromConfig(r),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

/** A resolved v2 entry, with only the interesting fields varying. */
const entry = (over: Partial<ProjectConfig> & { id: string }): ProjectConfig => ({
  name: over.id,
  path: `/tmp/${over.id}`,
  icon: 'ph-folder',
  origin: 'local',
  status: 'ok',
  isRepo: true,
  ...over,
});

const seed = (projects: ProjectConfig[], errors: string[] = []): void => {
  setProjectConfigForTest({
    ...emptySnapshot('/tmp/hive/config.json'),
    projects,
    errors,
  });
};

describe('ProjectsSection', () => {
  it('renders config and demo rows distinctly', () => {
    // apfm-web is a fixture project owning live fixture sessions, so the merge
    // rule keeps it and marks it demo.
    seed([entry({ id: 'the-hive', name: 'The Hive' })]);
    render(<ProjectsSection />);

    expect(screen.getByText('The Hive')).toBeInTheDocument();
    expect(screen.getByText('/tmp/the-hive')).toBeInTheDocument();
    expect(screen.getByText('demo')).toBeInTheDocument();
  });

  it('Add project calls chooseDirectory then addProject with the returned path', async () => {
    seed([]);
    chooseProjectDirectory.mockResolvedValue('/tmp/picked');
    render(<ProjectsSection />);

    fireEvent.click(screen.getByRole('button', { name: /add project/i }));

    await vi.waitFor(() => {
      expect(addProjectToConfig).toHaveBeenCalledWith({ path: '/tmp/picked' });
    });
  });

  it('writes nothing when the dialog is cancelled', async () => {
    seed([]);
    chooseProjectDirectory.mockResolvedValue(null);
    render(<ProjectsSection />);

    fireEvent.click(screen.getByRole('button', { name: /add project/i }));

    await vi.waitFor(() => expect(chooseProjectDirectory).toHaveBeenCalled());
    expect(addProjectToConfig).not.toHaveBeenCalled();
  });

  it('renders the reason from an error snapshot', () => {
    seed(
      [entry({ id: 'the-hive' })],
      ['config: cannot add /tmp/notes.txt (not-a-directory)'],
    );
    render(<ProjectsSection />);

    expect(screen.getByText(/not-a-directory/)).toBeInTheDocument();
    expect(screen.getByText(/notes\.txt/)).toBeInTheDocument();
  });

  it('shows the empty state when the config declares no projects', () => {
    seed([]);
    render(<ProjectsSection />);

    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add project/i })).toBeEnabled();
  });

  it('disables remove for a demo project, explaining why in a tooltip', () => {
    seed([entry({ id: 'the-hive' })]);
    render(<ProjectsSection />);

    // apfm-web is the demo row: it owns live fixture sessions, and story 103
    // owns the confirmation flow that would let it be removed.
    const remove = screen.getByRole('button', { name: /remove apfm-web/i });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute('aria-describedby');
  });

  it('removes a config project that owns no live sessions', async () => {
    seed([entry({ id: 'the-hive', name: 'The Hive' })]);
    render(<ProjectsSection />);

    fireEvent.click(screen.getByRole('button', { name: /remove The Hive/i }));

    await vi.waitFor(() => {
      expect(removeProjectFromConfig).toHaveBeenCalledWith({ id: 'the-hive' });
    });
  });

  it('tags a directory that is not a git repository', () => {
    seed([entry({ id: 'scratch', isRepo: false })]);
    render(<ProjectsSection />);

    expect(screen.getByText('no git')).toBeInTheDocument();
  });

  it('does not tag a directory that is a git repository', () => {
    seed([entry({ id: 'the-hive', isRepo: true })]);
    render(<ProjectsSection />);

    expect(screen.queryByText('no git')).not.toBeInTheDocument();
  });
});
```

Import `emptySnapshot` and `type ProjectConfig` from `@shared/config-contract` (type-only for the latter), `setProjectConfigForTest` from `@/lib/project-config`, and reset both stores in `beforeEach` following the idiom in `tests/features/sessions/components/new-session-picker.test.tsx`.

- [ ] **Step 3: Run to confirm they fail**

Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the three components**

`project-row.tsx` — one row: `Icon`, name over path, `Tag` for `demo` / `no git`, a remove button that is `disabled` with a `Tooltip` when the project owns live sessions or is a demo row. Tokens only (`text-ink`, `text-subtle`, `bg-chip`, `border-border-soft`).

`projects-section.tsx` — the pane: heading, sub, **the bordered card container present in both states** (`border border-border rounded-[7px]` when populated; `border border-dashed border-border` wrapping the empty message when not), the error list from `snapshot.errors`, the `+ Add project` button, and the config-path footer. The add handler:

```tsx
  const onAdd = async () => {
    const path = await chooseProjectDirectory();
    if (path === null) return;          // cancelled: no write, no error
    await addProjectToConfig({ path });
  };
```

`settings-overlay.tsx` — the shell: title bar with `✕` calling `closeSettings`, the section nav (one item, `Projects`, active), and the pane. Follow the picker's composition of the Radix `Dialog` primitive **directly** (`new-session-picker.tsx:28-44` explains why the vendored `DialogContent` is wrong here: it portals to `document.body` and centres a fixed card, and settings fills the center stage). Keep the focus trap, `Escape`, and `aria-modal`; omit `Dialog.Overlay` for the same reason the picker does.

- [ ] **Step 5: Run the tests**

Run: `cd app && pnpm vitest run tests/features/settings && pnpm lint && pnpm verify:boundaries`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/features/settings app/tests/features/settings app/eslint.config.mjs app/src/components/ui/icon.tsx
git commit -m "feat(settings): the settings overlay and its projects section

One section in a nav built for six. The projects list is a bordered card in
both states — the empty state is the screen a fresh install actually sees, and
a bordered box reads as a furnished empty place rather than a broken render.

'settings' is registered in FEATURE_SLICES; Folder joins the Icon map so the
default ph-folder resolves.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Mounting — stage, header, picker empty state

**Files:**
- Modify: `app/src/components/layout/center-stage.tsx`, `app/src/components/layout/header.tsx`, `app/src/features/sessions/components/new-session-picker.tsx`
- Test: the corresponding mirrored test files (extend)

- [ ] **Step 1: Write the failing tests**

Assert that (a) the overlay renders when `settings` is true, (b) **the terminal region is hidden** and `TerminalHost` receives `activeId={null}` while settings is open, (c) the header gear calls `openSettings`, and (d) the picker's empty state renders an **Add project** button that calls `openSettings` instead of naming a file path.

- [ ] **Step 2: Run to confirm they fail**

- [ ] **Step 3: Implement**

In `center-stage.tsx`, the `showingPicker` gate currently drives both the `hidden` class and `TerminalHost`'s `activeId`. Extend it — settings would otherwise render over thirteen live terminals:

```tsx
  const settings = useSettingsOpen();
  const view = resolveView({ activeTab, picker, settings, entity });
  const showingOverlay = view === 'picker' || view === 'settings';
```

Render `{view === 'settings' ? <SettingsOverlay /> : null}` as a sibling before the terminal region, and replace every remaining use of `showingPicker` with `showingOverlay` (the `hidden` class and `activeId={showingOverlay ? null : activeTab}`). Keep `{showingPicker ? <NewSessionPicker /> : null}` gated on the picker alone.

In `header.tsx`, add a gear button to the right-hand cluster, copying the round-button class from the theme toggle **verbatim including `[-webkit-app-region:no-drag]`** — the header is the window drag handle, and omitting it makes the button undraggable-but-unclickable. Use `Gear` from `@phosphor-icons/react`, `aria-label="Settings"`, `onClick={openSettings}`. Update the file's doc comment, which lists the header's contents.

In `new-session-picker.tsx`, replace the `config?.templateWritten` block that names `config.configPath` with an **Add project** button calling `openSettings()`. The user never has to read a console line or find a JSON file — that is the story's first acceptance criterion.

- [ ] **Step 4: Run the tests**

Run: `cd app && pnpm test && pnpm lint && pnpm type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/layout app/src/features/sessions app/tests/
git commit -m "feat(settings): mount the overlay, add the gear, fix the picker empty state

center-stage's overlay gate now covers both the picker and settings — it
drives the hidden class and TerminalHost's activeId, so a settings-only check
would have rendered the overlay over live terminals.

The picker's first-run notice becomes an Add project button instead of naming
a JSON path the user has never seen.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: End-to-end proof

**Files:**
- Create: `app/tests/e2e/electron/settings.spec.ts`

- [ ] **Step 1: Write the spec**

Against a `HIVE_CONFIG_PATH` sandbox and a `tmpdir` repo, with `dialog.showOpenDialog` stubbed in main (follow the fixture idiom in `tests/e2e/electron/session-lifecycle.spec.ts`): open settings from the header gear → click **Add project** → the row appears → close settings → the project is in the left rail → open the picker → the project is offered and spawnable.

Add a second case: **remove** the project and assert the file's `"//"` comment keys survived byte-identically.

- [ ] **Step 2: Run the electron e2e suite**

Run: `cd app && pnpm test:e2e:electron`
Expected: PASS, including the updated `security.spec.ts` surface assertion from Task 9.

- [ ] **Step 3: Full verification**

Run: `cd app && pnpm lint && pnpm type-check && pnpm test:coverage && pnpm verify:boundaries`
Expected: all PASS, coverage ≥ 80%.

Run: `git diff --exit-code app/src/data/`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add app/tests/e2e/electron/settings.spec.ts
git commit -m "test(settings): end-to-end add, spawn and remove

The only proof the whole slice works — the unit tests prove the pieces. Runs
against a HIVE_CONFIG_PATH sandbox with the native dialog stubbed in main.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Every section of the design spec maps to a task: reconciliation 1 → Task 12, 2 → documentation only (no code), 3 → Task 9, 4 → excluded by the Global Constraints, 5 → Task 13, 6 → Task 1, 7 → no code. Design decisions: card-in-both-states → Task 13, `isRepo` → Tasks 1/3, config order → Task 12. Architecture: write path → Task 6, comments → Task 6, schema v2 → Tasks 1–4, bridge → Tasks 8–9, surface → Tasks 10–11/14, identity → Task 5. Tests: all → their owning task plus Task 15.

**Type consistency.** `ProjectConfig` is seven fields from Task 1 and every producer returns all seven (Task 3). `ParsedConfig` gains `version`/`fatal` in Task 2 and is consumed under those names in Task 6. `deriveProjectId(directoryName, taken)` is defined in Task 5 and called with that arity in Task 7. `Project` is four fields from Task 12 and constructed with all four in the same task. `BRIDGE_CONFIG_KEYS` is the same five names in the contract, the preload, and both surface tests.

**Placeholder scan.** The first draft of this plan left elided test bodies (`// ...`, "seeded as above") in Tasks 7 and 13. Both are now written out in full — every test in the plan is runnable code. No task contains "TBD", "add appropriate error handling", "similar to Task N", or a code step without a code block.

**One judgement call recorded.** Task 13's component bodies are described structurally (which tokens, which atoms, which container in which state) rather than given as complete JSX. That is deliberate: the visual decisions are pinned by the approved mockup and the design spec, the tests above assert the behaviour exactly, and dictating 200 lines of markup would encode arbitrary class ordering as if it were a requirement. Every *behavioural* contract in that task — the add handler, the cancel path, the disabled-remove rule — is given as code.
