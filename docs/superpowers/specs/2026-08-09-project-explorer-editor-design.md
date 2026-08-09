# Project explorer and file editor — design

| | |
|---|---|
| **Ticket** | none — ad-hoc (`workstream:goal-on`) |
| **Replaces** | The Activity tab in the right rail, and the `activity-feed` slice behind it |
| **Depends on** | 090 (config → project paths), 083 (the preload bridge), 101/105 (the settings overlay and `appearance-store`) |
| **Location** | `electron/shared/`, `electron/main/fs/`, `app/src/lib/explorer/`, `app/src/components/editor/`, `app/src/features/{explorer,editor,settings}/`, `app/src/stores/` |

The right rail's third tab becomes a **project explorer** — a lazy tree of the
repo the active session is working in — and clicking a file opens it in a
**CodeMirror 6** editor on the center stage. The Activity feed, which the tab
displaced, is deleted rather than moved.

This is the first feature in the app that reads the user's source tree. Most of
what follows is about the two seams that makes necessary: a filesystem IPC
surface that a compromised renderer cannot aim outside a mapped project, and an
editor component that knows as little about the app as `components/terminal/`
does.

## What the user gets

The explorer roots at **the project of whatever session is open**. There is no
project picker: the app is already organised around "which session am I watching",
the session already names its project, and a second selector would be one more
thing to keep in sync with the first. On the orchestrator tab — which names no
session — the tree shows the last project it was rooted at, falling back to the
first mapped project whose `status` is `'ok'`.

Clicking a file opens it. Where it opens, whether it can be edited, and how many
files can be open at once are **settings**, not decisions this document makes on
the user's behalf. That is the substance of the next section.

## The four settings, and the one interaction between them

`appearance-store` gains an Editor block. Four of its entries are behavioural and
the rest are typography:

| Setting | Values | Default |
|---|---|---|
| `editorPlacement` | `full` / `split` | `full` |
| `editorSplitAxis` | `horizontal` / `vertical` | `vertical` |
| `editorNav` | `tabs` / `single` | `tabs` |
| `editorEditable` | `false` / `true` | `false` |
| `editorFont` | the terminal font list | `jetbrains-mono` |
| `editorFontSize` | 11–18 | `13` |
| `editorWordWrap` | on / off | on |
| `editorLineNumbers` | on / off | on |
| `editorTabWidth` | 2 / 4 / 8 | `2` |
| `editorSplitRatio` | 0.2–0.8 | `0.5` |

`editorPlacement` and `editorNav` are independent, and their four combinations
produce four different pieces of chrome. The rule that unifies them:

> **A "Terminal" entry appears in the tab strip exactly when the terminal is
> hidden** — which is only ever `full` + `tabs`.

| Placement | Nav | Chrome | Way back to the terminal |
|---|---|---|---|
| `full` | `tabs` | `[⌨ Terminal][app.tsx ×][● ui.ts ×]` | select Terminal |
| `full` | `single` | filename header + `×` | `Escape`, or `×` |
| `split` | `tabs` | `[app.tsx ×][ui.ts ×]`, over the editor pane only | the terminal never left |
| `split` | `single` | filename header + `×`, over the editor pane | `Escape`, or `×` |

Stated as an invariant rather than four cases: **the terminal is never hidden
without a visible control that brings it back.** The picker and the settings
overlay each satisfy this today with an Escape binding and a close button; the
editor is the first surface that can also be *left open* while the user works
elsewhere, which is why `full` + `tabs` needs a persistent entry rather than a
dismissal.

In `split`, closing the last open file collapses the split back to a full-height
terminal. A split pane showing nothing is a worse answer than no split.

### The cost of `vertical` as the split default

With both rails mounted the shell already spends roughly 590px on chrome. A
vertical split halves what is left, which on a 1440px display gives the terminal
about 40 columns — narrow enough that agent output, tables and diffs wrap badly.
`horizontal` keeps the terminal full-width and is the better default on the
merits.

It is `vertical` because the user chose it, knowing that. The axis is a setting
and the divider is draggable with its ratio persisted, so the cost is one click
and it is recoverable. Recording the trade-off here so the next person to read
this file does not "fix" it.

## The filesystem seam

### The renderer never sends a path

Every `fs:` verb takes `{ projectId, relPath }`. Main resolves it against the
project's own `path` — the one *it* wrote into `~/.hive/config.json` and
validated on load — then `realpath`s the join and asserts the result is still
inside the realpath'd root before touching anything.

