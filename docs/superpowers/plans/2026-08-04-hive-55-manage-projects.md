# Manage Projects — rename, re-point, reorder (HIVE-55) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three mutating config verbs — rename a project's display name, re-point one whose folder moved, and reorder the list the left rail reads positionally — plus the inline remove-with-confirmation that story 101 left disabled.

**Architecture:** Three new payload guards and three new `writeConfig` mutations in the main process, exposed on three new `invoke` channels through the existing preload bridge, consumed by renderer verbs that route through the existing `read()` funnel so every write returns and installs a fresh `ConfigSnapshot`. The Settings row grows a drag grip and a `⋯` overflow menu; the list moves out of `projects-section.tsx` into a new `projects-list.tsx` that owns drag state.

**Tech Stack:** Electron · TypeScript (strict) · React 19 · Vitest + happy-dom · Playwright `_electron` · Tailwind v4 with `--cc-*` tokens · pnpm.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-04-hive-55-manage-projects-design.md`. Every design decision there is binding.
- **No new dependencies.** Drag is hand-rolled HTML5 `draggable`. The repo ships 11 production deps and no DnD library; this story adds none.
- **Every mutation spreads the existing raw entry** — `{ ...entry, name }`, never a rebuilt object. This is what preserves per-entry unknown keys and makes `origin` survive a re-point.
- **Paths are stored as the user wrote them**, tilde and all. `realpath` is used only for validation and duplicate detection (`config/index.ts:176-179`).
- **`id` is never rewritten.** Rename edits `name` only.
- **Every mutating verb returns `ConfigSnapshot`** and is committed through `commit(writeConfig(...))`.
- **`tests/` mirrors `src/`** — no exceptions (`app/AGENTS.md:179-181`). 80% coverage on lines, statements, branches and functions.
- **No raw hex in components.** Colour comes from `--cc-*` token utilities (`bg-panel`, `text-muted`, `border-border`, `text-red`).
- **Renderer imports `@shared` type-only.** A value import pulls main-process code into the renderer bundle and fails `pnpm verify:boundaries`.
- **All commands run from `app/`.** `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm verify:boundaries` must all pass before the plan is done.
- **Commit after every task**, Conventional Commits with the ticket key: `feat(settings): <summary> (HIVE-55)`.

## File Structure

| File | Responsibility |
| --- | --- |
| `electron/shared/config-contract.ts` | **modify** — three request types |
| `electron/shared/guards.ts` | **modify** — three payload guards |
| `electron/shared/ipc-contract.ts` | **modify** — three channels, three bridge methods, `BRIDGE_CONFIG_KEYS` |
| `electron/main/config/index.ts` | **modify** — `renameProject`, `repointProject`, `reorderProjects` |
| `electron/main/ipc/index.ts` | **modify** — three `handle` registrations |
| `electron/preload/index.ts` | **modify** — three `invoke` wrappers |
| `src/lib/project-config.ts` | **modify** — three renderer verbs |
| `src/features/settings/components/project-row-menu.tsx` | **new** — the `⋯` menu |
| `src/features/settings/components/project-name-editor.tsx` | **new** — inline rename input |
| `src/features/settings/components/project-remove-confirm.tsx` | **new** — inline confirmation row |
| `src/features/settings/components/projects-list.tsx` | **new** — ordered list, drag state, row mode |
| `src/features/settings/components/project-row.tsx` | **modify** — grip, drag handlers, menu trigger |
| `src/features/settings/components/projects-section.tsx` | **modify** — list rendering moves out |
| `stories/README.md` | **modify** — index + Jira table repair |

---

### Task 1: Request types and payload guards

**Files:**
- Modify: `app/electron/shared/config-contract.ts` (after `RemoveProjectRequest`, ~line 166)
- Modify: `app/electron/shared/guards.ts` (after `parseRemoveProjectRequest`, ~line 275)
- Test: `app/tests/electron/shared/guards.test.ts`

**Interfaces:**
- Consumes: `assertShape`, `assertId`, `assertText`, `assertPath`, `fail` — all already in `guards.ts`.
- Produces: `RenameProjectRequest { id: string; name: string }`, `RepointProjectRequest { id: string; path: string }`, `ReorderProjectsRequest { ids: readonly string[] }`; `parseRenameProjectRequest(input: unknown): RenameProjectRequest`, `parseRepointProjectRequest(input: unknown): RepointProjectRequest`, `parseReorderProjectsRequest(input: unknown): ReorderProjectsRequest`.

- [ ] **Step 1: Write the failing tests**

Append to `app/tests/electron/shared/guards.test.ts`:

```ts
describe('parseRenameProjectRequest', () => {
  it('accepts an id and a display name', () => {
    expect(parseRenameProjectRequest({ id: 'the-hive', name: 'The Hive' })).toEqual({
      id: 'the-hive',
      name: 'The Hive',
    });
  });

  it('rejects an empty or whitespace-only name', () => {
    expect(() => parseRenameProjectRequest({ id: 'a', name: '' })).toThrow(/must not be empty/);
    expect(() => parseRenameProjectRequest({ id: 'a', name: '   ' })).toThrow(/must not be empty/);
  });

  it('rejects control characters and over-long names', () => {
    expect(() => parseRenameProjectRequest({ id: 'a', name: 'x\ny' })).toThrow(
      /control characters/,
    );
    expect(() => parseRenameProjectRequest({ id: 'a', name: 'x'.repeat(4097) })).toThrow(
      /too long/,
    );
  });

  it('rejects unknown keys, __proto__ and a missing field', () => {
    expect(() => parseRenameProjectRequest({ id: 'a', name: 'b', extra: 1 })).toThrow(
      /unexpected key/,
    );
    expect(() =>
      parseRenameProjectRequest(JSON.parse('{"id":"a","name":"b","__proto__":{}}')),
    ).toThrow(/forbidden key/);
    expect(() => parseRenameProjectRequest({ id: 'a' })).toThrow(/missing key/);
  });
});

describe('parseRepointProjectRequest', () => {
  it('accepts an id and a path, keeping the path verbatim', () => {
    expect(parseRepointProjectRequest({ id: 'the-hive', path: '~/Projects/hive' })).toEqual({
      id: 'the-hive',
      path: '~/Projects/hive',
    });
  });

  it('rejects an empty path and an unknown key', () => {
    expect(() => parseRepointProjectRequest({ id: 'a', path: '  ' })).toThrow(
      /expected a non-empty string/,
    );
    expect(() => parseRepointProjectRequest({ id: 'a', path: '/x', to: '/y' })).toThrow(
      /unexpected key/,
    );
  });
});

describe('parseReorderProjectsRequest', () => {
  it('accepts an array of ids and returns them in order', () => {
    expect(parseReorderProjectsRequest({ ids: ['a', 'b', 'c'] })).toEqual({
      ids: ['a', 'b', 'c'],
    });
  });

  it('accepts an empty list', () => {
    expect(parseReorderProjectsRequest({ ids: [] })).toEqual({ ids: [] });
  });

  it('rejects a non-array, a bad id, and a duplicate id', () => {
    expect(() => parseReorderProjectsRequest({ ids: 'a' })).toThrow(/expected an array/);
    expect(() => parseReorderProjectsRequest({ ids: ['a', 'a b'] })).toThrow(
      /reorderProjects.ids\[1\]/,
    );
    expect(() => parseReorderProjectsRequest({ ids: ['a', 'a'] })).toThrow(/duplicate id/);
  });
});
```

Add the three names to the existing import from `../../../electron/shared/guards` at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && pnpm vitest run tests/electron/shared/guards.test.ts`
Expected: FAIL — `parseRenameProjectRequest is not a function` (or an import error).

- [ ] **Step 3: Add the request types**

In `app/electron/shared/config-contract.ts`, directly after `RemoveProjectRequest`:

