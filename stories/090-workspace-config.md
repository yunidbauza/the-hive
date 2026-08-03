# 090 — Workspace Config & Real Project Paths

| | |
|---|---|
| **ID** | HIVE-090 |
| **Epic** | Real terminals |
| **Depends on** | [082-preload-ipc-security.md](082-preload-ipc-security.md) |
| **Blocks** | [092](092-pty-session-manager.md), [096](096-session-lifecycle-claude.md), [097](097-orchestrator-drives-ptys.md) |
| **Points** | 3 |
| **Location** | `app/electron/main/config/`, `app/electron/shared/config-contract.ts` |

## Story

> As a user, I want to tell The Hive where my repositories actually live, so a session
> opens a terminal **in the right directory on my machine** instead of in a fixture.

A PTY needs a `cwd`. This is the smallest thing that makes one real.

## Scope discipline

This story adds a config file and nothing else. It does **not** add git integration,
a filesystem watcher, project discovery by scanning, or a settings UI. Branch names,
dirty state, tickets, PRs, inbox items and the activity feed all keep coming from
`src/data` fixtures ([012](012-mock-data-layer.md)).

The whole point is to make PTYs genuinely useful with the minimum real-world surface,
so the rest of this epic can be about terminals.

## The file

`~/.hive/config.json`, overridable by `HIVE_CONFIG_PATH` (the escape hatch
[085](085-electron-test-harness.md) needs for isolated test runs).

```jsonc
{
  "version": 1,
  "shell": "/bin/zsh",                       // optional; defaults to $SHELL
  "claudeCommand": "claude",                 // optional; the bootstrap command (096)
  "projects": [
    { "id": "apfm-web", "path": "~/repos/apfm-web" },
    { "id": "grace-api", "path": "/Users/me/work/grace-api" }
  ]
}
```

`id` **matches an existing fixture project id**. That is the whole mapping: the left
rail keeps rendering fixture projects, and a project that also appears here gains the
ability to host a real session. A fixture project with no mapping is not an error — it
is simply not spawnable, and says so.

## Resolution and validation

Read once at startup in the main process, and on an explicit reload. Each entry is
resolved and validated before it is trusted:

1. **Expand `~`** to `os.homedir()`. Do not shell out for this.
2. **Require the result to be absolute** after expansion. A relative path would resolve
   against the app's cwd, which is meaningless to the user.
3. **`realpath`** it — resolve symlinks once, up front, so the path handed to
   `node-pty` is the one that was validated and not a link that moved.
4. **Require it to exist and be a directory.**
5. **Reject duplicate ids**, keeping the first and reporting the rest.

A failing entry **disables that project and is reported**; it does not throw. One
mistyped path must not stop the app from launching — but it must be visible, because a
silently dropped project looks like a bug in the app rather than a typo in a file.

Validation results are exposed to the renderer as part of the config snapshot:

```ts
interface ProjectConfig {
  id: string;
  path: string | null;                 // resolved, or null when unusable
  status: 'ok' | 'missing' | 'not-a-directory' | 'not-absolute' | 'duplicate-id';
}
```

Payload guards follow [082](082-preload-ipc-security.md)'s rule — hand-written type
guards, no casts, and the same `__proto__` rejection. The config file is user-authored
input arriving from disk; it gets the same treatment as input arriving from the
renderer.

## First run

No config file is the normal state on first launch, not an error. On startup, if the
file is absent:

- create `~/.hive/` and write a **commented template** with an empty `projects` array
  and the defaults spelled out;
- log the path once;
- carry on.

The renderer then shows the unconfigured state below. Writing a template beats an empty
file: the user opens it and can see the shape without finding documentation.

## Renderer surface

One new verb on the bridge — `window.hive.config.get()` — returning the validated
snapshot, plus `config.reload()`.

Consistent with [083](083-runtime-target-transport.md)'s "degrade visibly" rule, the
capability predicate gains a project-level answer:

```ts
can.spawnSessionIn(projectId)   // desktop AND project mapped AND status === 'ok'
```

| Situation | What the user sees |
|---|---|
| Project mapped and valid | normal; sessions spawnable |
| Project unmapped | project row shows a muted `unmapped` badge; create disabled, tooltip names `~/.hive/config.json` |
| Project mapped but invalid | `unmapped` badge in `--cc-amber`, tooltip carries the `status` reason verbatim |
| No config file at all | one-line notice in the picker pointing at the template that was just written |

Reusing `badge.tsx` and existing tokens — no new atoms.

## Tests

`tests/electron/main/config/`:

- `~` expands; a relative path is rejected as `not-absolute`.
- A symlinked project resolves to its target.
- Missing path → `missing`; a file where a directory is expected → `not-a-directory`.
- Duplicate ids → first wins, second reported.
- Malformed JSON → app still starts, every project unusable, error reported once.
- `__proto__` in the JSON does not pollute the resulting object.
- Absent file → template written, parsed clean on the next read.
- `HIVE_CONFIG_PATH` takes precedence over `~/.hive/config.json`.