Resolving after `realpath`, not before, is the part that matters. A guard that
normalises the string can be beaten by a symlink inside the project pointing at
`/etc`; a guard that resolves the link and re-checks containment cannot. Both
halves are needed: string normalisation alone misses symlinks, and `realpath`
alone misses a `relPath` of `../../` on a path that does not exist yet (the
write case, where `realpath` must be applied to the parent directory).

This is the same rule the config verbs already follow — the epic's "no verb takes
a destination path" — and it is strictly stronger than validating a path the
renderer supplies, because there is no path from the renderer to validate.

### The channels

| Channel | Kind | Payload → result |
|---|---|---|
| `fs:read-dir` | invoke | `{projectId, relPath}` → `DirEntry[]` \| `FsError` |
| `fs:read-file` | invoke | `{projectId, relPath}` → `FileContent` \| `FsRefusal` \| `FsError` |
| `fs:write-file` | invoke | `{projectId, relPath, text, baseMtimeMs}` → `{mtimeMs}` \| `{conflict: true}` \| `FsError` |
| `fs:watch` | invoke | `{projectId}` → `void` — starts, or replaces, *the* watcher |
| `fs:unwatch` | invoke | *(no payload)* → `void` |
| `fs:changed` | main → renderer | `{projectId, paths: string[]}` |

`DirEntry` is `{ name, kind: 'dir' | 'file', size }` — no path, because the
renderer composes paths from the tree it already holds, and a path in the reply
is a path that can disagree with the one that was asked for.

`fs:read-file` refuses rather than errors in two cases, and the distinction is
user-visible: a file over **1 MB**, and a file with a NUL byte in its first 8 KB.
Both render as "Preview not available" with the size and the reason, because
neither is a failure — the app is declining to do something pointless. An
`FsError` (`ENOENT`, `EACCES`, `EISDIR`) is a different thing and reads
differently.

`fs:write-file` exists whether or not `editorEditable` is on. Gating a *channel*
on a *renderer preference* would be security theatre — the preference lives in
`localStorage`, which the thing being defended against can write. The setting
gates the UI; the guard gates the filesystem, and it gates it on containment,
which is the only property that holds regardless of what the renderer believes.

### One watcher, for the visible project

`fs.watch(root, { recursive: true })` on the project the explorer is currently
showing, and nothing else. Switching projects closes the old watcher before
opening the new one; the window closing closes it too.

Events are filtered against the hidden list **in main, before emit** — a
`node_modules` install would otherwise push tens of thousands of paths across the
bridge to be discarded in the renderer — then coalesced into a `Set` and flushed
on a 300 ms trailing debounce.

Recursive watching is supported natively on macOS and Windows, and on Linux from
Node 20. The app targets Electron 43 (Node 22), so this is available everywhere
it runs; there is no fallback path and no polling.

## Renderer modules

### `src/lib/explorer/` — the pure half

Everything here is a function of its arguments, which is what makes the
interesting decisions testable without rendering anything.

- **The hidden list** — `.git` always; then `node_modules`, `dist`, `out`,
  `.next`, `coverage`, `.turbo`, `target`, `__pycache__`, `.venv`. Other
  dotfiles are **shown**: `.claude`, `.github`, `.env.example`, `.gitignore` and
  `AGENTS.md` are all things you open in this app. A `.gitignore` parser was
  considered and declined — it needs a matcher dependency, it has to compose
  nested ignore files, and it hides `.env.local`, which is one of the files you
  most want to look at when a session will not start.

  **As built, it lives in `electron/shared/fs-contract.ts` and is applied in
  main only**, not in a `lib/explorer/hidden.ts` as this document first
  proposed. Main already has to filter watcher events before they cross the
  bridge, so a second application in the renderer would be a second place for
  the same rule to be got wrong — and would still have paid for the `stat`
  calls it was trying to avoid.
- **`sort.ts`** — directories first, then files, each `localeCompare`'d
  case-insensitively. One function, so the tree and its tests cannot disagree.
- **`language.ts`** — extension → a lazy `() => import('@codemirror/lang-…')`.
  Unlisted extensions resolve to `null` and open as plain text, which is a
  supported outcome rather than a gap.
- **`fs-client.ts`** — the bridge wrapper, shaped like `lib/project-config.ts`:
  the `fs:changed` subscription and a `useSyncExternalStore`-compatible snapshot,
  so no component reaches `window.hive` itself.

### `src/components/editor/` — fenced, like the terminal

Added to `FENCED_COMPONENT_DIRS` in `eslint.config.mjs`, so it may not import
`features/`, `stores/` or `data/`. Its whole surface is props:

```
value, language, readOnly, theme, fontFamily, fontSize,
wordWrap, lineNumbers, tabWidth, onChange
```