```ts
/**
 * Payload of `config:rename-project` (story 103).
 *
 * `name` only. The `id` is never rewritten: sessions reference projects by
 * `entity.project`, so an id that drifted when a folder was renamed would
 * strand them (`stories/101-settings-add-local-project.md:148-155`).
 */
export interface RenameProjectRequest {
  id: string;
  name: string;
}

/**
 * Payload of `config:repoint-project` (story 103).
 *
 * The path is re-validated in main from scratch, exactly like
 * {@link AddProjectRequest} — the native dialog is a UX step, not a capability
 * grant. `origin` is absent on purpose: re-pointing changes where a project
 * *is*, never where it came from, and the mutation spreads the existing entry
 * so a cloned project stays cloned.
 */
export interface RepointProjectRequest {
  id: string;
  path: string;
}

/**
 * Payload of `config:reorder-projects` (story 103).
 *
 * The **whole** ordering, not a delta. Both input paths — a drop and a menu
 * item — produce a full list, the verb is idempotent, and it validates exactly:
 * main requires these ids to be a permutation of the ids on disk at write time.
 * A delta could not be checked that way, and a config hand-edited since the
 * renderer loaded it would silently lose or duplicate a project.
 */
export interface ReorderProjectsRequest {
  ids: readonly string[];
}
```

- [ ] **Step 4: Add the guards**

In `app/electron/shared/guards.ts`, after `parseRemoveProjectRequest`. Add the three types to the existing `import type` from `./config-contract`.

```ts
export function parseRenameProjectRequest(input: unknown): RenameProjectRequest {
  const raw = assertShape(input, ['id', 'name'], 'renameProject');
  const name = assertText(raw.name, 'renameProject.name');
  // `assertText` rejects an empty string but not a whitespace-only one, and a
  // project called "   " is indistinguishable from an unnamed one on screen.
  // Trimmed here so main and the renderer cannot disagree about what is blank.
  const trimmed = name.trim();
  if (trimmed === '') return fail('renameProject.name: must not be empty');
  return { id: assertId(raw.id, 'renameProject.id'), name: trimmed };
}

export function parseRepointProjectRequest(input: unknown): RepointProjectRequest {
  const raw = assertShape(input, ['id', 'path'], 'repointProject');
  return {
    id: assertId(raw.id, 'repointProject.id'),
    // `assertPath`, not `assertText`: this is about to be expanded and
    // `realpath`'d, so it gets the permissive guard for the same reason
    // `parseAddProjectRequest` does.
    path: assertPath(raw.path, 'repointProject.path'),
  };
}

export function parseReorderProjectsRequest(input: unknown): ReorderProjectsRequest {
  const raw = assertShape(input, ['ids'], 'reorderProjects');
  if (!Array.isArray(raw.ids)) {
    return fail(`reorderProjects.ids: expected an array, got ${describe(raw.ids)}`);
  }
  const ids = raw.ids.map((id, index) => assertId(id, `reorderProjects.ids[${index}]`));
  // A duplicate can never be a permutation of the file's ids, and rejecting it
  // here means the verb's own check only ever has to compare sets.
  if (new Set(ids).size !== ids.length) {
    return fail('reorderProjects.ids: duplicate id');
  }
  return { ids };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd app && pnpm vitest run tests/electron/shared/guards.test.ts`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 6: Commit**

```bash
cd app && pnpm lint && pnpm type-check
cd .. && git add app/electron/shared/config-contract.ts app/electron/shared/guards.ts app/tests/electron/shared/guards.test.ts
git commit -m "feat(settings): payload guards for rename, re-point and reorder (HIVE-55)"
```

---

### Task 2: `renameProject`

**Files:**
- Modify: `app/electron/main/config/index.ts` (after `removeProject`, ~line 267)
- Test: `app/tests/electron/main/config/index.test.ts`

**Interfaces:**
- Consumes: `commit`, `writeConfig`, `projectsOf`, `idOf`, `WriteRefused` — all already in the module; `RenameProjectRequest` from Task 1.
- Produces: `renameProject(request: RenameProjectRequest): ConfigSnapshot`.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` to `app/tests/electron/main/config/index.test.ts`. `mutable()` and `writeConfig()` are existing helpers in that file.

```ts
describe('renameProject', () => {
  it('writes the new name and leaves the id and path alone', async () => {
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);
    const path = writeConfig({
      version: 2,
      projects: [{ id: 'repo', name: 'repo', path: repo, icon: 'ph-folder' }],
    });
    const module = await mutable();

    const snapshot = module.renameProject({ id: 'repo', name: 'My Repo' });

    expect(snapshot.errors).toEqual([]);
    expect(snapshot.projects[0]?.name).toBe('My Repo');
    expect(snapshot.projects[0]?.id).toBe('repo');
    const written = JSON.parse(readFileSync(path, 'utf8')).projects[0];
    expect(written.name).toBe('My Repo');
    expect(written.id).toBe('repo');
    expect(written.path).toBe(repo);
  });

  it('preserves per-entry keys it does not own', async () => {
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);
    const path = writeConfig({
      version: 2,
      projects: [{ id: 'repo', name: 'repo', path: repo, origin: 'cloned', note: 'keep me' }],
    });
    const module = await mutable();

    module.renameProject({ id: 'repo', name: 'Renamed' });

    const written = JSON.parse(readFileSync(path, 'utf8')).projects[0];
    expect(written.origin).toBe('cloned');
    expect(written.note).toBe('keep me');
  });

  it('refuses an id that is not in the file, writing nothing', async () => {
    const path = writeConfig({ version: 2, projects: [] });
    const module = await mutable();

    const snapshot = module.renameProject({ id: 'ghost', name: 'Ghost' });

    expect(snapshot.errors[0]).toMatch(/no project with id "ghost"/);
    expect(JSON.parse(readFileSync(path, 'utf8')).projects).toEqual([]);
  });

  it('upgrades a v1 file to v2 on the first rename, keeping its comments', async () => {
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);
    const path = writeConfig({
      version: 1,
      '// note': 'hand written',
      projects: [{ id: 'repo', path: repo }],
    });
    const module = await mutable();

    module.renameProject({ id: 'repo', name: 'Upgraded' });

    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.version).toBe(2);
    expect(written['// note']).toBe('hand written');
    expect(written.projects[0].name).toBe('Upgraded');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && pnpm vitest run tests/electron/main/config/index.test.ts -t renameProject`
Expected: FAIL — `module.renameProject is not a function`.

- [ ] **Step 3: Implement the verb**

In `app/electron/main/config/index.ts`, after `removeProject`. Add `RenameProjectRequest` to the existing `import type` from `../../shared/config-contract`.

```ts
/**
 * Change one project's display name (story 103).
 *
 * `name` only — `id` is machinery and is never rewritten. The entry is
 * **spread**, not rebuilt: `addProject` and `removeProject` copy raw entries
 * wholesale, which is the only reason per-entry keys this build does not know
 * about survive a write, and a rename that reconstructed an entry from
 * `ProjectConfig` would quietly eat them.
 */
