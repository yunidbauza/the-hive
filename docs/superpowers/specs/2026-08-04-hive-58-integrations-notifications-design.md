# HIVE-58 / story 106 — Integrations & notifications (design)

| | |
|---|---|
| **Ticket** | HIVE-58 |
| **Story** | 106 — Integrations & notifications |
| **Epic** | [100 — Settings](../../../stories/100-settings-epic.md) |
| **Points** | 5 |
| **Depends on** | 101 (HIVE-52, done) |
| **Base** | `origin/main` @ `c6e58b9` |

The epic gives this story one line:

> `gh` CLI detection and auth status, the token source for the PR panel, OS
> notification preferences per event class

No story file was ever written for 106, and none is written here: stories 102–105
all shipped with a design doc under `docs/superpowers/specs/` instead, and this
follows them. The ticket's claim that acceptance criteria "arrive with the story
file `stories/106-*.md`" is stale, and is recorded as a deviation below.

## Reconciliation — what the code says

Reconciled against `origin/main` @ `c6e58b9` before design. Five findings, four of
which change what this story is.

### 1. The section surface is settled, and costs two lines

`settings-overlay.tsx:44-62` has a real `SECTIONS` / `PANES` switcher. The epic
claimed the nav was "already built to hold six"; that was false when written and
true now — story 105 landed the switcher. Adding Integrations is one row and one
map entry, exactly as promised. Nothing about the overlay is redesigned here.

### 2. "The token source for the PR panel" has no consumer — scope corrected

The PR panel is entirely fixture-backed. `prs-panel.tsx:12` reads `usePrs()` off
the store, and `pr-card.tsx:16` documents that clicking a card opens *the session
that produced it*, not the PR on GitHub. There is no GitHub client, no `octokit`,
no network call anywhere in `src/` or `electron/` — the only `github` strings in
the tree are a clone-URL parser and an input placeholder. Real PR data is not even
on `stories/README.md`'s "After phase 2" list.

So a token configured here would be a credential nothing reads, persisted in a
plaintext file the product actively encourages hand-editing (`template.ts` is
comment-heavy on purpose, and 101 made comment preservation a rule).

**Decision: this story never stores a token.** It *resolves and reports* which
source would supply one — `gh`'s own keyring, or `GH_TOKEN` / `GITHUB_TOKEN` in
the environment, or none — and says plainly in the UI that the PR list is
fixture-backed today. Reporting a source is useful now (it is the same answer the
future real-PR story needs, and it is the thing a user gets wrong); storing a
secret is not, and would have to be undone.

Only the *presence* of an environment variable is ever read. The value is never
loaded into a result, never logged, never crosses the bridge.

### 3. OS notifications have no emitter, and the wanted class does not exist

Electron's `Notification` API is used nowhere. This story builds the emitter, not
just its preferences.

The only events main can honestly observe are `DerivedStatus = 'working' | 'idle'
| 'done'` (`session-contract.ts:24`, delivered over `session.onStatus`) and clone
completion (`CloneDoneEvent`). Critically, `waiting` — the state the entire
attention model is built around — is **not derivable from a PTY**
(`sessions/activity.ts:5-22`), and `stories/README.md:295` names it as the next
epic's whole subject.

**Decision: only event classes backed by a real event ship.** No `waiting` toggle,
not even disabled. The epic's own rule for the section nav applies here verbatim —
*absent rather than disabled*, because a dead switch teaches the user the feature
is broken.

### 4. `gh` detection needs a capability main does not have

Nothing under `electron/main` executes a process; `node-pty` lives in the pty-host
utility process. Running `gh auth status` is genuinely new surface in main and
gets its own security reasoning (below).

The PATH probe that story 104 built is the right mechanism for detection, but it
is inlined inside `diagnoseCommand(runtime, projectId, baseEnv)`
(`config/runtime.ts:105-165`) and hardwired to `runtime.claudeCommand`. It is
extracted to a reusable helper here rather than copied.

### 5. Storage: config.json, diverging from 105 — deliberately

Story 105 established that renderer preferences persist to `localStorage` via
`appearance-store`, structurally *not* `~/.hive/config.json`. Notification
preferences look like the same kind of thing and are not: **main fires the
notifications**, so main must be able to read the preference. The epic's binding
rule (through the single `writeConfig`) is correct here. Recorded so it does not
get re-litigated mid-implementation.

## What ships

Three parts behind two new IPC verbs and one new section.

### Part 1 — `probeCommand`, extracted

`electron/main/config/probe.ts`

```ts
export interface CommandProbe {
  isPath: boolean;
  resolved: string | null;
  probes: PathProbe[];
}
export function probeCommand(command: string, path: string): CommandProbe;
```

