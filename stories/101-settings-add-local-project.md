# 101 — Settings: Add a Local Project Folder

| | |
|---|---|
| **ID** | HIVE-101 |
| **Epic** | Settings |
| **Depends on** | [082-preload-ipc-security.md](082-preload-ipc-security.md), [090-workspace-config.md](090-workspace-config.md), [096-session-lifecycle-claude.md](096-session-lifecycle-claude.md) |
| **Blocks** | [102](100-settings-epic.md), [103](100-settings-epic.md), [104](100-settings-epic.md), [105](100-settings-epic.md), [106](100-settings-epic.md), [107](100-settings-epic.md), [108](100-settings-epic.md) |
| **Points** | 13 |
| **Location** | `app/src/features/settings/`, `app/electron/main/config/write.ts`, `app/electron/shared/config-contract.ts`, `app/electron/shared/ipc-contract.ts`, `app/electron/shared/guards.ts` |

## Story

> As a user, I want to add one of my repositories to The Hive from inside the
> app, so that starting a session works on a fresh install without me finding
> and hand-writing a JSON file.

## What this replaces

The flow today, in full:

1. Launch the app. Open the picker. Every project is a demo project.
2. Start a session. `CH.ptySpawn` throws
   `cannot start a session in "apfm-web": it is not mapped to a usable directory
   in /Users/me/.hive/config.json` (`electron/main/ipc/index.ts`).
3. The only pointer to the fix was printed to a console at launch:
   `[hive] no workspace config found — wrote a template to …`
   (`electron/main/config/index.ts:67`).
4. Find the file, learn the schema from its comments, and discover that `id`
   must match a demo project — so a real repository cannot be added at all
   ([090](090-workspace-config.md)).

After this story: open Settings, click **Add project**, pick a folder, start a
session in it. Step 4 stops being a rule.

## Scope discipline

This story builds the **spine** of the epic — the overlay, the write path, the
schema, the bridge surface — and then uses it for exactly one thing: adding a
local directory. Nothing else gets a section.

**In:** the settings overlay and its section nav (one section populated), config
schema v2 and its migration, the atomic write path, three new bridge verbs, add
a folder, remove a project, and the empty state that routes the user here from
the picker.

**Out:** cloning a remote (102), rename / re-point / reorder (103), any of the
Runtime, Appearance, Integrations or Advanced sections (104–107). Those sections
do not appear in the nav yet either — a nav full of dead items teaches the user
that settings are broken.

**Remove is in, deliberately**, against the instinct to defer it. A surface that
can only add is one where the user's first typo becomes permanent until they go
back to editing JSON — which is the exact failure this story exists to end.

## The surface

A fifth view state, following the picker's shape exactly (see
[100](100-settings-epic.md) → *Decisions*):

```ts
// src/lib/resolve-view.ts
export type ViewState = 'settings' | 'picker' | 'orchestrator' | 'session' | 'agent';

export function resolveView({ activeTab, picker, settings, entity }: ViewInput): ViewState {
  if (settings) return 'settings';   // wins over the picker; see below
  if (picker) return 'picker';
  if (activeTab === ORCH_TAB) return 'orchestrator';
  if (!entity) return 'orchestrator';
  return entity.kind === 'agent' ? 'agent' : 'session';
}
```

`ui-store` gains `settings: boolean`, `openSettings()`, `closeSettings()`.
`openSettings()` **also clears `picker`** — the realistic route into settings is
the picker discovering it has nothing to offer, and two stacked overlays is the
result of not deciding this. Like the picker, settings **never touches
`activeTab`**: closing it returns the user to the terminal they were watching.

