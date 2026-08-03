# HIVE-52 — Settings: Add a Local Project Folder (story 101)

**Goal:** a user on a fresh install opens Settings, clicks **Add project**, picks
a folder, and starts a session in it. No console line, no hand-written JSON, no
rule that the project id must match a demo fixture.

**Base spec:** [`stories/101-settings-add-local-project.md`](../../../stories/101-settings-add-local-project.md)
(405 lines) is the story, and it stands. This document records only what
reconciliation and brainstorming **changed or added** on top of it. Where the two
disagree, this document wins; where this document is silent, the story spec is
the instruction.

**Sibling stories 102 and 103 are unwritten.** Both HIVE-54 and HIVE-55 open with
"Placeholder for a spec, not a spec" and neither has a story file. 101 ships alone,
as the epic's sequencing section requires.

## Reconciliation decisions

Confirmed with the reporter before any code was written. Each is a place where
the ticket describes a codebase that no longer exists, or leaves a decision the
implementation cannot avoid making.

### 1. The merge rule's justification names the wrong panels

The spec defends keeping fixture projects by saying that dropping them "would
orphan the work panel, the PR panel, the inbox and the orchestrator table". Two of
those four are wrong: the **inbox** reads no `project` at all, and the **PRs
panel** reads `pr.repo` off a global fixture list (`pr-card.tsx:51`), never
`entity.project`.

The surfaces that genuinely depend on fixture projects are the projects panel, the
work panel (rows and ticket PRs), the orchestrator table and its console `ls`,
and — **omitted from the spec entirely** — `src/lib/terminal/resolve-transport.ts:81`,
which is the actual spawn path.

**Resolution: follow the code.** The merge rule itself is unchanged and still
correct. Only its rationale is corrected, and the omitted call site is the one
that would have hurt: a session whose project vanished from the list loses its
transport, not just a row.

### 2. The spawn-failure quote is stale

"What this replaces" step 2 quotes `cannot start a session in "apfm-web": it is
not mapped to a usable directory in …` and attributes it to
`electron/main/ipc/index.ts`. That string does not exist in the repo. Story 097
moved every refusal into the sessions layer.

The real message is built at `electron/shared/session-contract.ts:91` —
`apfm-web is not mapped — add it to /Users/me/.hive/config.json` — and thrown from
`electron/main/sessions/index.ts:297`.

**Resolution: follow the code.** Documentation-only; no behaviour changes. The
ticket description is corrected so the next reader is not sent to a file that has
not thrown that error since 097.

### 3. `chooseDirectory` resolves its parent window from the event

The spec writes `dialog.showOpenDialog(window, { properties: ['openDirectory'] })`,
but there is no `window` in scope and no `mainWindow` singleton anywhere in main.
Both `ipc/index.ts:92` and `lifecycle.ts:44` resolve windows per-call via
`BrowserWindow.getAllWindows()`, deliberately: on macOS the window can be closed
and re-created, so a captured reference goes stale.

**Resolution: `BrowserWindow.fromWebContents(event.sender)`.** The `handle`
wrapper already passes the event, `assertSender` has already proven the sender is
the main frame, and this attaches the sheet to the window that actually asked —
strictly more correct than index 0 of all windows. A `null` return (window
destroyed mid-call) is treated as a cancelled dialog.

### 4. `Cmd+,` is deferred to story 060

The spec says `Cmd+,` is "registered alongside story 060's bindings". **Story 060
was never implemented** — there is no keyboard-binding registry in the codebase.
Worse, `center-stage.tsx:118-130` records that a bare `window` keydown listener
was tried and rejected, because it fired for keystrokes originating inside text
fields.

**Resolution: cut `Cmd+,` from this story.** The gear button and the picker empty
state are the ways in, and every acceptance criterion that mentions reaching
Settings is satisfied by them. Building the registry correctly is 060's job;
bolting a naked listener onto this story would repeat a mistake the codebase has
already made once and documented.

### 5. `Icon` cannot render `ph-folder`

`src/components/ui/icon.tsx:1-23` is a hardcoded allowlist of about twenty
Phosphor names and has no `Folder`. Schema v2's default icon is unrenderable as
specified.

**Resolution: follow the ticket, extend the code.** Add `Folder` to the map. One
import, one map entry. `GlobeHemisphereWest` is already present for the demo rows.

### 6. `ConfigSnapshot.errors` is a flat `string[]`

`config-contract.ts:45-69`. The spec's "a snapshot whose `errors` carry the
reason" is satisfied by the existing shape. Recorded so no structured error type
gets invented mid-implementation.

### 7. Story 090's id-matching rule is documentation only