export function renameProject(request: RenameProjectRequest): ConfigSnapshot {
  return commit(
    writeConfig((draft) => {
      const entries = projectsOf(draft);
      // Checked against the draft, not the cache, for the same reason
      // `addProject` is: the file can be newer than the snapshot.
      if (!entries.some((entry) => idOf(entry) === request.id)) {
        throw new WriteRefused(`no project with id "${request.id}"`);
      }

      return {
        ...draft,
        projects: entries.map((entry) =>
          idOf(entry) === request.id
            ? { ...(entry as Record<string, unknown>), name: request.name }
            : entry,
        ),
      };
    }),
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && pnpm vitest run tests/electron/main/config/index.test.ts -t renameProject`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd app && pnpm lint && pnpm type-check
cd .. && git add app/electron/main/config/index.ts app/tests/electron/main/config/index.test.ts
git commit -m "feat(settings): renameProject writes the display name only (HIVE-55)"
```

---

### Task 3: `repointProject`

**Files:**
- Modify: `app/electron/main/config/index.ts` (after `renameProject`)
- Test: `app/tests/electron/main/config/index.test.ts`

**Interfaces:**
- Consumes: `resolveProject`, `pathOf`, `idOf`, `projectsOf`, `refused`, `WriteRefused`, `LABEL`; `RepointProjectRequest` from Task 1.
- Produces: `repointProject(request: RepointProjectRequest): ConfigSnapshot`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('repointProject', () => {
  it('writes the new path as the user wrote it and keeps origin', async () => {
    const old = join(sandbox, 'old');
    const moved = join(home, 'moved');
    mkdirSync(old);
    mkdirSync(moved);
    const path = writeConfig({
      version: 2,
      projects: [{ id: 'repo', name: 'Repo', path: old, origin: 'cloned' }],
    });
    const module = await mutable();

    const snapshot = module.repointProject({ id: 'repo', path: '~/moved' });

    expect(snapshot.errors).toEqual([]);
    expect(snapshot.projects[0]?.status).toBe('ok');
    const written = JSON.parse(readFileSync(path, 'utf8')).projects[0];
    // Stored verbatim so the file stays portable; resolved only for identity.
    expect(written.path).toBe('~/moved');
    expect(written.origin).toBe('cloned');
    expect(written.name).toBe('Repo');
  });

  it('refuses a missing path, a file, and a relative path, writing nothing', async () => {
    const old = join(sandbox, 'old');
    const file = join(sandbox, 'a-file');
    mkdirSync(old);
    writeFileSync(file, '');
    const path = writeConfig({
      version: 2,
      projects: [{ id: 'repo', name: 'Repo', path: old }],
    });
    const module = await mutable();

    expect(module.repointProject({ id: 'repo', path: 'relative' }).errors[0]).toMatch(
      /not-absolute/,
    );
    expect(module.repointProject({ id: 'repo', path: file }).errors[0]).toMatch(
      /not-a-directory/,
    );
    expect(
      module.repointProject({ id: 'repo', path: join(sandbox, 'nope') }).errors[0],
    ).toMatch(/missing/);

    expect(JSON.parse(readFileSync(path, 'utf8')).projects[0].path).toBe(old);
  });

  it('refuses a path another project already occupies', async () => {
    const first = join(sandbox, 'first');
    const second = join(sandbox, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeConfig({
      version: 2,
      projects: [
        { id: 'first', name: 'First', path: first },
        { id: 'second', name: 'Second', path: second },
      ],
    });
    const module = await mutable();

    const snapshot = module.repointProject({ id: 'second', path: first });

    expect(snapshot.errors[0]).toMatch(/already added as "first"/);
  });

  it('permits re-pointing a project at the folder it already has', async () => {
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);
    writeConfig({ version: 2, projects: [{ id: 'repo', name: 'Repo', path: repo }] });
    const module = await mutable();

    const snapshot = module.repointProject({ id: 'repo', path: repo });

    expect(snapshot.errors).toEqual([]);
    expect(snapshot.projects[0]?.status).toBe('ok');
  });

  it('refuses an id that is not in the file', async () => {
    writeConfig({ version: 2, projects: [] });
    const module = await mutable();
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);

    expect(module.repointProject({ id: 'ghost', path: repo }).errors[0]).toMatch(
      /no project with id "ghost"/,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && pnpm vitest run tests/electron/main/config/index.test.ts -t repointProject`
Expected: FAIL — `module.repointProject is not a function`.

- [ ] **Step 3: Implement the verb**

```ts
/**
 * Point a project at a folder that moved (story 103).
 *
 * The incoming path re-runs the **entire** story 090 resolution, exactly as
 * `addProject` does — the native dialog is a UX step, not a capability grant,
 * and a renderer that skipped it gets identical treatment.
 *
 * `origin` survives because the entry is spread and only `path` is overwritten:
 * re-pointing changes where a project *is*, never where it came from, so a
 * cloned project stays `origin: "cloned"`. That is a property of the mutation's
 * shape rather than a rule enforced here.
 */
export function repointProject(request: RepointProjectRequest): ConfigSnapshot {
  const probe = resolveProject({ id: 'probe', path: request.path });
  if (probe.status !== 'ok' || probe.path === null) {
    return refused(`${LABEL}: cannot re-point to ${request.path} (${probe.status})`);
  }
  const real = probe.path;

  return commit(
    writeConfig((draft) => {
      const entries = projectsOf(draft);
      if (!entries.some((entry) => idOf(entry) === request.id)) {
        throw new WriteRefused(`no project with id "${request.id}"`);
      }

      for (const entry of entries) {
        // Skip the project being moved: re-pointing it at the folder it
        // already has is a no-op the user is allowed to perform, not a clash.
        if (idOf(entry) === request.id) continue;
        const declared = pathOf(entry);
        if (declared === null) continue;
        if (resolveProject({ id: 'probe', path: declared }).path === real) {
          throw new WriteRefused(
            `${real} is already added as "${idOf(entry) ?? 'an existing entry'}"`,
          );
        }
      }

      return {
        ...draft,
        projects: entries.map((entry) =>
          idOf(entry) === request.id
            ? { ...(entry as Record<string, unknown>), path: request.path }
            : entry,
        ),
      };
    }),
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && pnpm vitest run tests/electron/main/config/index.test.ts -t repointProject`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd app && pnpm lint && pnpm type-check
cd .. && git add app/electron/main/config/index.ts app/tests/electron/main/config/index.test.ts
git commit -m "feat(settings): repointProject re-validates and preserves origin (HIVE-55)"
```

---

### Task 4: `reorderProjects`

**Files:**
- Modify: `app/electron/main/config/index.ts` (after `repointProject`)
- Test: `app/tests/electron/main/config/index.test.ts`

**Interfaces:**
- Consumes: `projectsOf`, `idOf`, `WriteRefused`; `ReorderProjectsRequest` from Task 1.
- Produces: `reorderProjects(request: ReorderProjectsRequest): ConfigSnapshot`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('reorderProjects', () => {
  /** Three real directories and a config listing them a, b, c. */
  async function threeProjects() {
    for (const name of ['a', 'b', 'c']) mkdirSync(join(sandbox, name));
    const path = writeConfig({
      version: 2,
      projects: ['a', 'b', 'c'].map((id) => ({
        id,
        name: id.toUpperCase(),
        path: join(sandbox, id),
      })),
    });
    return { path, module: await mutable() };
  }

  it('rewrites the array into the given order', async () => {
    const { path, module } = await threeProjects();

    const snapshot = module.reorderProjects({ ids: ['c', 'a', 'b'] });

    expect(snapshot.errors).toEqual([]);
    expect(snapshot.projects.map((p) => p.id)).toEqual(['c', 'a', 'b']);
    expect(
      JSON.parse(readFileSync(path, 'utf8')).projects.map((p: { id: string }) => p.id),
    ).toEqual(['c', 'a', 'b']);
  });

  it('carries each entry across whole, including keys it does not own', async () => {
    mkdirSync(join(sandbox, 'a'));
    mkdirSync(join(sandbox, 'b'));
    const path = writeConfig({
      version: 2,
      projects: [
        { id: 'a', name: 'A', path: join(sandbox, 'a'), origin: 'cloned', note: 'keep' },
        { id: 'b', name: 'B', path: join(sandbox, 'b') },
      ],
    });
    const module = await mutable();

    module.reorderProjects({ ids: ['b', 'a'] });

    const written = JSON.parse(readFileSync(path, 'utf8')).projects;
    expect(written[0].id).toBe('b');
    expect(written[1]).toMatchObject({ id: 'a', origin: 'cloned', note: 'keep' });
  });

  it('refuses an ordering that is not a permutation of the file', async () => {
    const { path, module } = await threeProjects();

    // Too few — a project the renderer never knew about would be dropped.
    expect(module.reorderProjects({ ids: ['a', 'b'] }).errors[0]).toMatch(
      /does not match the projects on disk/,
    );
    // An id that is not there.
    expect(module.reorderProjects({ ids: ['a', 'b', 'z'] }).errors[0]).toMatch(
      /does not match the projects on disk/,
    );

    expect(
      JSON.parse(readFileSync(path, 'utf8')).projects.map((p: { id: string }) => p.id),
    ).toEqual(['a', 'b', 'c']);
  });

  it('refuses an ordering built before the file gained a project', async () => {
    const { path, module } = await threeProjects();
    // Simulate a hand edit between the renderer's read and its write.
    mkdirSync(join(sandbox, 'd'));
    const document = JSON.parse(readFileSync(path, 'utf8'));
    document.projects.push({ id: 'd', name: 'D', path: join(sandbox, 'd') });
    writeFileSync(path, JSON.stringify(document));

    const snapshot = module.reorderProjects({ ids: ['c', 'b', 'a'] });

    expect(snapshot.errors[0]).toMatch(/does not match the projects on disk/);
    expect(
      JSON.parse(readFileSync(path, 'utf8')).projects.map((p: { id: string }) => p.id),
    ).toEqual(['a', 'b', 'c', 'd']);
  });

  it('accepts an empty ordering for an empty file', async () => {
    writeConfig({ version: 2, projects: [] });
    const module = await mutable();

    expect(module.reorderProjects({ ids: [] }).errors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && pnpm vitest run tests/electron/main/config/index.test.ts -t reorderProjects`
Expected: FAIL — `module.reorderProjects is not a function`.

- [ ] **Step 3: Implement the verb**

```ts
/**
 * Rewrite the order of the `projects` array (story 103).
 *
 * The payload is the **whole** ordering, and it must be a permutation of the
 * ids on disk *at write time*. That check is the reason the verb takes a full
 * list rather than a delta: the config is deliberately not watched, so the
 * renderer's list can be older than the file, and applying a stale ordering
 * would silently drop the project a hand edit had just added — or resurrect one
 * it had removed. Refusing sends the user to reload, which is honest and cheap.
 *
 * The left rail reads this order positionally (`projects-panel.tsx`), and the
 * merged list is explicitly never sorted (`hive-store.ts`), so the array *is*
 * the ordering — there is nowhere else for it to live.
 */
export function reorderProjects(request: ReorderProjectsRequest): ConfigSnapshot {
  return commit(
    writeConfig((draft) => {
      const entries = projectsOf(draft);
      const byId = new Map<string, unknown>();
      for (const entry of entries) {
        const id = idOf(entry);
        if (id !== null) byId.set(id, entry);
      }

      // The guard already rejected duplicates, so equal sizes plus every id
      // being present is exactly "is a permutation".
      const matches =
        byId.size === request.ids.length && request.ids.every((id) => byId.has(id));
      if (!matches) {
        throw new WriteRefused(
          'the requested order does not match the projects on disk — reload and try again',
        );
      }

      return {
        ...draft,
        // Entries are carried across by reference, never rebuilt, so anything
        // this build does not understand rides along untouched.
        projects: request.ids.map((id) => byId.get(id)),
      };
    }),
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && pnpm vitest run tests/electron/main/config/index.test.ts`
Expected: PASS — the whole file, including Tasks 2 and 3.

- [ ] **Step 5: Commit**

```bash
cd app && pnpm lint && pnpm type-check
cd .. && git add app/electron/main/config/index.ts app/tests/electron/main/config/index.test.ts
git commit -m "feat(settings): reorderProjects rewrites config order (HIVE-55)"
```

---

### Task 5: Channels, IPC handlers and the preload bridge

**Files:**
- Modify: `app/electron/shared/ipc-contract.ts` (`CH` ~line 36, `HiveBridge.config` ~line 279, `BRIDGE_CONFIG_KEYS` ~line 353)
- Modify: `app/electron/main/ipc/index.ts` (after the `configRemoveProject` handler, ~line 200)
- Modify: `app/electron/preload/index.ts` (~line 91)
- Test: `app/tests/electron/main/ipc/config-channels.test.ts` (new), `app/tests/electron/preload/bridge.test.ts` (extend)

**Interfaces:**
- Consumes: the three verbs from Tasks 2–4, the three guards from Task 1.
- Produces: `CH.configRenameProject`, `CH.configRepointProject`, `CH.configReorderProjects`; `bridge.config.renameProject/repointProject/reorderProjects`, each `(request) => Promise<ConfigSnapshot>`.

- [ ] **Step 1: Write the failing tests**

Create `app/tests/electron/main/ipc/config-channels.test.ts`.

**Read `app/tests/electron/main/ipc/clone-channels.test.ts` first and copy its harness verbatim** — the `vi.mock('electron', …)` block, the `handlers` map that captures what `ipcMain.handle` registered, and the fake `event` object. `registerWithMocks()` below is that harness plus a `vi.mock` of `../../../../electron/main/config/index` exposing `renameProject`, `repointProject` and `reorderProjects` as `vi.fn()`s that all return one shared `snapshot` object. Do not invent a second harness; two mocks of the same `electron` module drift.

```ts
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { CH } from '../../../../electron/shared/ipc-contract';

// Mirrors tests/electron/main/ipc/clone-channels.test.ts — see that file for
// the electron mock and the handler-capture harness.

describe('story 103 config channels', () => {
  it('registers rename, re-point and reorder as invoke handlers', async () => {
    const { handlers } = await registerWithMocks();

    expect(handlers.has(CH.configRenameProject)).toBe(true);
    expect(handlers.has(CH.configRepointProject)).toBe(true);
    expect(handlers.has(CH.configReorderProjects)).toBe(true);
  });

  it('guards the payload before the verb sees it', async () => {
    const { handlers, config } = await registerWithMocks();

    await expect(
      handlers.get(CH.configRenameProject)?.(event, { id: 'a', name: 'b', extra: 1 }),
    ).rejects.toThrow(/unexpected key/);
    expect(config.renameProject).not.toHaveBeenCalled();
  });

  it('passes the parsed request through and returns the snapshot', async () => {
    const { handlers, config } = await registerWithMocks();

    const result = await handlers.get(CH.configReorderProjects)?.(event, {
      ids: ['a', 'b'],
    });

    expect(config.reorderProjects).toHaveBeenCalledWith({ ids: ['a', 'b'] });
    expect(result).toBe(config.snapshot);
  });
});
```

Extend `app/tests/electron/preload/bridge.test.ts` — the existing exact-key-set assertion at `:63` fails until the bridge grows the three verbs; add a case that each new method invokes its channel with the request.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && pnpm vitest run tests/electron/main/ipc/config-channels.test.ts tests/electron/preload/bridge.test.ts`
Expected: FAIL — unknown `CH` keys and a `BRIDGE_CONFIG_KEYS` mismatch.

- [ ] **Step 3: Extend the contract**

In `CH`, after `configRemoveProject`:

```ts
  /** Story 103's mutating verbs. All `invoke` — each returns the fresh snapshot. */
  configRenameProject: 'config:rename-project',
  configRepointProject: 'config:repoint-project',
  configReorderProjects: 'config:reorder-projects',
```

In `HiveBridge.config`, after `removeProject`:

```ts
    /** Change a project's display name (story 103). The id is never touched. */
    renameProject(request: RenameProjectRequest): Promise<ConfigSnapshot>;
    /** Point a project at a folder that moved. Main re-validates from scratch. */
    repointProject(request: RepointProjectRequest): Promise<ConfigSnapshot>;
    /** Rewrite the whole order. Refused unless it matches the file on disk. */
    reorderProjects(request: ReorderProjectsRequest): Promise<ConfigSnapshot>;
```

In `BRIDGE_CONFIG_KEYS`, before the story-102 group:

```ts
  // Story 103.
  'renameProject',
  'repointProject',
  'reorderProjects',
```

- [ ] **Step 4: Register the handlers**

In `app/electron/main/ipc/index.ts`, after the `configRemoveProject` handler. Import the three verbs and three guards.

```ts
  /**
   * Managing projects (story 103).
   *
   * Same contract as story 101's mutating verbs: the guard proves the *shape*,
   * and main proves the *value* — `repointProject` re-runs the full path
   * resolution, and `reorderProjects` re-reads the file before deciding whether
   * the ordering it was handed still describes it.
   */
  handle(
    CH.configRenameProject,
    (_event, payload): ConfigSnapshot =>
      renameProject(parseRenameProjectRequest(payload)),
  );

  handle(
    CH.configRepointProject,
    (_event, payload): ConfigSnapshot =>
      repointProject(parseRepointProjectRequest(payload)),
  );

  handle(
    CH.configReorderProjects,
    (_event, payload): ConfigSnapshot =>
      reorderProjects(parseReorderProjectsRequest(payload)),
  );
```

- [ ] **Step 5: Extend the preload bridge**

In `app/electron/preload/index.ts`, after `removeProject`:

```ts
    // Story 103. Like 101's verbs, each returns the fresh snapshot so the
    // renderer never has to follow a write with a reload.
    renameProject: (request: RenameProjectRequest): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configRenameProject, request),
    repointProject: (request: RepointProjectRequest): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configRepointProject, request),
    reorderProjects: (request: ReorderProjectsRequest): Promise<ConfigSnapshot> =>
      ipcRenderer.invoke(CH.configReorderProjects, request),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd app && pnpm vitest run tests/electron/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd app && pnpm lint && pnpm type-check
cd .. && git add app/electron app/tests/electron
git commit -m "feat(settings): expose rename, re-point and reorder on the bridge (HIVE-55)"
```

---

### Task 6: Renderer config verbs

**Files:**
- Modify: `app/src/lib/project-config.ts` (after `removeProjectFromConfig`, ~line 94)
- Test: `app/tests/lib/project-config.test.ts`

**Interfaces:**
- Consumes: the existing `read()` funnel; the bridge methods from Task 5.
- Produces: `renameProjectInConfig(request: RenameProjectRequest): Promise<void>`, `repointProjectInConfig(request: RepointProjectRequest): Promise<void>`, `reorderProjectsInConfig(request: ReorderProjectsRequest): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Extend `app/tests/lib/project-config.test.ts`, following its existing fake-bridge pattern:

```ts
describe('story 103 verbs', () => {
  it('installs the snapshot each verb returns and notifies subscribers', async () => {
    const next = snapshotFixture({ projects: [] });
    const bridge = fakeBridge({
      renameProject: vi.fn().mockResolvedValue(next),
      repointProject: vi.fn().mockResolvedValue(next),
      reorderProjects: vi.fn().mockResolvedValue(next),
    });
    const seen = vi.fn();
    subscribeProjectConfig(seen);

    await renameProjectInConfig({ id: 'a', name: 'A' });
    expect(bridge.config.renameProject).toHaveBeenCalledWith({ id: 'a', name: 'A' });
    expect(projectConfigSnapshot()).toBe(next);

    await repointProjectInConfig({ id: 'a', path: '/tmp/a' });
    await reorderProjectsInConfig({ ids: ['a'] });

    expect(seen).toHaveBeenCalledTimes(3);
  });

  it('is a no-op with no bridge, like every other verb', async () => {
    // The browser demo has no bridge; story 083's rule is to feature-detect it.
    await expect(reorderProjectsInConfig({ ids: [] })).resolves.toBeUndefined();
    expect(projectConfigSnapshot()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && pnpm vitest run tests/lib/project-config.test.ts`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement the verbs**

```ts
/**
 * Rename a project (story 103).
 *
 * Routed through `read` like every other mutating verb, so the snapshot main
 * returns is the one the UI renders — there is no optimistic name to reconcile.
 */
export const renameProjectInConfig = (
  request: RenameProjectRequest,
): Promise<void> => read((bridge) => bridge.config.renameProject(request));

/** Point a project at a folder that moved (story 103). */
export const repointProjectInConfig = (
  request: RepointProjectRequest,
): Promise<void> => read((bridge) => bridge.config.repointProject(request));

/** Rewrite the project order (story 103). */
export const reorderProjectsInConfig = (
  request: ReorderProjectsRequest,
): Promise<void> => read((bridge) => bridge.config.reorderProjects(request));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && pnpm vitest run tests/lib/project-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd app && pnpm lint && pnpm type-check
cd .. && git add app/src/lib/project-config.ts app/tests/lib/project-config.test.ts
git commit -m "feat(settings): renderer verbs for rename, re-point and reorder (HIVE-55)"
```

---

### Task 7: `ProjectRowMenu`

**Files:**
- Create: `app/src/features/settings/components/project-row-menu.tsx`
- Test: `app/tests/features/settings/components/project-row-menu.test.tsx`

**Interfaces:**
- Consumes: `@components/ui/dropdown-menu` (read it first for the exact export names and required sub-components).
- Produces:

```ts
interface ProjectRowMenuProps {
  projectName: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRename: () => void;
  onRepoint: () => void;
  onRemove: () => void;
}
export function ProjectRowMenu(props: ProjectRowMenuProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ProjectRowMenu } from '@features/settings/components/project-row-menu';

function setup(overrides: Partial<Parameters<typeof ProjectRowMenu>[0]> = {}) {
  const props = {
    projectName: 'The Hive',
    canMoveUp: true,
    canMoveDown: true,
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
    onRename: vi.fn(),
    onRepoint: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
  render(<ProjectRowMenu {...props} />);
  return props;
}

describe('ProjectRowMenu', () => {
  it('names the project it acts on, so the trigger is unambiguous to a screen reader', () => {
    setup();
    expect(screen.getByRole('button', { name: /the hive/i })).toBeInTheDocument();
  });

  it('offers every action on the row', async () => {
    setup();
    await userEvent.click(screen.getByRole('button'));

    for (const label of [/move up/i, /move down/i, /rename/i, /change folder/i, /remove/i]) {
      expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
  });

  it('calls the handler for the item chosen', async () => {
    const props = setup();
    await userEvent.click(screen.getByRole('button'));
    await userEvent.click(screen.getByRole('menuitem', { name: /rename/i }));

    expect(props.onRename).toHaveBeenCalledTimes(1);
  });

  it('disables Move up on the first row and Move down on the last', async () => {
    setup({ canMoveUp: false, canMoveDown: true });
    await userEvent.click(screen.getByRole('button'));

    expect(screen.getByRole('menuitem', { name: /move up/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: /move down/i })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && pnpm vitest run tests/features/settings/components/project-row-menu.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Check the exact export names in `@components/ui/dropdown-menu` before writing this — it is the shadcn set, so `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem` and `DropdownMenuSeparator` are expected, but confirm rather than assume.

```tsx
import { DotsThree } from '@phosphor-icons/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@components/ui/dropdown-menu';

interface ProjectRowMenuProps {
  projectName: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRename: () => void;
  onRepoint: () => void;
  onRemove: () => void;
}

/**
 * Every action on a project row, in one menu (story 103).
 *
 * A menu rather than a row of icon buttons because this list is read far more
 * often than it is edited: four controls plus the `demo` and `no git` tags
 * would crowd the right edge of every row to make three of them reachable one
 * click sooner.
 *
 * *Move up* / *Move down* live here rather than behind a keyboard lift mode on
 * the drag grip. They are the keyboard path for reordering, and because they
 * are ordinary menu items the reorder logic is provable by unit test — a lift
 * mode would make drag the only way to reach it.
 */
export function ProjectRowMenu({
  projectName,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onRename,
  onRepoint,
  onRemove,
}: ProjectRowMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${projectName}`}
        className="shrink-0 rounded p-1 text-subtle hover:bg-hover hover:text-ink"
      >
        <DotsThree size={13} weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/*
          Disabled at the ends of the list rather than hidden: an item that
          vanishes on the first row makes the menu a different shape per row,
          and `disabled` still announces the action exists.
        */}
        <DropdownMenuItem disabled={!canMoveUp} onSelect={onMoveUp}>
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canMoveDown} onSelect={onMoveDown}>
          Move down
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRename}>Rename…</DropdownMenuItem>
        <DropdownMenuItem onSelect={onRepoint}>Change folder…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRemove} className="text-red">
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

If the primitive's item uses `onClick` rather than `onSelect`, follow the primitive — the tests assert the handler fires, not which prop carries it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && pnpm vitest run tests/features/settings/components/project-row-menu.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd app && pnpm lint && pnpm type-check
cd .. && git add app/src/features/settings/components/project-row-menu.tsx app/tests/features/settings/components/project-row-menu.test.tsx
git commit -m "feat(settings): project row overflow menu (HIVE-55)"
```

---

### Task 8: `ProjectNameEditor`

**Files:**
- Create: `app/src/features/settings/components/project-name-editor.tsx`
- Test: `app/tests/features/settings/components/project-name-editor.test.tsx`

**Interfaces:**
- Produces:

```ts
interface ProjectNameEditorProps {
  initialName: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}
export function ProjectNameEditor(props: ProjectNameEditorProps): JSX.Element;
```

`onCommit` fires only when the trimmed value is non-empty **and** differs from `initialName`; otherwise `onCancel` fires. That rule lives here so no caller has to repeat it.

- [ ] **Step 1: Write the failing test**

```tsx
describe('ProjectNameEditor', () => {
  it('focuses and selects the current name so typing replaces it', () => {
    render(<ProjectNameEditor initialName="The Hive" onCommit={vi.fn()} onCancel={vi.fn()} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;

    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('The Hive'.length);
  });

  it('commits a changed name on Enter, trimmed', async () => {
    const onCommit = vi.fn();
    render(<ProjectNameEditor initialName="Old" onCommit={onCommit} onCancel={vi.fn()} />);

    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), '  New  {Enter}');

    expect(onCommit).toHaveBeenCalledWith('New');
  });

  it('cancels on Escape without committing', async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(<ProjectNameEditor initialName="Old" onCommit={onCommit} onCancel={onCancel} />);

    await userEvent.type(screen.getByRole('textbox'), 'X{Escape}');

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels rather than committing when the name is blank or unchanged', async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(<ProjectNameEditor initialName="Old" onCommit={onCommit} onCancel={onCancel} />);

    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), '   {Enter}');
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it('commits on blur, so clicking away is not a silent discard', async () => {
    const onCommit = vi.fn();
    render(<ProjectNameEditor initialName="Old" onCommit={onCommit} onCancel={vi.fn()} />);

    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), 'New');
    await userEvent.tab();

    expect(onCommit).toHaveBeenCalledWith('New');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && pnpm vitest run tests/features/settings/components/project-name-editor.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

```tsx
import { useEffect, useRef } from 'react';

interface ProjectNameEditorProps {
  initialName: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

/**
 * Edit a project's display name in place (story 103).
 *
 * The "is this worth writing?" rule lives here rather than in each caller: a
 * blank name and an unchanged name are both cancels, so nothing downstream has
 * to re-derive that. Main rejects a blank name too — this is the convenience,
 * not the gate.
 */
export function ProjectNameEditor({
  initialName,
  onCommit,
  onCancel,
}: ProjectNameEditorProps) {
  const input = useRef<HTMLInputElement>(null);
  /**
   * Set by Escape so the blur it causes does not then commit.
   *
   * A ref rather than state: the blur handler runs before any re-render would
   * deliver a new value, so state would still read `false` at the moment it
   * matters.
   */
  const cancelled = useRef(false);

  useEffect(() => {
    // Selected, not just focused: the common edit is replacing the derived
    // basename outright, and that should not need a Cmd+A first.
    input.current?.select();
  }, []);

  const commit = () => {
    if (cancelled.current) return;
    const next = input.current?.value.trim() ?? '';
    if (next === '' || next === initialName) {
      onCancel();
      return;
    }
    onCommit(next);
  };

  return (
    <input
      ref={input}
      aria-label="Project name"
      defaultValue={initialName}
      autoFocus
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelled.current = true;
          onCancel();
        }
      }}
      className="w-full rounded-[5px] border border-brand-fill bg-bg px-1.5 py-0.5 text-[13px] text-ink"
    />
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && pnpm vitest run tests/features/settings/components/project-name-editor.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd app && pnpm lint && pnpm type-check
cd .. && git add app/src/features/settings/components/project-name-editor.tsx app/tests/features/settings/components/project-name-editor.test.tsx
git commit -m "feat(settings): inline project name editor (HIVE-55)"
```

---

### Task 9: `ProjectRemoveConfirm`

**Files:**
- Create: `app/src/features/settings/components/project-remove-confirm.tsx`
- Test: `app/tests/features/settings/components/project-remove-confirm.test.tsx`

**Interfaces:**
- Produces:

```ts
interface ProjectRemoveConfirmProps {
  projectName: string;
  /** How many of this project's sessions are not done. Zero is valid. */
  liveSessionCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}
export function ProjectRemoveConfirm(props: ProjectRemoveConfirmProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

```tsx
describe('ProjectRemoveConfirm', () => {
  it('names the project being removed', () => {
    render(
      <ProjectRemoveConfirm
        projectName="The Hive"
        liveSessionCount={3}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/the hive/i)).toBeInTheDocument();
  });

  it('says the sessions keep running rather than implying they are killed', () => {
    render(
      <ProjectRemoveConfirm
        projectName="The Hive"
        liveSessionCount={3}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/3 live sessions will keep running/i)).toBeInTheDocument();
    expect(screen.getByText(/directory on disk is untouched/i)).toBeInTheDocument();
  });

  it('uses the singular for one session', () => {
    render(
      <ProjectRemoveConfirm
        projectName="A"
        liveSessionCount={1}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 live session will keep running/i)).toBeInTheDocument();
  });

  it('calls onConfirm and onCancel from their buttons', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ProjectRemoveConfirm
        projectName="A"
        liveSessionCount={2}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape', async () => {
    const onCancel = vi.fn();
    render(
      <ProjectRemoveConfirm
        projectName="A"
        liveSessionCount={0}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && pnpm vitest run tests/features/settings/components/project-remove-confirm.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

```tsx
interface ProjectRemoveConfirmProps {
  projectName: string;
  /** How many of this project's sessions are not done. Zero is valid. */
  liveSessionCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirm removing a project, in the row's own place (story 103).
 *
 * Inline rather than a centred dialog: the row is already the subject of the
 * question, so nothing has to float over thirteen live terminals to ask it, and
 * the list does not move under an accidental Cancel.
 *
 * **What it says is the design.** Removing a project deletes a config entry; it
 * does not kill anything. The sessions keep running and simply stop resolving
 * to a mapped project. Wording this as data loss would be false, and killing a
 * user's terminals as a side-effect of a settings edit is a far larger action
 * than this story is authorised to take.
 */
export function ProjectRemoveConfirm({
  projectName,
  liveSessionCount,
  onConfirm,
  onCancel,
}: ProjectRemoveConfirmProps) {
  const sessions =
    liveSessionCount === 1
      ? '1 live session will keep running'
      : `${liveSessionCount} live sessions will keep running`;

  return (
    <div
      role="alertdialog"
      aria-label={`Remove ${projectName}?`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
      className="border-b border-border-soft bg-red/8 px-3 py-2.5 last:border-b-0"
    >
      <p className="text-[12.5px] text-ink">
        Remove <strong className="font-medium">{projectName}</strong> from your projects?
      </p>
      <p className="mt-0.5 text-[11.5px] text-subtle">
        {sessions} — they just stop resolving to a folder. The directory on disk is
        untouched.
      </p>
      <div className="mt-2 flex justify-end gap-1.5">
        {/*
          Cancel takes focus, not Remove. The destructive option should never be
          one stray Enter away when the dialog appears.
        */}
        <button
          type="button"
          autoFocus
          onClick={onCancel}
          className="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-md bg-red px-2.5 py-1 text-[12px] font-medium text-bg hover:opacity-90"
        >
          Remove
        </button>
      </div>
    </div>
  );
}
```

If `bg-red/8` does not resolve under the project's Tailwind config, add a token rather than reaching for a hex — raw hex in components is banned.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && pnpm vitest run tests/features/settings/components/project-remove-confirm.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd app && pnpm lint && pnpm type-check
cd .. && git add app/src/features/settings/components/project-remove-confirm.tsx app/tests/features/settings/components/project-remove-confirm.test.tsx
git commit -m "feat(settings): inline remove confirmation (HIVE-55)"
```

---

### Task 10: `ProjectsList` — drag, modes, and wiring

**Files:**
- Create: `app/src/features/settings/components/projects-list.tsx`
- Modify: `app/src/features/settings/components/project-row.tsx`
- Modify: `app/src/features/settings/components/projects-section.tsx`
- Test: `app/tests/features/settings/components/projects-list.test.tsx` (new), `app/tests/features/settings/components/project-row.test.tsx` (new), `app/tests/features/settings/components/projects-section.test.tsx` (extend)

**Interfaces:**
- Consumes: `ProjectRowMenu` (Task 7), `ProjectNameEditor` (Task 8), `ProjectRemoveConfirm` (Task 9), the renderer verbs (Task 6), `useProjectsOwningLiveSessions` from `@stores/hive-store`.
- Produces:

```ts
interface ProjectsListProps {
  /** The config's own entries, in file order. */
  entries: readonly ProjectConfig[];
}
export function ProjectsList(props: ProjectsListProps): JSX.Element;
```

`ProjectRow` gains: `index: number`, `isDragging: boolean`, `onDragStart: () => void`, `onDragEnter: () => void`, `onDragEnd: () => void`, and `menu: ReactNode` replacing `onRemove`/`removeBlockedBy`. It becomes presentational — every decision moves up into `ProjectsList`.

- [ ] **Step 1: Write the failing tests**

`projects-list.test.tsx`. The preamble reuses what `projects-section.test.tsx` already established — copy them from there rather than writing new ones:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  chooseProjectDirectory,
  removeProjectFromConfig,
  renameProjectInConfig,
  reorderProjectsInConfig,
  repointProjectInConfig,
} from '@/lib/project-config';
import type { ProjectConfig } from '@shared/config-contract';

import { ProjectsList } from '@features/settings/components/projects-list';
import { useProjectsOwningLiveSessions } from '@stores/hive-store';

// Partial mock, the pattern projects-section.test.tsx uses: the module's
// snapshot plumbing stays real, only the bridge-touching verbs are faked.
vi.mock('@/lib/project-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/project-config')>()),
  chooseProjectDirectory: vi.fn().mockResolvedValue('/tmp/picked'),
  addProjectToConfig: vi.fn(),
  removeProjectFromConfig: vi.fn(),
  renameProjectInConfig: vi.fn(),
  repointProjectInConfig: vi.fn(),
  reorderProjectsInConfig: vi.fn(),
}));

vi.mock('@stores/hive-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stores/hive-store')>()),
  useProjectsOwningLiveSessions: vi.fn().mockReturnValue([]),
}));

/** The `entry()` factory from projects-section.test.tsx:31-38. */
const entry = (id: string): ProjectConfig => ({
  id,
  name: id,
  path: `/tmp/${id}`,
  icon: 'ph-folder',
  origin: 'local',
  status: 'ok',
  isRepo: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useProjectsOwningLiveSessions).mockReturnValue([]);
  vi.mocked(chooseProjectDirectory).mockResolvedValue('/tmp/picked');
});

describe('ProjectsList', () => {
  it('reorders with Move down and posts the whole new order', async () => {
    render(<ProjectsList entries={[entry('a'), entry('b'), entry('c')]} />);

    await userEvent.click(screen.getByRole('button', { name: /actions for a/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /move down/i }));

    expect(reorderProjectsInConfig).toHaveBeenCalledWith({ ids: ['b', 'a', 'c'] });
  });

  it('reorders with Move up', async () => {
    render(<ProjectsList entries={[entry('a'), entry('b'), entry('c')]} />);

    await userEvent.click(screen.getByRole('button', { name: /actions for c/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /move up/i }));

    expect(reorderProjectsInConfig).toHaveBeenCalledWith({ ids: ['a', 'c', 'b'] });
  });

  it('reorders by dragging a row onto another', () => {
    render(<ProjectsList entries={[entry('a'), entry('b'), entry('c')]} />);
    const rows = screen.getAllByRole('listitem');

    fireEvent.dragStart(rows[0]!);
    fireEvent.dragEnter(rows[2]!);
    fireEvent.dragEnd(rows[0]!);

    expect(reorderProjectsInConfig).toHaveBeenCalledWith({ ids: ['b', 'c', 'a'] });
  });

  it('writes nothing when a drag ends where it began', () => {
    render(<ProjectsList entries={[entry('a'), entry('b')]} />);
    const rows = screen.getAllByRole('listitem');

    fireEvent.dragStart(rows[0]!);
    fireEvent.dragEnter(rows[0]!);
    fireEvent.dragEnd(rows[0]!);

    expect(reorderProjectsInConfig).not.toHaveBeenCalled();
  });

  it('renames through the editor', async () => {
    render(<ProjectsList entries={[entry('a')]} />);

    await userEvent.click(screen.getByRole('button', { name: /actions for a/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /rename/i }));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), 'Renamed{Enter}');

    expect(renameProjectInConfig).toHaveBeenCalledWith({ id: 'a', name: 'Renamed' });
  });

  it('re-points through the native dialog, and writes nothing when cancelled', async () => {
    vi.mocked(chooseProjectDirectory).mockResolvedValueOnce(null);
    render(<ProjectsList entries={[entry('a')]} />);

    await userEvent.click(screen.getByRole('button', { name: /actions for a/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /change folder/i }));

    expect(repointProjectInConfig).not.toHaveBeenCalled();
  });

  it('confirms before removing a project that owns live sessions', async () => {
    vi.mocked(useProjectsOwningLiveSessions).mockReturnValue(['a']);
    render(<ProjectsList entries={[entry('a')]} />);

    await userEvent.click(screen.getByRole('button', { name: /actions for a/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /remove/i }));

    expect(removeProjectFromConfig).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    expect(removeProjectFromConfig).toHaveBeenCalledWith({ id: 'a' });
  });

  it('removes a project with no live sessions in one click', async () => {
    vi.mocked(useProjectsOwningLiveSessions).mockReturnValue([]);
    render(<ProjectsList entries={[entry('a')]} />);

    await userEvent.click(screen.getByRole('button', { name: /actions for a/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /remove/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(removeProjectFromConfig).toHaveBeenCalledWith({ id: 'a' });
  });

  it('writes nothing when the confirmation is cancelled', async () => {
    vi.mocked(useProjectsOwningLiveSessions).mockReturnValue(['a']);
    render(<ProjectsList entries={[entry('a')]} />);

    await userEvent.click(screen.getByRole('button', { name: /actions for a/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /remove/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(removeProjectFromConfig).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
```

`project-row.test.tsx` — closes the mirror gap flagged in the spec: renders name, detail and the `no git` tag; the drag grip carries an accessible label; `onDragStart` fires on `dragStart`; the row is `draggable`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && pnpm vitest run tests/features/settings/`
Expected: FAIL — `projects-list` not found.

- [ ] **Step 3: Implement `ProjectsList`**

State, all local (the rule 101 and 102 both used):

```ts
const [draggingId, setDraggingId] = useState<string | null>(null);
const [dropIndex, setDropIndex] = useState<number | null>(null);
const [mode, setMode] = useState<{ id: string; kind: 'rename' | 'confirm-remove' } | null>(null);
```

The preview order is **computed, never stored** — that is the spec's rule, so the snapshot stays the single source of truth:

```ts
/**
 * The order to paint right now.
 *
 * Derived from the drag rather than held in state: an optimistic copy of the
 * list would have to be reconciled when the write returns, and the whole point
 * of every verb returning a snapshot is that the renderer never holds a list
 * the write already invalidated.
 */
const ordered = useMemo(() => {
  if (draggingId === null || dropIndex === null) return entries;
  const from = entries.findIndex((entry) => entry.id === draggingId);
  if (from === -1 || from === dropIndex) return entries;
  const next = [...entries];
  const [moved] = next.splice(from, 1);
  next.splice(dropIndex, 0, moved!);
  return next;
}, [entries, draggingId, dropIndex]);
```

`onDragEnd` posts `reorderProjectsInConfig({ ids: ordered.map((e) => e.id) })` only when the order actually differs from `entries`, then clears both drag fields. `move(id, delta)` builds the same payload for the menu items. The container is a `<ul role="list">` and each row a `<li role="listitem">` so the tests' `getAllByRole('listitem')` works and the list is announced as one.

`onRepoint` awaits `chooseProjectDirectory()` and returns early on `null` — the same shape `onAdd` already uses in `projects-section.tsx:80-84`.

`onRemove` reads `useProjectsOwningLiveSessions()`: if the id is in it, set `mode` to `confirm-remove`; otherwise call `removeProjectFromConfig` straight away.

Then reduce `project-row.tsx` to presentation, and in `projects-section.tsx` replace the `rows.map(...)` block with `<ProjectsList entries={declared} />`, deleting the now-unused `onRemove`, `rows` and `owningLiveSessions`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && pnpm vitest run tests/features/settings/`
Expected: PASS, including the extended `projects-section.test.tsx`.

- [ ] **Step 5: Commit**

```bash
cd app && pnpm lint && pnpm type-check && pnpm verify:boundaries
cd .. && git add app/src/features/settings app/tests/features/settings
git commit -m "feat(settings): drag-reorder, rename and re-point in the projects list (HIVE-55)"
```

---

### Task 11: End-to-end proof

**Files:**
- Create: `app/tests/e2e/electron/manage-projects.spec.ts`
- Modify: `app/tests/e2e/electron/security.spec.ts` (the asserted preload surface, ~line 130)

**Interfaces:**
- Consumes: `launchHive({ userDataDir, configPath })` from `tests/e2e/electron/fixtures/hive-app.ts`; the `showOpenDialog` main-process stub pattern documented in `settings.spec.ts:8-24`.

- [ ] **Step 1: Write the failing spec**

Read `settings.spec.ts` first — reuse its `launchWithConfig` helper and its main-process dialog stub verbatim rather than inventing a second one. Cases:

1. **Reorder by drag** — seed a config with three projects, open Settings, `rows.nth(0).dragTo(rows.nth(2))`, then assert **both** that `config.json` on disk lists the new order and that the left rail's project order matches.
2. **Reorder by menu** — `Move up` on the last row produces the same file order as the equivalent drag.
3. **Rename** — rename through the menu, assert the rail label changes and the name survives `config.reload()`.
4. **Re-point** — stub `showOpenDialog` to return a second seeded directory, use `Change folder…`, assert the written `path` is the new one and `origin` is unchanged.
5. **Remove with confirmation** — seed a project owning a live session, choose `Remove`, assert the confirmation appears and that cancelling leaves `config.json` byte-identical, then confirm and assert the entry is gone.

- [ ] **Step 2: Run the spec to verify it fails**

Run: `cd app && pnpm test:e2e:electron -- manage-projects`
Expected: FAIL — the UI does not exist in the built app yet, or the assertions fail.

- [ ] **Step 3: Build and make it pass**

Run `pnpm desktop:build` first — the electron e2e project drives the built app, not the dev server. Fix whatever the spec catches. Add the three verb names to `security.spec.ts`'s expected `window.hive.config` key list.

- [ ] **Step 4: Run the full e2e suite**

Run: `cd app && pnpm desktop:build && pnpm test:e2e:electron`
Expected: PASS — including the pre-existing `settings.spec.ts`, `clone-repo.spec.ts` and `security.spec.ts`.

- [ ] **Step 5: Commit**

```bash
cd .. && git add app/tests/e2e
git commit -m "test(settings): e2e proof for managing projects (HIVE-55)"
```

---

### Task 12: Documentation repair

**Files:**
- Modify: `stories/README.md`

- [ ] **Step 1: Add the missing index rows**

In `## Index`, after the story 101 row:

```markdown
| 102 | [Add a remote repository by URL](100-settings-epic.md) | Settings | 8 |
| 103 | [Manage projects: rename, re-point, reorder](100-settings-epic.md) | Settings | 5 |
```

Both link to the epic, because neither has a story file — 102's spec and 103's live under `docs/superpowers/specs/`. Update the totals sentence beneath the table to match.

- [ ] **Step 2: Correct the Jira mapping**

Replace the Settings row of the `## Jira` table (~line 115) with:

```markdown
| **Settings** | HIVE-51 | 100→the Epic's own description, 101→HIVE-52, 102→HIVE-54, 103→HIVE-55, 104→HIVE-56, 105→HIVE-57, 106→HIVE-58, 107→HIVE-59, 108→HIVE-60. Stories 102 and 103 have no story file; their specs live in `docs/superpowers/specs/` |
```

- [ ] **Step 3: Update the Settings graph caption**

The caption at ~line 232 says only 100 and 101 are written in full. Amend it to record that 102 and 103 shipped design docs instead.

- [ ] **Step 4: Verify and commit**

Confirm no other line still claims 102–108 lack Jira issues:

```bash
grep -n "no Jira issue\|not yet written" stories/README.md
```

```bash
git add stories/README.md
git commit -m "docs(stories): index and Jira mapping for stories 102 and 103 (HIVE-55)"
```

---

### Task 13: Record the settled spec in Jira

The spec's reconciliation finding 6 commits to this, and `stories/README.md:127`
requires it: *"when a story changes here, update its Jira issue too; nothing syncs
automatically."* Use the `jira-writer:jira-writer` skill — never raw REST or curl.

**Files:** none. This task touches Jira only, so it produces no commit.

- [ ] **Step 1: Append UPDATED SPECS to HIVE-55**

Use `jira-writer update_issue HIVE-55 '{}' --desc-file <path> --append` so the existing
rich description survives. Record, in the same voice the HIVE-54 block uses:

- Settings lists the config's projects, not the merged list — so demo rows are not orderable.
- The merge retains fixtures owning *any* session; the remove gate tests *live* ones. The ticket's wording conflated them.
- Reorder posts the whole ordered id list and main requires it to be a permutation of the file on disk.
- Rename edits `name` only; `id` is never rewritten.
- Re-point preserves `origin` by construction, and stores the path as the user wrote it.
- Removing a project does not kill its sessions; they keep running, unresolved. That is what the confirmation says.
- Drag is hand-rolled HTML5 with no new dependency; *Move up* / *Move down* in the row menu are the keyboard path.
- The link to this PR and to `docs/superpowers/specs/2026-08-04-hive-55-manage-projects-design.md`.

- [ ] **Step 2: Note the scope growth on HIVE-60 (story 108)**

Add a comment, not a description rewrite — 108's own spec is still unwritten:
its settings e2e and config-write conformance now have three more mutating verbs
to cover (`config:rename-project`, `config:repoint-project`,
`config:reorder-projects`), and the permutation check is the interesting case.

- [ ] **Step 3: Verify both landed**

```bash
jira-writer get_issue HIVE-55 --summary-only
jira-writer get_issue HIVE-60 --summary-only
```

---

## Final verification

- [ ] `cd app && pnpm lint`
- [ ] `cd app && pnpm type-check`
- [ ] `cd app && pnpm test:coverage` — 80% gate on lines, statements, branches, functions
- [ ] `cd app && pnpm verify:boundaries` — all zones still fire
- [ ] `cd app && pnpm desktop:build && pnpm test:e2e:electron`
- [ ] Drive the built app by hand: rename a project, drag it, re-point it, remove one with a live session. The spec's acceptance criteria are the checklist.