Renderer-side (`tests/features/…`): unmapped and invalid projects render their badge
and disable the create action.

## Acceptance criteria

- [ ] A fresh machine with no config launches, writes the template, and reports it.
- [ ] A valid config makes its projects spawnable; `cwd` for a session is the resolved
      real path.
- [ ] Every invalid entry surfaces its specific reason in the UI without blocking launch.
- [ ] `config.reload()` picks up an edit without restarting the app.
- [ ] `HIVE_CONFIG_PATH` isolates a test run from the developer's real config.
- [ ] Fixture data for branches, tickets, PRs and the feed is unchanged — prove with an
      empty `git diff` on `src/data/`.

## Out of scope

- A settings UI, project picker, or "add folder" dialog.
- Reading real git state — branch, dirty, worktrees. Still fixtures.
- Watching the config file for changes (explicit reload only).
- Per-project environment variables or per-project shells. One shell, app-wide.

## UPDATED SPECS

Three deviations, found by reconciling this story against the code as it stands
after 082/083 and confirmed before implementation.

### 1. The badge is `Tag`, not `Badge`

The story says "reusing `badge.tsx` and existing tokens — no new atoms". `Badge`
takes a `count: number` and **returns `null` at zero** (`src/components/ui/badge.tsx`)
— it is a counter and cannot carry a word. `Tag` is the atom that carries a word at
badge scale, and it already has the `amber` tone this story asks for.

**Resolution: follow the code.** The badge is a `Tag`. Still no new atoms; `Tag`
gained an optional `title` prop, mirroring its sibling `Chip`, which already had one.

### 2. The badge and the disabled action live in different places

The story's table implies one surface showing both a badge and a disabled create
action. The left rail's project row (`src/features/projects/components/project-row.tsx`)
has **no create action** — the whole row is a collapse toggle. The only surface that
starts a session is the new-session picker.

**Resolution: split them.** The rail row carries the `unmapped` badge and its
tooltip (display only). The picker's pinned pills and search rows carry the disabled
state, the tooltip, and — on a first run — a one-line notice naming the file.

### 3. `can.spawnSessionIn` is permissive with no config loaded

The story defines it as `desktop AND project mapped AND status === 'ok'`. Applied
literally, the browser demo maps nothing, so **every** project becomes unspawnable,
the picker's main flow disappears, and five of the six Playwright web specs fail —
which story 083 explicitly names as the signal that the gate is wrong rather than
the specs. Story 083's own `can` block already records that decision for
`spawnSession`.

**Resolution: permissive with no snapshot.** The predicate answers from the config
snapshot alone: no snapshot, every project spawnable. That covers both the browser
demo (no bridge to ask) and the first frames of a desktop launch (the read has not
landed), the second of which also avoids flashing every project as unmapped on every
start. On desktop with a config loaded it behaves exactly as the story specifies.

### 4. Superseded by the Settings epic (100 / 101)

Two rules in this story are **reversed** by
[100-settings-epic.md](100-settings-epic.md) and implemented by
[101-settings-add-local-project.md](101-settings-add-local-project.md). Recorded
here so this file cannot be read as current on either point.

**The `id` no longer has to match a fixture project id.** This story's mapping —
*"`id` matches an existing fixture project id. That is the whole mapping."* — is
what makes it impossible to add a repository the fixtures never invented. From
101 the config **declares** projects (`id`, `name`, `path`, `icon`, `origin`) and
the fixture list becomes the fallback rather than the schema. The merge rule is
in [100](100-settings-epic.md).

**A settings UI is no longer out of scope.** This story's *"Out of scope"* entry
— *"A settings UI, project picker, or 'add folder' dialog"* — was correct while
the job was to make PTYs useful with the minimum real-world surface. That job is
done, and the cost is now visible: the only onboarding a new user gets is the
console line this story writes.

Everything else here stands. The file location, the `HIVE_CONFIG_PATH` escape
hatch, the resolution and validation sequence, the per-entry failure model, and
`projectAccess`'s permissive-with-no-snapshot rule are all unchanged — 101 adds
a writer beside the reader rather than replacing it, and reuses this story's
validation as the gate on everything the renderer sends.

### Notes

- `HIVE_CONFIG_PATH` needed no new plumbing — story 085's Playwright fixture
  already sets it (`tests/e2e/electron/fixtures/hive-app.ts`).
- Config-file comments are `"//"`-prefixed keys. JSON has no comment syntax, and
  this repo's `package.json` already documents its `pnpm` block the same way.
- The bridge grew a `config` key, so story 082's surface allowlist
  (`BRIDGE_KEYS`) and both surface tests were updated. That alarm firing is the
  test working, not a regression.