The loop currently inside `diagnoseCommand` moves here unchanged — same POSIX-only
stance, same skip of empty PATH entries, same `notExecutable` flag, same refusal to
resolve a relative path against a cwd this process does not share.
`diagnoseCommand` becomes a thin composition over it and keeps its signature and
its behaviour. Story 104's existing tests are the regression proof; they are not
modified.

### Part 2 — `integrations:status`, a read-only verb

`electron/main/integrations/gh.ts`, surfaced as `hive.integrations.status()`.

```ts
export type GhTokenSource = 'keyring' | 'env' | 'none';

export interface GhStatus {
  installed: boolean;
  resolved: string | null;    // absolute path, or null
  path: string;               // the PATH actually consulted
  probes: PathProbe[];        // why it was not found
  version: string | null;
  authenticated: boolean;
  account: string | null;     // the login gh reports
  tokenSource: GhTokenSource;
  envVar: 'GH_TOKEN' | 'GITHUB_TOKEN' | null;
  error: string | null;       // ran, but failed — timeout, non-zero, unparseable
}

export interface IntegrationsStatus {
  gh: GhStatus;
  notificationsSupported: boolean;
}
```

One verb rather than two: the section needs both facts on open, and a single round
trip keeps the pane from painting twice.

**The verb takes no parameters at all.** That is the security design, not an
omission — no renderer input reaches an argv, so there is nothing to inject.

Execution rules, each load-bearing:

- `execFile`, never `exec`, never a shell.
- The **resolved absolute path** from `probeCommand` is what runs — never the bare
  name `gh`. Resolving once and executing that exact path removes the window where
  PATH resolves differently between the check and the run.
- argv is the constant `['auth', 'status']`, and separately `['--version']`.
- 5s timeout, `killSignal`, and a `maxBuffer` cap. A hung `gh` must not hang the
  settings pane.
- `--show-token` is never passed. `gh` redacts by default; the parser additionally
  keeps only the fields named above, so no stdout ever reaches the renderer
  verbatim.
- Env is the resolved top-level runtime env (the same `effectiveRuntime` the spawn
  path uses), so the answer describes the environment sessions actually run in —
  the same discipline story 104 applied to the PATH diagnostic.