Ways in: a gear button in the header (`src/components/layout/header.tsx`),
`Cmd+,` (registered alongside story [060](060-keyboard-navigation.md)'s bindings),
and the picker's empty state. `Esc` closes it, matching the picker.

Layout — a section list on the left of the stage, content on the right:

```
┌──────────────────────────────────────────────────────────────┐
│  Settings                                                 ✕  │
├───────────────┬──────────────────────────────────────────────┤
│  Projects  ●  │  Projects                                    │
│               │  Repositories The Hive can open a session in │
│               │                                              │
│               │  ┌────────────────────────────────────────┐  │
│               │  │ ph-globe  apfm-web            demo     │  │
│               │  │           not a real directory         │  │
│               │  ├────────────────────────────────────────┤  │
│               │  │ ph-folder the-hive                  ✕  │  │
│               │  │           ~/Projects/behiques/the-hive │  │
│               │  └────────────────────────────────────────┘  │
│               │                                              │
│               │  [ + Add project ]                           │
│               │                                              │
│               │  Config file: ~/.hive/config.json            │
└───────────────┴──────────────────────────────────────────────┘
```

The section list ships with one item and is built for six. Tokens and atoms
only — `Tag` for the badges, `Icon`, `Tooltip`, existing `--cc-*` utilities. No
new atoms; if a colour is missing, add a token
([`AGENTS.md`](../app/AGENTS.md) → *Styling*).

New slice `src/features/settings/`, which **must be added to `FEATURE_SLICES` in
`app/eslint.config.mjs`** — a slice that is not listed gets no isolation zone and
silently becomes importable from everywhere.

## Config schema v2

```jsonc
{
  "version": 2,
  "shell": "/bin/zsh",
  "claudeCommand": "claude",
  "projects": [
    {
      "id": "the-hive",                              // stable; referenced by sessions
      "name": "The Hive",                            // display; editable in 103
      "path": "~/Projects/behiques/the-hive",        // as written by the user or the dialog
      "icon": "ph-folder",                           // phosphor name
      "origin": "local"                              // "local" | "cloned" (102)
    }
  ]
}
```

Added to `ProjectConfig` in `electron/shared/config-contract.ts`: `name`,
`icon`, `origin`. `id`, `path` and `status` are unchanged in meaning.

**Migration from v1.** A v1 file is read normally and each entry upgraded **in
memory**: `name` from the resolved directory's basename, `icon` from a default,
`origin: 'local'`. The file on disk is rewritten as v2 **only when the user
first saves something**. Reading a file and rewriting it before the user asked
for anything is a surprise, not a migration. A v1 file the user never edits
through the UI stays v1 forever and keeps working.

`parse.ts` accepts `version` 1 or 2 and rejects anything else with the existing
file-level error. `CONFIG_VERSION` becomes `2` and is what the writer emits.

### Project identity

`id` is derived once, from the directory basename, kebab-cased, `[a-z0-9-]`
only, truncated to 40 characters. A collision with an existing id gets a `-2`,
`-3` suffix. It is **never recomputed** — sessions reference projects by id
(`entity.project`), so an id that drifts when a folder is renamed would strand
them. The display `name` is what the user edits later (103); the id is
machinery.

## The write path

One function, `writeConfig`, in `app/electron/main/config/write.ts`. Every
mutation goes through it; there is no per-field patch.

```ts
type Mutation = (draft: ConfigFile) => ConfigFile;

export function writeConfig(mutate: Mutation): ConfigSnapshot;
```

1. **Re-read the file from disk.** Not the cached snapshot — the user may have
   edited it in a text editor since the app loaded, and writing the cache back
   would silently discard that.
2. **Apply the mutation in memory.**
3. **Validate the whole result** with the same `parseConfig` / `resolveProjects`
   the read path uses. A write that would produce a file the reader rejects is
   refused *before* anything touches disk. Reusing the reader is the point: two
   validators is one validator and one bug.
4. **Write atomically** — `writeFileSync` to `config.json.<pid>.tmp` in the same
   directory, then `renameSync` over the target. Same directory because `rename`
   is only atomic within a filesystem. A half-written config is the one failure
   that makes the app unlaunchable; `rename` makes it impossible.
5. **Return the fresh snapshot**, and update the module cache `getConfig()`
   reads, so main and renderer cannot disagree about what was just written.

**Comment keys and unknown top-level keys survive the round trip.** The template
is deliberately comment-heavy — `template.ts` explains that a `"//"`-prefixed key
is how this file documents itself — and a UI that ate those comments the first
time the user clicked a button would make hand-editing and the settings page
mutually exclusive. Concretely: parse to an object, mutate only `projects`
(and the keys a later story owns), re-serialise with `JSON.stringify(…, null, 2)`
and a trailing newline, preserving key order for keys that were already present
and appending new ones.

**On failure, nothing changes.** A write error returns a snapshot whose `errors`
carry the reason; the old file is still on disk and still valid. Consistent with
090's rule that nothing here throws at the user's data.

## Bridge surface

```ts
// electron/shared/ipc-contract.ts
config: {
  get(): Promise<ConfigSnapshot>;
  reload(): Promise<ConfigSnapshot>;
  /** Native directory dialog, owned by main. Returns null when cancelled. */
  chooseDirectory(): Promise<string | null>;
  addProject(request: AddProjectRequest): Promise<ConfigSnapshot>;
  removeProject(request: RemoveProjectRequest): Promise<ConfigSnapshot>;
}

export interface AddProjectRequest {
  /** A path the user chose. Re-validated in main; never trusted. */
  path: string;
  /** Optional display name. Defaults to the directory basename. */
  name?: string;
}

export interface RemoveProjectRequest { id: string }
```

Channels: `config:choose-directory`, `config:add-project`,
`config:remove-project`, added to `CH`. All three use `invoke` — every one needs
a result.

**Every mutating verb returns the fresh `ConfigSnapshot`**, so the renderer never
follows a write with a reload and can never render a stale list.

The doc comment on `HiveBridge.config` that reads *"there is no `set`, because a
settings UI that writes this file is out of scope and a bridge verb that can
write to disk is not something to add speculatively"* is **rewritten, not
deleted** — the reasoning was correct and the condition changed. The replacement
states what is now true: the bridge can write to exactly one file, main
re-validates everything, and no verb accepts a destination path.

`BRIDGE_CONFIG_KEYS` grows from `['get', 'reload']` to five entries.
`BRIDGE_KEYS` is unchanged. **Both surface tests will fail until updated — that
alarm firing is the test working**, exactly as story 090 recorded when it added
the `config` key.

### Validation

`parseAddProjectRequest` and `parseRemoveProjectRequest` go in
`electron/shared/guards.ts` alongside the PTY guards: hand-written, no casts,
`__proto__` rejected — story 082's rule, unchanged.

`chooseDirectory` **takes no payload**, so the `assertSender` check `handle`
already applies is its whole validation. It calls
`dialog.showOpenDialog(window, { properties: ['openDirectory'] })`.

`addProject` re-runs the **entire** 090 resolution on the incoming path —
expand `~`, require absolute, `realpath`, require an existing directory — before
it is written. The dialog is a UX step, not a capability grant: a renderer that
skipped the dialog and posted a path directly gets exactly the same treatment,
because main's validation is the actual gate. The alternative (main remembers
the last dialog result; `addProject` takes no path) was rejected: it makes the
flow stateful across two IPC calls and breaks the moment two dialogs race, while
buying nothing that main-side validation does not already provide.

