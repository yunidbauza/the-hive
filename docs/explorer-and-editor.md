# The project explorer and the editor

**Scope:** the right rail's tree, the CodeMirror editor on the centre stage, and
the filesystem IPC surface underneath both.

This is the first feature in the app that reads the user's source tree. Most of
what follows is about the two seams that made necessary.

## The filesystem seam

### The renderer never sends a path

Every `fs:` verb takes `{ projectId, relPath }`. Main looks the project up in
the config it wrote and validated itself, joins, `realpath`s, and asserts the
result is still inside the realpath'd root before touching anything.

**Two checks, and neither is redundant.** `assertRelPath` in
`electron/shared/guards.ts` settles what a legal *string* is — relative, no `..`
segment, no NUL, no control characters. `electron/main/fs/paths.ts` settles
where that string actually lands once symlinks are resolved. Neither can do the
other's job:

- A string check cannot see a symlink. `link/secret.txt` is a perfectly
  well-formed relative path; only asking the filesystem where `link` goes
  settles it.
- `realpath` cannot see a `..` on a path that does not exist yet — which is the
  write case, where the target may be about to be created.

Resolving *after* `realpath`, not before, is the part that matters. A guard that
only normalises the string is beaten by a symlink; a guard that resolves the
link and re-checks containment is not.

The write path has **two** links to defeat, and self-review caught that an
earlier revision only handled the first:

1. **A symlinked parent.** The target may be about to be created, so only its
   parent can be resolved — and a file created inside a symlinked directory
   lands wherever that link goes. The basename is re-appended to the *real*
   parent.
2. **A symlinked target.** Resolving the parent says nothing about the leaf.
   `root/sub/link.txt -> /outside/target.txt` has a parent inside the root and a
   joined path inside the root, so it passed both original checks — and
   `writeFile` follows symlinks. `lstat` is the only call that can see it:
   `stat` would follow the link, and `realpath` throws for a target that does
   not exist yet.

A link resolving back *inside* the root is allowed rather than refused —
in-repo symlinks are ordinary, and containment is the property being defended,
not the absence of links.

### Containment, and the prefix trap

`contains(root, candidate)` appends a separator before comparing. Without it, a
project at `/w/app` would consider `/w/app-secrets` contained, because the
string starts with the root. It looks fine until somebody has two sibling
repositories.

### The channels

| Channel | Kind | Payload → result |
| --- | --- | --- |
| `fs:read-dir` | invoke | `{projectId, relPath}` → `DirEntry[]` |
| `fs:read-file` | invoke | → `FileContent` \| `FsRefusal` |
| `fs:write-file` | invoke | `{…, text, baseMtimeMs}` → written, conflict, or error |
| `fs:search` | invoke | `{projectId, query, mode}` → `SearchResults` |
| `fs:watch` / `fs:unwatch` | invoke | one watcher, for the visible project |
| `fs:changed` | main → renderer | `{projectId, paths[]}` |

`DirEntry` carries **no path** — the renderer composes paths from the tree it
already holds, and a path in the reply is a second answer that can disagree with
the first.

### Why search is a channel and not a filter

`fs:search` is the only verb here that **recurses**, and it exists because the
tree is lazy. `use-directory.ts` reads a directory only when it is expanded, so
a renderer-side filter can see nothing but the folders someone already opened —
it would answer "no matches" for a file one collapsed directory away, which is
worse than not offering search at all.

It takes no path, like everything else here: a `projectId`, a query, and a mode
(`name` or `text`). The query is matched case-insensitively as a **literal**,
never a regular expression — a pathological pattern here runs against every file
in the project rather than one open document.

Nothing in this layer recursed before it, so it had no depth limit, result cap
or timeout to inherit. All of them are declared in `fs-contract.ts` and all are
enforced in `search.ts`: depth 12, 200 files, 500 matches, 20 lines per file,
and a 4-second wall-clock budget. The walk stops at the **first** bound it
reaches and sets `capped`, which is what the panel renders as `500+` — a
truncated set printed as a total is the same class of untruth as a tree that
shows the wrong files without saying so.