`tokenSource` is decided as: `env` when `GH_TOKEN` or `GITHUB_TOKEN` is present and
non-empty (`GH_TOKEN` wins, matching `gh`'s own precedence); otherwise `keyring`
when `gh` reports an authenticated account; otherwise `none`. An env var present
*and* a keyring account is still `env`, because that is which one `gh` would use.

Not installed, or not authenticated, or erroring, are all ordinary answers — never
a thrown IPC error. A settings pane that throws because a tool is missing is
telling the user the app is broken when the tool is what is missing.

### Part 3 — notification preferences and the emitter

**Schema.** A new optional top-level key, added to `TOP_LEVEL_KEYS` in
`parse.ts:72`:

```jsonc
"notifications": { "sessionDone": true, "sessionIdle": false, "cloneDone": true }
```

`CONFIG_VERSION` does **not** move. An absent key resolves to defaults, so every
existing v1 and v2 file reads unchanged and nothing is rewritten until the user
toggles something — the same "reading someone's file is not a migration" rule the
epic already binds.

`ConfigSnapshot` gains `notifications: NotificationPrefs`, always fully resolved
with defaults applied, matching how `shell` and `claudeCommand` are always
resolved rather than optional.

**The three classes, and why only three:**

| Class | Fires on | Default | Why |
|---|---|---|---|
| `sessionDone` | pty exit → `DerivedStatus` `done` | on | The thing a user walks away from and wants back for |
| `sessionIdle` | output stopped for `ACTIVITY_IDLE_MS` | **off** | Real, but chatty — a build that pauses is not news |
| `cloneDone` | `CloneDoneEvent`, success or failure | on | Long, unattended, and already a discrete event |

**New verb** `config:set-notifications` → `setNotifications(request)`, partial in
exactly the way `setRuntime` is (only named fields are touched, so saving one
switch never restates the others), returning a fresh `ConfigSnapshot` through the
single `writeConfig`. Guarded in `guards.ts` with `assertShape` + boolean asserts,
unknown keys rejected, `__proto__` rejected — 082's rules, unchanged.

**Emitter** — `electron/main/notifications/index.ts`, subscribed to the signals
main already owns.

- `Notification.isSupported()` is checked before every send. On a Linux box with no
  notification daemon it is false, and the emitter must no-op rather than throw.
  The same boolean reaches the UI so the section can say so instead of offering
  switches that do nothing.
- **No focus suppression.** Main cannot know which session the user is looking at —
  `activeTab` is renderer state — so the only rule main could apply alone is
  "suppress while any window is focused", which would suppress precisely the
  background-session-finished case the feature exists for. The per-class switch is
  the control; there is no second, invisible one.
- Clicking a session notification focuses the window and opens that session. A new
  main→renderer event `notifications:activate` carries the entity id, following the
  established `session.onStatus` shape; the renderer opens the tab. Without it the
  notification is a dead end that makes the user hunt for the terminal it was
  about.

### Part 4 — the Integrations section

`src/features/settings/components/integrations-section.tsx`, plus the two promised
lines in `settings-overlay.tsx`. Three groups:

1. **GitHub CLI** — found at *path*, version; or not found, with the PATH probe
   list explaining where it looked.
2. **Token source** — which source would supply the PR panel's token, and a plain
   sentence that the PR list is fixture-backed today and that nothing here stores a
   token.
3. **Notifications** — three switches, or a "this system has no notification
   support" note when `notificationsSupported` is false.

Two small extractions, both earning their place by gaining a third consumer:

- `Group` is byte-identical in `runtime-section.tsx:30` and
  `appearance-section.tsx:52`. It moves to
  `@features/settings/components/settings-group.tsx` and all three import it.
- The PATH-probe list rendering moves out of `command-diagnostic-view.tsx` into a
  `path-probes.tsx` shared with the gh group, so "where it looked" is explained
  identically in both places.

- `src/components/ui/switch.tsx` — a new primitive over Radix's `Switch`, vendored
  the way `dialog.tsx` was. **No new dependency**: `Switch` ships inside the
  `radix-ui` package already at `^1.6.7`. The repo has no boolean control today —
  `segmented-control` is the nearest, and three On/Off segmented controls in a
  column is the wrong shape.

## Testing

**Unit** (vitest, the existing `tests/` mirror layout):

- `probeCommand` extraction — behaviour preserved; 104's `diagnoseCommand` tests
  are the regression proof and are not touched.
- gh status parsing: not installed; installed but not authenticated; authenticated
  via keyring; `GH_TOKEN` present; `GITHUB_TOKEN` present; both present
  (`GH_TOKEN` wins); non-zero exit; timeout. **Plus an explicit test that no token
  value appears anywhere in the result** even when the environment holds one.
- Notification prefs: absent key → defaults; partial key → defaults for the rest;
  the write is partial (setting one switch does not restate the others); unknown
  top-level keys and `"//"` comments survive the new verb; a hand-written
  non-boolean is reported, not coerced.
- Guard rejections for `config:set-notifications`: non-boolean, unknown key,
  `__proto__`, empty request.
- Emitter: fires per class, respects each preference, no-ops when
  `Notification.isSupported()` is false, and emits `notifications:activate` with
  the entity id on click.
- Section component: renders each gh state; toggling a switch calls the verb.

**e2e** (Playwright `_electron`, against a `HIVE_CONFIG_PATH` sandbox):

- Settings → Integrations opens and reports a gh state without throwing when `gh`
  is absent from the runner's PATH.
- Toggling a notification switch lands in the sandboxed `config.json`, with the
  template's comments intact.

The bridge-surface alarm tests (the preload key set, and the e2e `window.hive`
surface) will fire by design — they are updated with the reasoning for the new
`integrations` namespace, as 104 did.

**Local gates are the whole verification.** This repo has no CI:
`app/.github/workflows/` holds only a `.gitkeep`, and GitHub reads workflows at the
repo root. Story 071's workflow is still unimplemented.

## Deviations to record on the ticket

1. The token is resolved and reported, never stored — the PR panel has no consumer
   for one.
2. Event classes are limited to real events; no `waiting` class.
3. No story file; the design doc is the spec, following 102–105.
4. `CONFIG_VERSION` stays at 2 — a new optional top-level key needs no bump.

## Scope note for 108 (HIVE-60)

`config:set-notifications` is a sixth mutating verb for the conformance suite. Its
interesting case is the partial write: saving `sessionIdle` must leave a
hand-written `sessionDone` byte-identical, and an absent `notifications` key must
stay absent until the user touches a switch. `integrations:status` is read-only and
should be shown not to touch the file at all.

## Explicitly not in this story

- Real PR data, a GitHub API client, or anything that consumes a token.
- `gh` actions — no `gh auth login` from the app. Detection and reporting only; the
  fix is one command in a terminal the user already has.
- A `waiting` notification class, and the Claude Code hook that would make it real.
- Notification history, grouping, or per-project overrides.