## The merge rule

`useProjects()` (`src/stores/hive-store.ts:511`) stops returning the fixture list
directly:

| Situation | The list is |
|---|---|
| No snapshot — browser demo, first frames of launch | fixtures, unchanged |
| Snapshot with zero projects | fixtures, unchanged |
| Snapshot with projects | config's, **plus** fixture projects that still own live fixture sessions, marked `demo` |

`Project` (`src/types/entity.ts:40`) gains `name: string` and
`source: 'config' | 'demo'`. A config project and a fixture project sharing an
id collapse to one row and **config wins** — the upgrade path for anyone who
already mapped `apfm-web` under 090.

The third row is not politeness. The work panel, PRs panel, inbox and
orchestrator table all reference fixture sessions through `entity.project`;
dropping fixture projects the moment a real one is added would orphan all four.

The fixtures themselves are **not edited**. `src/data/fixtures.ts` ends this
story byte-identical — the merge is a selector, which is also what keeps
`src/data/` a store-only consumer.

## What the user sees when it goes wrong

| Situation | What happens |
|---|---|
| Dialog cancelled | nothing; no write, no error |
| Path is not a directory | row not added; inline error naming the path and the reason |
| Path already added | no duplicate; the existing row highlights briefly |
| Path is a directory but not a git repo | **added anyway**, with a muted `no git` tag. A PTY needs a `cwd`, not a repo; refusing here would be the app inventing a rule the shell does not have |
| Config file unwritable (permissions, read-only volume) | inline error carrying the OS message; the list is unchanged and the app keeps running |
| Removing a project that owns live sessions | out of scope here — 103 owns the confirmation. This story's remove is enabled only for projects with no live session, and the button is disabled with a tooltip otherwise |

## Files this touches

| File | Change |
|---|---|
| `electron/shared/config-contract.ts` | `name`/`icon`/`origin` on `ProjectConfig`; `CONFIG_VERSION = 2`; `AddProjectRequest`, `RemoveProjectRequest` |
| `electron/shared/ipc-contract.ts` | three channels, three bridge verbs, `BRIDGE_CONFIG_KEYS`, the rewritten doc comment |
| `electron/shared/guards.ts` | `parseAddProjectRequest`, `parseRemoveProjectRequest` |
| `electron/main/config/write.ts` | **new** — `writeConfig`, atomic, comment-preserving |
| `electron/main/config/parse.ts` | accept `version` 1 or 2; parse the new entry fields |
| `electron/main/config/index.ts` | v1→v2 in-memory upgrade; `addProject`/`removeProject` on top of `writeConfig` |
| `electron/main/ipc/index.ts` | register the three handlers |
| `electron/preload/index.ts` | expose the three verbs |
| `src/features/settings/**` | **new slice** — overlay, section nav, projects section, project row |
| `eslint.config.mjs` | `'settings'` in `FEATURE_SLICES` |
| `src/lib/resolve-view.ts` | the `settings` state and its precedence |
| `src/stores/ui-store.ts` | `settings` flag, `openSettings` (clears `picker`), `closeSettings`, selector hooks |
| `src/stores/hive-store.ts` | `useProjects()` merge rule |
| `src/types/entity.ts` | `Project` gains `name`, `source` |
| `src/lib/project-config.ts` | `addProject`/`removeProject` wrappers; snapshot updated from the verb's return |
| `src/components/layout/center-stage.tsx` | mount the overlay |
| `src/components/layout/header.tsx` | the gear |
| `src/features/sessions/components/new-session-picker.tsx` | empty state becomes an **Add project** button instead of naming a file path |