The rule this story supersedes — *"`id` matches an existing fixture project id"* —
is **never enforced in code**. `parse.ts:166` checks token shape via `assertId`
and nothing more, and `electron/main/**` structurally cannot import fixtures.

**Consequence:** "Supersedes" is a docs and merge-rule change. There is no
validator to remove, and no config file that was previously rejected will start
being accepted. Less work than the spec implies, and worth knowing before
planning.

## Design decisions

### The projects list is a bordered card, in both states

Three treatments were rendered at true app proportions in the real `--cc-*`
tokens, populated and empty. **Chosen: the card, present in both states** — a
dashed border with the empty message inside when there are no projects, a solid
border with hairline dividers between rows when there are.

One container for both states is the simplest rule the code can hold, and it is
the state that matters: a fresh install is the entire reason this story exists,
and a bordered box saying *"No projects yet. Add a folder to start a session in
it."* reads as a furnished, empty place rather than a rendering failure. The
alternative treatments — flat hairline rows, and rows grouped by config-vs-demo —
were rejected: the first leaves a heading floating above a button when empty, and
the second spends structure on a distinction that disappears once the demo data
does, while starting story 103's work early.

Row anatomy, unchanged from the story spec: icon, then name over path, then any
tags (`demo`, `no git`), then remove. Tokens and existing atoms only — `Tag`,
`Icon`, `Tooltip`, `--cc-*` utilities. No new atoms.

### `isRepo` is derived in main and never persisted

The spec's error table requires a directory that is not a git repo to be "added
anyway, with a muted `no git` tag", but schema v2 has nowhere to put that fact and
`ProjectStatus` has no repo notion. The renderer has no filesystem access, so it
cannot compute it.

**Resolution: a derived, non-persisted `isRepo: boolean`** on `ProjectConfig`,
computed in `resolve.ts` next to the existing `realpath`/`isDirectory` checks.
`ProjectConfig` is already the *resolved* shape rather than the file's shape — it
carries `status`, which is likewise computed on load and never written — so
`isRepo` joins an existing category rather than introducing one:

```ts
return { path: real, status: 'ok', isRepo: existsSync(join(real, '.git')) };
```

It is returned on the snapshot and never written to `config.json`. Keeping it out
of the file means a hand-edited config cannot lie about it, and it stays true
across a repo being `git init`-ed after it was added — the next load recomputes.

`.git` is checked with `existsSync` rather than `statSync().isDirectory()` on
purpose: in a git **worktree** or a submodule, `.git` is a *file* containing a
`gitdir:` pointer, and a directory-only check would report the repo this project
is developed in as not a repo.

### The merged list preserves config array order

`useProjects()` returns config projects **in the order the file lists them**,
never sorted, with demo projects appended. Story 103's drag-reorder works by
rewriting the order of the `projects` array, and the left rail reads it
positionally (`projects-panel.tsx:16` maps the selector through with no sort).
Sorting here would silently make 103 unimplementable.

## Architecture

Unchanged from the story spec; restated here only as the shape the plan targets.

**Write path.** One `writeConfig(mutate: Mutation): ConfigSnapshot` in
`electron/main/config/write.ts`: re-read from disk (never the cache), apply in
memory, validate the whole result with the read path's own `parseConfig` /
`resolveProjects`, write to `config.json.<pid>.tmp` in the same directory,
`renameSync` over the target, refresh the module cache, return the snapshot. On
any failure nothing touches disk and the reason comes back in `errors`.

**Comment preservation.** `"//"` keys and unknown top-level keys survive the round
trip. Mutate only `projects`, re-serialise with `JSON.stringify(…, null, 2)` plus
a trailing newline, preserving the key order of keys already present and appending
new ones.

**Schema v2.** `CONFIG_VERSION = 2`; `parse.ts` accepts 1 or 2. A v1 file is
upgraded **in memory** (`name` from the resolved basename, default `icon`,
`origin: 'local'`) and rewritten as v2 only on the user's first save. `PROJECT_KEYS`
grows to accept `name`, `icon`, `origin`.

**Bridge.** Three `invoke` channels — `config:choose-directory`,
`config:add-project`, `config:remove-project` — with `parseAddProjectRequest` and
`parseRemoveProjectRequest` in `shared/guards.ts` built on `assertShape`, which
gives `__proto__` rejection for free. `addProject` re-runs the entire 090
resolution on the incoming path; the dialog is a UX step, not a capability grant.
Every mutating verb returns the fresh `ConfigSnapshot`.

**Surface.** `ViewState` gains `'settings'`, winning over `'picker'`;
`openSettings()` clears `picker` and never touches `activeTab`. `center-stage.tsx`
must extend its `showingPicker` gate to cover both overlays — it currently drives
both the `hidden` class and `TerminalHost`'s `activeId`, and settings would
otherwise render over live terminals. `ui-store`'s new flag also goes in
`initialUiState`, which `reset()` reuses.