The reason is the reason the terminal seam exists: the composition root reads the
stores and passes values down, and the editor stays a component you could drop
into another app. `center-stage.tsx` already does exactly this for
`terminalAppearance`.

**One `EditorView`, one `EditorState` per open file.** CodeMirror keeps cursor,
scroll offset and undo history in the state, so `view.setState(states.get(key))`
on a tab switch restores all three; rebuilding the view per file would throw them
away and remount the DOM on every click.

**Theming goes through the tokens.** CM6 themes are CSS-in-JS that emit real CSS,
so `color: 'var(--cc-ink)'` resolves like any other rule and light/dark follow
`data-theme` with no JS involved. This is a genuine improvement on the terminal,
which resolves colour from a JS `theme` object and cannot see a custom property
at all — the AGENTS.md note about hand-written hex applies to xterm and does
*not* need an exception here. No hex literal appears in `components/editor/`.

### The two feature slices

`features/explorer/` (the rail panel and its recursive rows) and `features/editor/`
(the stage, the tab strip, the dirty and conflict affordances) are separate
slices and therefore may not import each other. They communicate the way the
fences intend: the explorer calls `openFile(projectId, relPath)` on the store,
and the editor renders what the store holds. Both go in `FEATURE_SLICES`.

## State

### `appearance-store` — the settings block above

Persisted, alongside `theme` and the terminal typography, for the reasons story
105 already recorded: these are facts about the person at the screen, they are
needed before first paint, and the browser target has no config file to read.

### `editor-store` — a fourth store

```ts
interface OpenFile {
  key: string;          // `${projectId}:${relPath}`
  projectId: string;
  relPath: string;
  text: string;
  mtimeMs: number;      // what the last read or write saw
  dirty: boolean;
  staleOnDisk: boolean; // changed underneath a dirty buffer
  missing: boolean;     // deleted underneath any buffer
  refusal: 'binary' | 'too-large' | null;
  error: string | null;
}
```

plus `openFiles: OpenFile[]`, `activeKey: string | null`, and the actions over
them.

AGENTS.md says three stores, and this is a fourth. The justification, so the
deviation is a decision rather than a drift:

- It is **not domain state**. `hive-store` holds what the system knows about
  sessions, tickets and PRs — things with lifetimes measured in days. A buffer is
  scratch, and folding it in grows the largest module in the app to hold data
  nothing else in it reads.
- It is **not view state**. `ui-store` is deliberately never persisted and
  deliberately cheap; `text` for a 900 KB file is neither.
- It is **not a preference**. `appearance-store` persists everything it holds,
  and persisting file contents to `localStorage` would be a bug.

The rule that keeps this honest is the one already in force: **everything in
`appearance-store` is persisted, nothing in `ui-store` is, and `editor-store`
joins `hive-store` on the un-persisted side.** `AGENTS.md` and
`docs/state-and-data.md` are updated in the same change; a fourth store that the
architecture doc does not mention is how the next person learns the docs lie.

`ui-store` gains only two things: `explorerExpanded: Record<string, boolean>`
keyed `projectId:relPath`, and `explorerProjectId: string | null` — the sticky
root for the orchestrator tab. Both are view state, both die with the window.

## The view-state machine

`resolveView` gains `'editor'`, below the two overlays and above the entity
views:

```
settings  >  picker  >  editor  >  orchestrator | session | agent
```

`'editor'` is returned only when `editorPlacement === 'full'` **and**
`activeKey !== null`. In `split` the editor is not a view state at all — it is a
layout of the entity view, and `center-stage.tsx` renders the terminal region and
the editor pane side by side under whichever view already resolved.

That asymmetry is deliberate. A view state means "this is the one thing on
screen", and in `split` the editor is emphatically not. Modelling split as a
fifth view would make `isEntityView` lie about whether the session meta bar and
the message row should be mounted.

The tab strip is **stage chrome, not editor chrome**: it renders whenever
`openFiles.length > 0`, above both the terminal region and the editor, so
selecting Terminal in `full` + `tabs` does not take the strip away with it.

## Freshness

On `fs:changed`, two things happen and they are independent.

**The tree** re-reads its currently-expanded directories. Not a path diff: the
expanded set at 316px is a handful of directories, re-reading them is a handful
of `readdir` calls, and a diff is a second model of the filesystem that can drift
from the first. Collapsed directories are not read, because they were never read.

**Open files** are reconciled by cleanliness:

| Buffer | File changed on disk | Behaviour |
|---|---|---|
| clean | yes | **silently reloaded** |
| dirty | yes | `staleOnDisk`, banner: *Changed on disk · Reload / Keep mine* |
| any | deleted | `missing`, the pane says so, the tab stays |