## Tests

`tests/` mirrors `src/`; the 80% gate applies
([013](013-testing-infrastructure.md)).

**`tests/electron/main/config/write.test.ts`** (new)

- A write produces a file `parseConfig` reads back identically — round trip.
- `"//"` comment keys and an unknown top-level key survive a write.
- A mutation producing an invalid file is refused and the file on disk is
  byte-identical afterwards.
- The temp file is created in the target's directory and does not survive.
- A failed `rename` leaves the original intact and reports in `errors`.
- The write re-reads from disk: an out-of-band edit made after load is not
  clobbered.

**`tests/electron/main/config/index.test.ts`** (extend)

- `addProject` expands `~`, rejects a relative path, rejects a file, rejects a
  missing directory — each returning a snapshot with the reason, no write.
- Adding an existing path is a no-op, not a duplicate.
- id derivation: basename kebab-cased; collision gets `-2`.
- A v1 file reads with `name`/`icon`/`origin` defaulted, and is **not** rewritten
  until a mutation happens; the first mutation writes `version: 2`.
- `removeProject` drops exactly one entry; an unknown id is a no-op with an error.

**`tests/electron/shared/guards.test.ts`** (extend) — `__proto__` in an
`AddProjectRequest` is rejected; a non-string `path` is rejected.

**`tests/electron/preload/*.test.ts`** and the bridge surface test — updated
`BRIDGE_CONFIG_KEYS`.

**`tests/lib/resolve-view.test.ts`** — exhaustive over the fifth state, including
`settings` beating `picker`.

**`tests/stores/ui-store.test.ts`** — `openSettings` clears `picker` and leaves
`activeTab` untouched; `closeSettings` restores nothing (nothing was changed).

**`tests/stores/hive-store.test.ts`** — the three merge-rule rows; the id
collision collapsing to one row with config winning.

**`tests/features/settings/components/*.test.tsx`** — the projects section
renders config and demo rows distinctly; **Add project** calls `chooseDirectory`
then `addProject` with the returned path; a cancelled dialog writes nothing; an
error snapshot renders its reason; remove is disabled with a tooltip for a
project with live sessions.

**`tests/e2e/electron/settings.spec.ts`** (new) — against a `HIVE_CONFIG_PATH`
sandbox and a `tmpdir` repo, with `dialog.showOpenDialog` stubbed in main:
open settings, add the folder, see it in the left rail, close settings, open the
picker, and confirm the project is spawnable. This is the only proof that the
whole slice works; the unit tests prove the pieces.

## Acceptance criteria

- [ ] On a machine with no config, launching the app and opening the picker
      offers **Add project**, which opens Settings — the user never has to read a
      console line or find a JSON file.
- [ ] Choosing a directory adds it, and it appears in the left rail and the
      picker with its real name; no restart, no manual reload.
- [ ] A session started in that project opens a PTY whose `cwd` is the resolved
      real path, and `claude` bootstraps there ([096](096-session-lifecycle-claude.md)).
- [ ] Removing a project removes exactly that entry and leaves every other line
      of the file, including its comments, byte-identical.
- [ ] A config file hand-written under 090 (v1, ids matching fixture projects)
      still loads, still works, and is not rewritten until the user changes
      something through the UI.
- [ ] Killing the app mid-write leaves a valid config: either the old content or
      the new, never a partial file.
- [ ] `src/data/fixtures.ts` is unchanged — prove with an empty `git diff` on
      `app/src/data/`.
- [ ] `pnpm lint`, `pnpm type-check`, `pnpm test:coverage` and
      `pnpm verify:boundaries` all pass, with `settings` registered in
      `FEATURE_SLICES`.

## Out of scope

- Cloning a remote repository (102).
- Renaming, re-pointing, or reordering projects (103).
- Any other settings section (104–107) — including the nav items for them.
- Reading real git state for the added project. Branch and dirty stay fixtures.
- Watching the config file. Explicit reload only, as 090 decided and 107 owns.
- Per-project shell or env (104).

## Supersedes

Story [090](090-workspace-config.md) is updated, in its own `UPDATED SPECS`
idiom, for two rules this story reverses: *"`id` matches an existing fixture
project id"* and the "Out of scope" entry *"a settings UI, project picker, or
add-folder dialog."* Both were correct for a story whose job was to make PTYs
useful with the minimum real-world surface. That job is done.