It prunes on `HIDDEN_ENTRIES` before `stat`, exactly as `readDirectory` does,
and reuses the editor's own refusals: a file past `MAX_FILE_BYTES` or failing
the NUL sniff is skipped rather than read. It does **not** consult
`.gitignore`, for the reason `HIDDEN_ENTRIES` gives — the parser is a
dependency, nested ignore files have to compose to be worth having, and it hides
`.env.local`.

A read **refuses** rather than errors in two cases, and the distinction is
user-visible: over 1 MB, and a NUL byte in the first 8 KB. Neither is a failure
— the app looked and decided there was nothing worth rendering. An `FsError`
(`ENOENT`, `EACCES`, `EISDIR`) reads differently and is rendered differently.

`EPROJECT` deliberately means both "unknown id" and "unusable project". That
difference is the only thing an id-probing loop could extract, and it is worth
nothing to the panel — which renders the config's own `status` reason from a
snapshot it already has.

### `writeFile` is not gated on the editor's read-only setting

That preference lives in `localStorage`, which is writable by exactly the thing
a capability check would be defending against. **The setting gates the UI;
containment gates the disk.** Gating the channel would be theatre.

## The watcher

One recursive watcher, for the project the explorer is currently showing.
`watchProject` *replaces* rather than adds, which is why `unwatch` needs no
argument — there is only ever one thing to stop. A watcher per visited project
would be a file-descriptor leak with a long fuse.

**The renderer subscribes at the composition root**, in `useProjectWatcher`, not
in `ExplorerPanel`. It started in the panel and that was a bug: the rail swaps
panels and the shell can unmount the rail entirely, so freshness died the moment
the user looked at the Inbox with a file open — no silent reload, no
`staleOnDisk`, and the next save refused with a conflict they were never warned
about. The tree is only one consumer; the editor is the other, and it outlives
the panel.

A request is also stamped with a generation counter taken *before* its
`projectRoot` await and checked after it, so two overlapping `fs:watch` calls —
a fast session switch across projects — cannot settle out of order and leave the
visible project unwatched.

Two properties, both in `electron/main/fs/watcher.ts`:

- **Hidden paths are filtered in main, before emit.** A `pnpm install` rewrites
  tens of thousands of paths under `node_modules`; filtering in the renderer
  would serialise every one of them across the bridge to be discarded.
- **Trailing debounce, 300 ms, with a 2 s ceiling.** One `git checkout` produces
  a change event per file. Leading would report the state *before* most of the
  burst had happened, which is the one thing the flush exists to avoid. The
  ceiling matters because a plain trailing debounce resets on every event: a
  sustained write stream at under 300 ms intervals — a long build, a watch-mode
  compiler — would otherwise never flush at all, and the tree would sit stale
  for exactly as long as the agent kept working.

Recursive watching is native on macOS and Windows and available on Linux from
Node 20. Electron 43 ships Node 22, so there is no fallback path and no polling.

## What is hidden, and why not `.gitignore`

`.git` always; then `node_modules`, `dist`, `out`, `.next`, `coverage`,
`.turbo`, `target`, `__pycache__`, `.venv`. The list lives in
`electron/shared/fs-contract.ts` so both processes read one definition.

Other dotfiles are deliberately **shown**. `.claude`, `.github`, `.env.example`,
`.gitignore` and `AGENTS.md` are all things you open in this app, and a rule
that hid every name starting with a dot would hide all of them to save the user
from four directories.

A `.gitignore` parser was considered and declined: it needs a matcher
dependency, it has to compose nested ignore files correctly to be worth having,
and it hides `.env.local` — one of the files you most want to look at when a
session will not start.

## The tree