Silent reload of a clean buffer is the whole point of the feature in an agent
command center: you open a file to watch what the session does to it, and a
"Reload?" prompt between you and that is friction with no information in it. A
dirty buffer is the one case where the app holds something the disk does not, and
that is the only case worth a prompt.

## Saving

`⌘S` when `editorEditable` is on. The write carries `baseMtimeMs` — the mtime the
buffer was last read or written at — and main compares it to the file's current
mtime before writing. A mismatch returns `{ conflict: true }` and writes nothing;
the banner then offers **Reload** (discard mine) or **Overwrite** (write anyway,
with a fresh base).

Optimistic concurrency rather than a lock, because the other writer is an agent
in a subprocess that will never take one. mtime is coarse — two writes inside one
filesystem timestamp tick are indistinguishable — and that is accepted: the
failure it leaves open is a lost write in a sub-millisecond race against an agent
editing the same file the user is editing, which is a situation with worse
problems than this.

## Empty and degraded states

Four, each saying something the others do not:

- **No bridge** (the browser target, `pnpm dev`): *"The project explorer needs the
  desktop app."* Not an error and not a blank column — the demo surface is a
  supported target and it says so, exactly as the terminal does.
- **No projects mapped**: points at `Settings → Projects`, in the voice
  `ProjectsPanel` already uses for the same situation.
- **Project path missing or not a directory**: names the `ProjectStatus` reason,
  which is what that closed set exists for.
- **Empty directory**: *"Empty folder."* — distinguishable from a folder that
  failed to read, which is the mistake a shared empty state would make.

## What gets deleted

`features/activity-feed/**` and `tests/features/activity-feed/**`; the
`activity-feed` entry in `FEATURE_SLICES`; `types/feed.ts`; and from
`hive-store`, the `feed` slice, `FEED_CAP`, `pushFeed` (three internal call
sites), `useFeed`, and the fixture seed in `data/fixtures.ts`.

Nothing outside the store reads it. The feed is fixture data that no real event
ever reached, and AGENTS.md already lists it among the last seeded surfaces —
keeping it as a fourth rail tab would cost the rail its legibility at 276px to
preserve a panel that shows made-up rows.

## Languages

Fourteen packages, each behind a lazy `import()` so an unopened language costs
nothing at startup:

`@codemirror/lang-javascript` (js, jsx, ts, tsx), `-json`, `-css`, `-html`,
`-markdown`, `-yaml`, `-python`, `-sql`, `-rust`, `-go`, `-java`, `-php`,
`-xml`, and shell via `@codemirror/legacy-modes/mode/shell`.

Anything else opens as plain text with line numbers and wrapping intact. That is
a normal outcome, not a missing feature, and the file still reads.

## Testing

The mirror rule applies as always. The high-value targets, in order:

1. **The path guard**, in `tests/electron/main/fs/`. Traversal (`../`), absolute
   `relPath`, symlink-out-of-root, symlink-to-root-sibling, unknown `projectId`,
   and a project whose `status` is not `'ok'`. This is the only new code in the
   change where a bug is a security bug.
2. **`lib/explorer/`** — `hidden`, `sort`, `language` are pure and exhaustively
   testable.
3. **`editor-store`** — every action against a fresh store, and the freshness
   matrix above as four named cases.
4. **`resolve-view`** — the new state against the existing exhaustive table,
   including that `split` never returns `'editor'`.
5. **`appearance-store`** — the new preferences persist and reset.

**CodeMirror is *not* mocked** — this document planned to, following the xterm
precedent, and the premise turned out to be wrong. xterm cannot run under
happy-dom because it measures a cell before it can render one; CodeMirror
renders its document into the DOM without measuring first, so `.cm-content`
really contains the text and the tests assert the real thing. `__mocks__/` gains
nothing here, and a fake would assert less. Colour, scrolling and selection
still belong in Playwright, which a mock could never have covered either.

Rendering, theming and the split divider belong in Playwright, which is also
where "does the tree actually render" is answered: a green type-check does not
prove a panel appears.

## Explicitly not in this change

- **Image and binary previews.** Refused with a reason, not rendered.
- **Creating, renaming, deleting or moving files.** The tree reads; the terminal
  is where the filesystem is mutated, and it already is.
- **Search across files, git status decoration, diff view.** Each is its own
  feature and each wants its own data path.
- **Multiple projects in one tree.** The root follows the session, and that is
  the whole model.
- **Restoring open files across launches.** `editor-store` is not persisted.