**Identity.** `id` derived once from the directory basename, kebab-cased,
`[a-z0-9-]`, truncated to 40 chars, `-2`/`-3` on collision. Never recomputed.

## Testing

Per the story spec's test plan, with two additions from the decisions above:

- `tests/electron/main/config/resolve.test.ts` (**new** — `tests/` mirrors `src/`,
  and `resolve.ts` has no test file of its own today; it is currently exercised
  only indirectly through `loadConfig()` in `index.test.ts`). `isRepo` is `true`
  for a directory containing a `.git` **directory**, `true` for one containing a
  `.git` **file** (the worktree case), and `false` otherwise.
- No test asserts `Cmd+,`. The gear and the picker empty state are the covered
  routes into Settings.

`tests/e2e/electron/settings.spec.ts` remains the only proof the slice works
end to end: `HIVE_CONFIG_PATH` sandbox, `tmpdir` repo, `dialog.showOpenDialog`
stubbed in main, add the folder, see it in the left rail, close, open the picker,
confirm it is spawnable.

Two surface tests will fail until updated, and that alarm firing is the test
working: `tests/electron/preload/bridge.test.ts:63` (constant-driven, self-updates)
and `tests/e2e/electron/security.spec.ts:106-108` (hard-coded `['get', 'reload']`).
The comment above the latter — "it is read-only on purpose" — is rewritten, not
deleted, in the same idiom the file already uses for `onLost` and `restart`.

`src/data/fixtures.ts` ends this story byte-identical; the merge is a selector.

## Decided during implementation

Five things the spec did not reach, each settled against the code and pinned by
a test. Recorded here because stories 102–108 build on this surface.

### 1. Settings lists the config's projects, not the merged list

**Confirmed with the reporter.** The merge rule returns *the fixtures* when the
config declares none, and fixture projects always own live sessions in this
phase — so a fresh install opened Settings on five rows the user had not added,
could not remove, and had not come for, and the empty state (the screen this
story exists to produce) was unreachable. The e2e caught it; no unit test could,
because each one seeded its own snapshot.

Settings now lists what the config declares and accounts for the demo projects
in one muted line. **The merge rule itself is unchanged** — it exists so the
rails and the picker keep working, which is a different question from what the
user manages in Settings.

### 2. The merged row is `ProjectRow`, not a widened `Project`

The spec asks for both "`Project` gains `name` and `source`" and
"`src/data/fixtures.ts` ends byte-identical". Those are incompatible: the
fixtures construct `{ id, icon }` literals, so widening `Project` forces editing
them. The acceptance criterion is the stronger commitment, and a fixture
genuinely has no display name or origin — so `ProjectRow extends Project` adds
them where they are real. `git diff app/src/data/` is empty.

### 3. `openTab` and `backToOrch` clear the settings flag

Not in the spec, and necessary. The rails stay visible behind a full-stage
overlay and remain clickable, while `resolveView` returns `'settings'` whatever
`activeTab` says — so a rail click that left the overlay up would change the tab
underneath and look, to the user, like nothing happened. The picker already
clears for the same reason.

### 4. `ParsedConfig` gains a `fatal` flag

`checkKeys` returns `false` only for a forbidden key; an *unknown* top-level key
is pushed into `errors` and tolerated. So `errors.length > 0` cannot be the write
path's refusal test — a config carrying one unknown key is exactly the config
this story promises to preserve, and refusing on it would make that file
permanently unwritable. `fatal` marks only the four wholesale-rejection paths.

### 5. The first-run template is rewritten, and now emits v2

The template still said *"id must match a project id shown in the left rail"* —
the rule this story reverses. A fresh install was writing documentation that was
false the moment it was written. It now describes the v2 entry shape and points
at Settings. Because it emits `CONFIG_VERSION`, a first run now writes
`version: 2`; a v1 file a user already has still loads unchanged and is not
rewritten until they save.

### Also worth knowing

`configPath` and `describe` moved to `electron/main/config/paths.ts` so
`write.ts` and `config/index.ts` do not import each other. Pure move.

The added path is stored **as the user wrote it** (`~/repo`), not resolved:
storing the realpath would bake this machine's home directory into a file people
keep in dotfile repos. `realpath` is used for identity and duplicate detection.

## Not in this story

Cloning a remote (102). Rename, re-point, reorder (103). Any other settings
section, including its nav item (104–107). Real git state beyond the `isRepo`
flag — branch and dirty stay fixtures. Watching the config file (107 owns explicit
reload). Per-project shell or env (104). Removing a project that owns live
sessions — the button is disabled with a tooltip, and 103 owns the confirmation.
`Cmd+,` (060).
