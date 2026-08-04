# HIVE-55 — Settings: Manage Projects — rename, re-point, reorder (story 103)

Three new mutating verbs on the project list — rename a project's display name,
re-point one whose folder moved, and reorder the list the left rail reads
positionally — plus the remove-with-confirmation that story 101 deliberately
left disabled.

**Jira:** HIVE-55 · 5 points · Epic HIVE-51 (Settings) · blocked by HIVE-54
(story 102, merged in `0059785`, PR #41). It blocks nothing — the epic's graph
makes 103 a leaf, and 108 depends on 101, 102 and 085. HIVE-60 (108) is still
updated by this story, because its conformance scope grows to cover three new
mutating verbs; that is a scope note, not a dependency.

**Story file:** none. `stories/103-*.md` was never written, and this story does
not write it — it follows story 102's precedent rather than 101's. This spec is
the acceptance criteria, the file-touch table and the test plan the story file
would have carried. `stories/README.md` is repaired instead, so the index stops
drifting.

---

## Reconciliation decisions

Reconciled against `main` @ `0059785` before any code was written. The codebase
is the source of truth; the ticket is an admitted placeholder ("Placeholder for
a spec, not a spec"). Six findings.

### 1. Settings lists the config's projects, not the merged list

The ticket carries the epic's merge rule and reads as though the Settings list
is the merged one. It is not. Story 101 decided that `projects-section.tsx`
renders `snapshot.projects` — config entries only — and reduces demo projects to
a single counted line (`projects-section.tsx:65-74`, `:177-183`), because
fixture projects always own sessions in this phase and a fresh install would
otherwise open Settings on five rows the user never added.

**Resolution:** reorder rewrites the config's `projects` array and nothing else.
Demo rows are not listed here, so they are not draggable, and the question of
"where does a demo row sit in a user-defined order" does not arise: `useProjects()`
appends them after the config rows (`hive-store.ts:729-733`), which is unchanged.

### 2. The merge retains fixtures owning *any* session, not *live* ones

The ticket says a fixture project "that still owns live fixture sessions stays
in the list marked `demo`". The merge actually tests `projectsOwningSessions`
(`hive-store.ts:646`, used at `:704`), which counts sessions with
`status === 'done'`. The *live* predicate is a different selector,
`projectsOwningLiveSessions` (`:657`), and it is used only for the remove gate.

**Resolution:** follow the code. The distinction matters here because this
story's confirmation is gated on the live predicate, and conflating the two
would confirm removals that need no confirmation.

### 3. `chooseDirectory` is not in `config/`, and re-point is a two-hop

The ticket says re-pointing selects a directory "via `dialog.showOpenDialog` in
main, behind a verb that takes no path". `chooseDirectory` is not a config-module
function at all — it is inlined in the IPC registration at
`main/ipc/index.ts:169-189`, returns a bare path to the renderer, and the
renderer echoes it back into a second verb.

**Resolution:** that two-hop *is* the epic's rule at
`stories/100-settings-epic.md:176-183` ("a verb that takes no path… the renderer
echoes that path back, and **main re-validates it completely**"), just stated
more tersely in the ticket. Re-point reuses `chooseDirectory` unchanged and adds
`repointProject`, which re-validates from scratch. No new dialog code.

### 4. Nothing about story 103 exists yet, including the tests

A repo-wide search for rename / re-point / reorder / reorderProjects / any
confirmation flow returns zero implementation hits. What exists is scaffolding
and three explicit hand-offs: `config/index.ts:250`, `identity.ts:8-9`, and
`hive-store.ts:667-669` and `:698-700`.

**Resolution:** treated as greenfield on both sides of the IPC seam. Noted
because it also means there is no partial implementation to reconcile against.

### 5. `project-row.tsx` has no mirrored test file

`app/AGENTS.md:179-181` requires `tests/` to mirror `src/` with "no exceptions".
`app/tests/features/settings/components/project-row.test.tsx` does not exist;
the component is covered only indirectly through `projects-section.test.tsx`.
(The `tests/features/projects/components/project-row.test.tsx` that does exist
is the *rail's* row — a different component.)

**Resolution:** this story lands rename, re-point and drag on exactly that
component, so it closes the gap rather than widening it.

### 6. `stories/README.md` is one story behind and its Jira table is wrong

The Index (`README.md:34-81`) has no row for story 102 despite it being merged.
The Jira mapping at `:115` still says "102–108 are scoped in [100] and have no
Jira issue yet"; HIVE-54, HIVE-55 and HIVE-60 all exist. An untracked
`stories/README copy.md` — a stale pre-phase-2 snapshot — sits in the tree as
`git status` noise.

**Resolution:** add the 102 and 103 rows and correct the Jira table.
`README.md:127` says "when a story changes here, update its Jira issue too;
nothing syncs automatically", so HIVE-55 and HIVE-60 are updated in Jira as part
of this story.

**Correction, recorded after the fact.** This section originally said the junk
file would be deleted too, and the commit that added this spec (`250e75d`) says
so in its message. Neither is true: `stories/README copy.md` was never tracked
by git, so no commit can remove it — it exists only as an untracked file in the
maintainer's own checkout, and a worktree never saw it. Deleting it is a local
`rm`, not a change this branch can carry. The commit message is left as-is
rather than rewritten, because the branch is pushed and a misleading sentence in
one message is a smaller problem than rewriting fifteen commits of shared
history.

---

## Design decisions

### Reorder sends the whole ordered id list, and main checks it is a permutation

`ReorderProjectsRequest` is `{ ids: readonly string[] }`, not `{ id, direction }`
or `{ id, index }`. Both input paths — a drop and a menu item — naturally produce
a full ordering, the verb is idempotent, and it validates exactly: main requires
the incoming ids to be a permutation of the ids on disk *at write time* — same
length, same set, no duplicates.

That check is the point rather than a formality. `writeConfig` re-reads the file,
so a config hand-edited since the renderer loaded it would otherwise let a stale
ordering silently drop or duplicate a project. It is refused with a message that
says to reload.

### Every mutation spreads the existing raw entry

Per-entry unknown keys survive today only because `addProject` and
`removeProject` never rebuild an entry object — they copy raw entries wholesale
(`config/index.ts:227-239`, `:261-265`). The epic's preservation rule
(`100-settings-epic.md:146-166`) is written about top-level keys, but a rename
that rebuilt an entry from `ProjectConfig` would quietly eat per-entry ones.

All three mutations are therefore spreads:

```ts
entries.map((e) => (idOf(e) === request.id ? { ...e, name } : e))
```

This is also what makes "re-pointing must preserve `origin`" true **by
construction** rather than by a special case: only `path` is overwritten, so
`origin: 'cloned'` survives because nothing touched it.

### Re-point stores the path as written and resolves only for identity

`addProject` stores the user's path verbatim, tilde and all, and uses `realpath`
solely for duplicate detection — deliberately, so a config kept in a dotfile
repo does not bake in one machine's home directory (`config/index.ts:176-179`).
`repointProject` does the same: `resolveProject({ id: 'probe', path })` to
validate and to compare against other entries' resolved paths, then writes
`request.path` unchanged.

Duplicate detection excludes the project being re-pointed, so re-pointing a
project to the folder it already has is a no-op write rather than a refusal.

### `id` is never rewritten

Rename edits `name` only. `stories/101-settings-add-local-project.md:148-155` is
explicit: sessions reference projects by `entity.project`, so an id that drifted
when a folder was renamed would strand them. `deriveProjectId` stays a
create-time function. Duplicate display names are allowed — `name` is a label,
`id` is identity.

### The row grows a menu, not four buttons

Approved on browser-rendered mockups before implementation, against two
alternatives (hover-revealed icon buttons; a click-to-expand row editor).

The resting row is unchanged except for a drag grip that appears on hover. The
`✕` becomes a `⋯` menu holding *Move up*, *Move down*, *Rename…*,
*Change folder…* and *Remove*. It reuses the existing
`components/ui/dropdown-menu.tsx` — no new atom — and it keeps the right edge
free for the `demo` and `no git` tags already there. The list is read far more
often than it is edited, so the resting state is what the design optimises.

Rejected: three hover-revealed icon buttons put four controls and two tags in
the same ~120px and ask the user to decode three glyphs. The expand-to-edit
variant was the most discoverable but introduced a **Save** button, and every
other write in this section — Add, Clone, Remove — commits immediately.

### Keyboard reorder is menu items, not a lift mode

Approved on mockups against the dnd-kit convention (focus grip, Space to lift,
arrows to move, Space to drop, Esc to cancel).

*Move up* / *Move down* sit in the same `⋯` menu, disabled at the ends of the
list. The reason is mostly testability: menu items are ordinary clicks, so the
reorder logic — the array rewrite, the write path, the rail honouring the new
order — is proven by fast unit tests, and the drag e2e only has to show that
dragging reaches the same code. A lift mode makes the fragile path the *only*
path, and needs a live region and bespoke key handling besides. It is also more
discoverable: nothing about a grip announces that Space lifts it.

### Drag is hand-rolled HTML5, with no new dependency

`draggable` plus `dragstart` / `dragover` / `drop` on the row. The repo ships 11
production dependencies and no drag-and-drop library; `radix-ui` has no DnD
primitive. A hand-rolled vertical-list reorder is small, and Playwright's
`dragTo` drives native HTML5 drag directly, whereas a pointer-event library
would need manual `mouse.move` stepping in the e2e.

The accessibility that a library would have supplied is delivered by the menu
items instead, which is the trade recorded above.

### Drag holds no reordered array

During a drag the component stores `draggingId` and `dropIndex` only; the
preview order is computed at render. There is no optimistic copy of the list to
reconcile when the write returns, so the snapshot stays the single source of
truth — the same invariant `lib/project-config.ts:82-87` states for every other
mutating verb ("No reload follows. Every mutating verb returns the fresh
snapshot").

### The remove confirmation is inline, and says the sessions survive

Approved on mockups against a centred `ui/dialog.tsx` modal and a 102-style
focused sub-view.

The row expands in place into the question. Nothing floats, the list does not
move, and the project in question is still where the cursor left it — so an
accidental Cancel returns you exactly where you were. It needs no new primitive,
and it does not have to argue with the two files that documented why they
rejected `ui/dialog.tsx` (`settings-overlay.tsx:11-27`,
`new-session-picker.tsx:32`).

**What it says matters as much as where it sits.** Removing a project deletes
its config entry; it does not kill anything. The PTYs keep running and the tabs
stay open — the sessions simply stop resolving to a mapped project, exactly like
a session whose folder was never mapped. The confirmation says so plainly rather
than implying data loss, because killing a user's live terminals as a
side-effect of a settings edit would be a far larger action than "remove from
list", and this story is not authorised to take it.

A project with **no** live sessions still removes in one click, as it does
today. The ticket scopes confirmation to "a project owning live sessions", and a
config entry that can be re-added in two clicks does not earn a speed bump.

### The list moves out of `projects-section.tsx`

Adding a grip, a menu, an inline editor and an inline confirmation to
`project-row.tsx` would overload one file, and the drag state has to live above
the rows. `projects-list.tsx` is extracted to own the ordered list, the drag
state and which row is in which mode; `projects-section.tsx` shrinks back to
being about the section — panes, the action row, errors, the footer.

Drag and row-mode state stay **local**, following the rule 101 used for
`choosing` and 102 for `view` (`projects-section.tsx:54-62`): scoped to one
section, dies with it, not promoted to `ui-store`.

---

## Architecture

### Shared

| File | Change |
| --- | --- |
| `electron/shared/config-contract.ts` | **new types** `RenameProjectRequest`, `RepointProjectRequest`, `ReorderProjectsRequest` |
| `electron/shared/ipc-contract.ts` | **new channels** `configRenameProject: 'config:rename-project'`, `configRepointProject: 'config:repoint-project'`, `configReorderProjects: 'config:reorder-projects'`; three methods on `HiveBridge.config`; three names appended to `BRIDGE_CONFIG_KEYS` |
| `electron/shared/guards.ts` | **new** `parseRenameProjectRequest`, `parseRepointProjectRequest`, `parseReorderProjectsRequest` |

### Main

| File | Change |
| --- | --- |
| `electron/main/config/index.ts` | **new verbs** `renameProject`, `repointProject`, `reorderProjects`, each returning `ConfigSnapshot` via `commit(writeConfig(...))` |
| `electron/main/ipc/index.ts` | three `handle(...)` registrations, each `parse…Request` then the verb |

`writeConfig`, `parse.ts`, `resolve.ts` and `identity.ts` are **unchanged**. The
whole story is three new mutations through the existing write path.

### Preload

| File | Change |
| --- | --- |
| `electron/preload/index.ts` | three `ipcRenderer.invoke` wrappers on the `config` object |

### Renderer

| File | Change |
| --- | --- |
| `src/lib/project-config.ts` | **new verbs** `renameProjectInConfig`, `repointProjectInConfig`, `reorderProjectsInConfig`, each routed through the existing `read()` funnel |
| `src/features/settings/components/projects-list.tsx` | **new** — owns the ordered list, drag state, and the active row mode |
| `src/features/settings/components/project-row.tsx` | grip + drag handlers + menu trigger; actions delegated upward |
| `src/features/settings/components/project-row-menu.tsx` | **new** — the `⋯` menu |
| `src/features/settings/components/project-name-editor.tsx` | **new** — inline rename input; Enter commits, Esc cancels |
| `src/features/settings/components/project-remove-confirm.tsx` | **new** — the inline confirmation row |
| `src/features/settings/components/projects-section.tsx` | list rendering moves out; keeps panes, action row, errors, demo line, footer |

Nothing in `src/stores/` changes. `useProjects()` already preserves config order
and is explicitly forbidden from sorting (`hive-store.ts:698-700`), and
`projects-panel.tsx:12-18` already maps it positionally — which is precisely why
the rail honours a reorder without being touched.

### Data flow

```
drop / Move up / Move down
  → projects-list computes the new id order
  → reorderProjectsInConfig({ ids })
  → bridge.config.reorderProjects → invoke 'config:reorder-projects'
  → assertSender (central handle wrapper)
  → parseReorderProjectsRequest      ← unknown keys, __proto__, bad ids rejected
  → reorderProjects()
      → writeConfig: re-read disk → permutation check → reindex entries
        → serialise → parseConfig + resolveProjects → temp file → rename
  → ConfigSnapshot returned through the same invoke
  → read() installs it → emit() → subscribers rerender
  → left rail renders the new order (no store change, no reload)
```

Rename and re-point are the same shape with a different mutation. Re-point is
preceded by the existing `chooseDirectory` invoke, whose result the renderer
echoes back and main re-validates from scratch.

---

## Error handling

| Case | Behaviour |
| --- | --- |
| Rename to empty or whitespace | the editor refuses to commit and reverts; no IPC call. `assertText` rejects it at the boundary too — the client check is convenience, not the gate |
| Rename with control characters, or over 4096 chars | `assertText` rejects; nothing is written |
| Rename an id that is not on disk | `WriteRefused` — `no project with id "…"`; snapshot unchanged |
| Re-point to a missing path, a file, or a relative path | `resolveProject` probe fails; refused with the resolution status, surfaced in the existing `snapshot.errors` block |
| Re-point to a path another project already resolves to | refused, naming the project that owns it — the `addProject` message, reused |
| Re-point to the project's current path | permitted; a no-op write |
| Re-point dialog cancelled | nothing happens, exactly as Add does on `path === null` |
| Reorder ids that are not a permutation of the file's | refused with a message telling the user the file changed and to reload |
| Reorder containing a duplicate id | rejected by the guard before it reaches main's verb |
| Any write failure (`EACCES`, full disk, symlinked config) | `WriteRefused` from the existing write path; nothing changes; the reason is surfaced |
| Remove confirmation cancelled | the row returns to its resting state; nothing was written |

Every refusal leaves the file byte-identical — the existing guarantee of
`writeConfig`'s temp-file-and-rename, not a new one.

---

## Testing

`tests/` mirrors `src/`; the 80% gate on lines, statements, branches and
functions applies.

| Level | Covers |
| --- | --- |
| `tests/electron/shared/guards.test.ts` (extend) | the three new parsers: happy path, unknown key, `__proto__`, wrong types, empty name, control characters, over-length name, duplicate ids in a reorder |
| `tests/electron/main/config/index.test.ts` (extend) | the three verbs: rename writes only `name`; re-point writes only `path` and **preserves `origin: 'cloned'`**; per-entry unknown keys survive all three; reorder reindexes; permutation rejection; duplicate-path rejection on re-point; self-re-point permitted; unknown id refused; a v1 file upgrades to v2 on a first rename |
| `tests/electron/main/ipc/config-channels.test.ts` (new) | the three channels registered through `handle`, guard applied before the verb, snapshot returned |
| `tests/electron/preload/bridge.test.ts` (extend) | `BRIDGE_CONFIG_KEYS` asserts an **exact** key set — it fails unless the three verbs are added |
| `tests/lib/project-config.test.ts` (extend) | the three renderer verbs install the returned snapshot and notify subscribers; no-bridge is a no-op |
| `tests/features/settings/components/project-row.test.tsx` (**new**) | closes the existing mirror gap: renders name/path/tags, grip appears, menu trigger, drag handlers fire |
| `tests/features/settings/components/project-row-menu.test.tsx` (new) | item set; Move up disabled on the first row, Move down on the last |
| `tests/features/settings/components/project-name-editor.test.tsx` (new) | Enter commits, Esc reverts, whitespace-only refuses, unchanged name does not write |
| `tests/features/settings/components/project-remove-confirm.test.tsx` (new) | message names the project and the live-session count; Cancel writes nothing |
| `tests/features/settings/components/projects-list.test.tsx` (new) | Move up/down produce the right id order; drag events reorder; a project with live sessions confirms before removing; one without removes immediately |
| `tests/features/settings/components/projects-section.test.tsx` (extend) | the section still renders the list, the action row and the demo line after the extraction |
| `tests/e2e/electron/manage-projects.spec.ts` (new) | the real app against a sandboxed config: drag row 1 past row 2 and assert **both** `config.json` order and the left rail order changed; a rename round-trip that survives a reload; a re-point with `showOpenDialog` stubbed in main; remove-with-confirmation on a project owning a live session |
| `tests/e2e/electron/security.spec.ts` (extend) | the asserted preload API surface gains the three verbs |

The e2e spec is the only proof the whole slice works; the unit tests prove the
pieces. `pnpm verify:boundaries` must stay green — no new import zone is
introduced, and the renderer's `@shared` imports stay type-only.

---

## Acceptance criteria

- [ ] A project's display name can be edited in place from the `⋯` menu, and the new name appears in the left rail without a reload.
- [ ] Renaming writes only `name`. The project's `id` is unchanged, and its sessions stay attached.
- [ ] A project whose folder moved can be re-pointed through the native directory dialog, and the new path is stored **as chosen**, tilde preserved.
- [ ] Re-pointing a cloned project leaves `origin: "cloned"` intact.
- [ ] Re-pointing to a folder another project already uses is refused, and says which project owns it.
- [ ] Projects can be reordered by dragging a row, and by *Move up* / *Move down* in the `⋯` menu; both produce the same config and the same rail order.
- [ ] The left rail, the new-session picker and Settings all show the new order after a reorder, with no reload.
- [ ] Removing a project that owns live sessions asks for confirmation inline, states that the sessions keep running, and writes nothing if cancelled.
- [ ] Removing a project with no live sessions still takes one click.
- [ ] `"//"` comment keys, unknown top-level keys, and unknown per-entry keys all survive a rename, a re-point and a reorder.
- [ ] A v1 config is upgraded to `version: 2` on the first rename, and its comments are retained.
- [ ] A reorder posted against a config that changed on disk is refused, and nothing is written.
- [ ] `stories/README.md` lists stories 102 and 103 and maps them to HIVE-54 and HIVE-55; `stories/README copy.md` is gone.
- [ ] `pnpm lint`, `pnpm type-check`, `pnpm test:coverage` and `pnpm verify:boundaries` all pass, and the e2e spec drives the built Electron app green.

---

## Not in this story

- Reordering or renaming demo/fixture rows — Settings lists the config's projects only (story 101).
- `Cmd+,` — still story 060, which has no keyboard-binding registry yet.
- Watching the config file for external changes — still story 107; this story only *detects* an out-of-band edit when a write refuses.
- Changing a project's `icon` — the schema carries it and `resolve.ts` defaults it, but no story has claimed the picker.
- Killing or migrating sessions when a project is removed. The sessions survive unmapped, and that is the decision, not an omission.