The root follows the **active session's project**. There is no project picker:
the app is already organised around "which session am I watching", the session
already names its project, and a second selector would be one more thing to keep
in sync with the first. The orchestrator tab — which names no session — falls
back to the last project the tree was rooted at, then to the first mapped one.

### It also follows the session *into a worktree* (HIVE-78)

A session whose agent has moved into `<project>/.claude/worktrees/<name>` is
editing files a project-rooted tree does not show, while the tree shows files
nobody is touching. `useExplorerProject()` therefore answers a **project and a
root**: a project-relative prefix taken from the session's observed `cwd`.

**The fs guard is untouched by this**, and that is the reason it is a prefix
rather than a new root. A worktree under the project is already inside the
realpath'd root the section above describes, so every read still resolves
through `projectRoot(projectId)` exactly as before. A cwd *outside* the mapped
project resolves to `''` and the tree stays at the project root — the guard
would refuse those paths anyway, and showing something true beats an error about
a path the panel should not have asked for.

Two consequences worth naming:

- **Paths stay project-relative** — `.claude/worktrees/x/src/a.ts`, not
  `src/a.ts`. So the same file in two worktrees is two distinct keys in
  `editor-store`, and opening one cannot mark the other stale or conflicted.
- **The watcher does not narrow.** `useProjectWatcher` deliberately ignores the
  prefix and watches the whole project: main reports project-relative paths, and
  a watcher scoped to a worktree would stop reporting changes to files the
  editor still has open from outside it.

Only the active session's own project is retargeted. The sticky and default
branches answer `''`, because a prefix describes where one session is working
and applying it to a project the user navigated to for another reason would be a
stranger lie than the one this fixes.

Expansion is lazy and per node: each expanded directory owns its own
`useDirectory()` call, and a collapsed one is never read. On a watcher event the
tree re-reads **every currently-expanded directory** rather than diffing the
changed paths against itself. The expanded set is small at this width, and a
diff is a second model of the filesystem that can disagree with the first.

## The editor seam

`src/components/editor/` is fenced exactly like `src/components/terminal/`: an
ESLint zone forbids `features/`, `data/` and `stores/`, so it knows its props and
nothing about the app around it.

### Colour inverts here, and it is not an inconsistency

CodeMirror themes are CSS-in-JS that emit real stylesheet rules, so
`var(--cc-code-keyword)` resolves at paint time like any other declaration — the
editor follows `data-theme` with **no JavaScript involved**. xterm cannot do
this: it resolves colour from a JS `theme` object and paints into markup it owns,
which is why the TERM palette lives in `ansi.ts` and never reaches CSS.

So the rule is the same in both directories and the mechanism is opposite: no
hex literal belongs in `components/editor/` either — a missing colour is a token
to add in `tokens.css`.

### One view, one state per file

Cursor position, scroll offset and undo history all live in an `EditorState`.
Keeping one per open file and calling `view.setState` on a tab switch restores
all three.

**A configuration change clears the cache, the active entry included.**
Extensions are baked into a state at construction, so a state built with the old
font would keep it and adopt it the moment it was switched to. The bug this
prevents: a font, tab-width or read-only change that applies to every open file
*except* the one on screen. The comparison happens inside the main effect rather
than in a second one, because a second effect runs *after* it — by which point
the stale state has already been restored.

### Languages load lazily

Seventeen grammars is roughly a megabyte of parser tables. Each is behind a
`() => import(…)`, so a language nobody opens costs nothing but a table entry.
The document renders before the grammar arrives; that is the point, not a
glitch.

A resolved grammar is then **remembered per file**, and that cache is
load-bearing rather than an optimisation: a new `EditorState` takes whatever the
compartment is given at construction, so without it every rebuild dropped back
to plain text. Rebuilds are not rare — the watcher's silent reload changes
`value`, which is the feature's headline case. Highlighting used to disappear
the first time an agent touched the open file. An extension with no entry opens as plain text with line numbers,
wrapping and search intact — a supported outcome, not a gap.

## Placement, and the one rule that unifies it

Two independent settings produce four layouts:

| Placement | Open files | Chrome | Way back to the terminal |
| --- | --- | --- | --- |
| `full` | `tabs` | `[⌨ Terminal][app.tsx ×]` | select Terminal |
| `full` | `single` | filename header + `×` | `Escape`, or `×` |
| `split` | `tabs` | `[app.tsx ×]`, over the editor pane | the terminal never left |
| `split` | `single` | filename header + `×` | `Escape`, or `×` |

> **A Terminal entry appears in the strip exactly when the terminal is hidden**
> — which is only ever `full` + `tabs`.

Stated as an invariant rather than four cases: the terminal is never hidden
without a visible control that brings it back. That single rule is what lets the
two settings stay independent instead of being four hand-written layouts.

`resolveView` returns `'editor'` only in `full`. In `split` the editor is not a
view state at all — it is a layout of the entity view — and modelling it as one
would make `isEntityView` lie about whether the session meta bar and message row
should be mounted.

## Freshness and saving

| Buffer | State on disk | Behaviour |
| --- | --- | --- |
| clean | changed | **silently reloaded** |
| dirty | changed | `staleOnDisk`; banner offers Reload or Keep mine |
| any | mid-save | skipped |
| any | the app's own last write | suppressed once, by mtime |

Silent reload of a clean buffer is the whole point of the feature: you open a
file to watch what a session does to it, and a prompt between you and that is
friction carrying no information.

**The `saving` flag cannot suppress the app's own echo**, and an earlier
revision of this document claimed it could. The watcher is a *trailing*
debounce, so the event always arrives after the write has settled and the flag
has gone false. A save therefore records the mtime it produced, and the first
event afterwards consumes it — otherwise every save the user made would put a
"changed on disk" banner in front of them. The suppression is one-shot and
deliberately narrow: an agent writing inside that same window is folded into the
same event and swallowed with ours, which the next event and the save-time mtime
check both catch.

Saving is optimistic concurrency, not a lock — the other writer is an agent in a
subprocess that would never take one. The buffer sends the mtime it was read at;
main compares and refuses on a mismatch, writing nothing. `Overwrite` re-reads
the current mtime and writes against *that*, which makes it an explicit second
act rather than a retry that would be refused identically.

The comparison is `!==`, not `>`. A file restored from a backup or checked out
by `git` can land with an mtime *older* than the buffer's base, and treating
"older" as "unchanged" would overwrite it.

A save is also a round trip the user can type during, so the buffer goes clean
only if its text still equals what was actually sent. Clearing `dirty`
unconditionally claimed the disk held text it did not — and the watcher's echo
would then find a "clean" buffer and reload over those keystrokes.

**What this does not cover, stated plainly:** mtime resolution is coarse, so two
writes inside one filesystem tick are indistinguishable. A situation where an
agent and a user are interleaving writes to one file at that rate has worse
problems than this check. Hashing the previous content is the right upgrade if
the coarse case is ever actually hit, and the wrong default.

## Testing

- **The containment guard has its own suite** (`tests/electron/main/fs/`), with
  real directories and real symlinks. It is the only new code here where a bug
  is a security bug.
- **CodeMirror runs for real in unit tests**, unlike xterm. It renders its
  document into the DOM without measuring first, so happy-dom can hold it and
  `.cm-content` really contains the text. Do not add a mock: the reason xterm
  needs one does not apply here, and a fake would assert less.
- **The live-reload claim is a Playwright spec**
  (`tests/e2e/electron/project-explorer.spec.ts`). A unit test can assert that
  `reconcile` reloads; only the real app can assert that the OS told it to.

## Explicitly not in this feature

- Image and binary previews — refused with a reason, not rendered.
- Creating, renaming, deleting or moving files. The tree reads; the terminal is
  where the filesystem is mutated, and it already is.
- Search across files, git status decoration, diff view.
- Multiple projects in one tree.
- Restoring open files across launches — `editor-store` is not persisted.
