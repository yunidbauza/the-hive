# 107 — Advanced & diagnostics (design)

Jira: **HIVE-59** · Epic: HIVE-51 (100 — Settings) · 3 points · depends on 101 (HIVE-52, Done)

The epic's story table is the only spec this story has; no `stories/107-*.md` was
ever written. What it records is the whole brief:

> Reveal config in Finder, explicit reload, reset to template, versions and PTY
> diagnostics from `appInfo()`, log location.

This document is the missing story file's substance: what the reconciliation
against the codebase found, the decisions that follow from it, and the surface
this ships.

## What the reconciliation found

| The story asks for | What exists today |
|---|---|
| Explicit reload | **The whole path already exists and reaches no UI.** `config.reload()` has been on the bridge since story 090; `reloadProjectConfig()` sits at `src/lib/project-config.ts:117` and only tests call it. |
| Versions and PTY diagnostics | **`appInfo()` already answers with all of it** — `version`, `electron`, `chrome`, `node`, `platform`, and `pty?: PtyDiagnostics[]` (`electron/shared/ipc-contract.ts:305`). No renderer surface displays any of it. |
| Reveal config in Finder | Does not exist. `shell.showItemInFolder` appears nowhere; `electron/main/external-links.ts` guards `openExternal` for `http(s)` only. |
| Reset to template | Does not exist. `CONFIG_TEMPLATE` exists in `electron/main/config/template.ts`. |
| Log location | **Nothing writes a log file.** Main logs to stdout with a `[hive]` prefix; `app.getPath('logs')` is never called. |

So two of the five items are wiring, two are new verbs, and one — the log
location — is the only place where the story's phrasing outruns the codebase.

Two comments already in the tree name this story by number and constrain it:
`src/features/settings/components/settings-overlay.tsx:41` ("107 fills the last
slot the same way") and `electron/shared/config-contract.ts:380` ("story 107
owns reload"). Neither is being contradicted.

## The decision the log location forces

The epic's "Explicitly not in this epic" list does not mention logging, so the
temptation is to build it. This story does not, and says so rather than
quietly narrowing.

The app has no log file. Adding one is a real piece of work — a sink, rotation,
a decision about what main's `console.error` calls become, and a second surface
that has to be truthful about what it captured. That is not a diagnostics
feature; it is a logging feature that a diagnostics pane would then report on,
and it is comfortably larger than the three points this story carries.

What the pane does instead is **report `app.getPath('logs')` as text and say
exactly what is and is not there**: that the app itself writes to stdout, and
that this directory is Electron's, where crash reports land. A "Reveal logs"
button that opened an empty folder while implying the app had written to it
would be worse than the honest sentence — it would answer the user's question
wrongly instead of not answering it.

`logPath` therefore joins `AppInfo`, which already exists "for the About box and
bug reports". It is the same kind of fact as `electron` and `chrome`, and it
belongs in the same payload rather than behind a verb of its own.

## The bridge surface this adds

Two verbs, both taking **no payload at all**.

```ts
config: {
  revealConfig(): Promise<void>;
  resetConfig(): Promise<ConfigSnapshot>;
}
```

That is deliberate, and it is the whole security story for both. The epic's
binding rule is that *no verb takes a destination path*
(`stories/100-settings-epic.md:86`); these go further and take no argument,
so — exactly like `integrations.status()` (story 106) — there is nothing
arriving from the renderer to guard, no payload parser to write, and no way for
a compromised renderer to aim either verb at something main did not choose.
Main resolves the target from its own `configPath()` in both cases.

An earlier shape for reveal took a `target: 'config' | 'logs'` enum so the log
directory could be revealed too. It is dropped with the reveal-logs button: a
closed enum would have been defensible, but an argument that exists to serve a
button that is not shipping is surface added for nothing.

`resetConfig` returns `ConfigSnapshot`, because the epic requires every mutating
verb to (`100-settings-epic.md:160`), and because the pane must re-render the
emptied project list without following the write with a reload.

Both are appended to `BRIDGE_CONFIG_KEYS`, and both must be added to the exact
key-set assertion in `tests/e2e/electron/security.spec.ts` — that assertion
fails the build otherwise, which is the point of it.

## Reset is a write like any other

The epic's write rule applies unchanged: read the file on disk now, apply in
memory, validate the whole result with the read path's parser, write to a temp
file in the same directory, `rename` over the target, return the fresh snapshot.
So `resetConfig` is `writeConfig(() => JSON.parse(CONFIG_TEMPLATE))` and nothing
more — it inherits atomicity, validation and the snapshot from the one write
path rather than reimplementing any of them.

`JSON.parse` of the template rather than writing the template string verbatim,
for two reasons. It keeps the mutation the same *shape* as every other mutation
(a `ConfigDocument` in, a `ConfigDocument` out), and it puts the template
through the reader's own validator — so a template that this build's parser
would reject fails in CI rather than on a user's machine. The template's `"//"`
comment keys survive `JSON.parse`, so the reset file is still the commented one.

**Reset is the one mutation that deliberately discards user data**, which makes
it the one exception to the epic's preservation promise: unknown top-level keys
and hand-written comments are preserved across every *other* write and are
replaced here. That is what "reset" means, and the confirmation says so in those
words rather than asking a generic "are you sure?".

## The pane

A fifth nav entry, **Advanced**, last — two lines in `SECTIONS` and `PANES`,
which is exactly what stories 104, 105 and 106 each cost and what the overlay's
comment predicted. Four groups, composed from the shared `SettingsGroup` the way
every other section is.

### 1. Config file

The path in monospace, and two buttons.

- **Reveal in Finder** — labelled per platform (`Finder` on darwin, `Explorer`
  on win32, `Show in file manager` elsewhere), read from `AppInfo.platform`
  rather than the user agent, per story 083's feature-detection rule.
- **Reload** — the answer the epic promised when it declined a config watcher:
  "a config that changes under a live session raises questions about the PTY
  already running in the old directory … the explicit reload in 107 is the
  answer." It re-reads and then **reports what happened** — the project count,
  or the errors the reload surfaced. A reload button that flashes and says
  nothing leaves the user unable to tell a successful reload from a broken one.

### 2. Reset to template

Destructive, and gated by an inline confirmation that follows
`project-remove-confirm.tsx` — the pattern story 103 already established, so
this is not a third dialect of "confirm a destructive thing". The confirmation
names what is lost, counted from the live snapshot: N projects, per-project
runtime overrides, notification preferences, and any comments the user added.

### 3. About

`version`, `electron`, `chrome`, `node`, `platform` from `appInfo()`. This is
the About box the app has never had; `electron/main/menu.ts` has no About item
and this story does not add one — the pane is the surface.

### 4. Diagnostics

The per-session flow-control counters from `AppInfo.pty`: bytes in, bytes acked,
unacked, pauses, batches, dropped, paused. Their doc comment says why they
exist — "flow-control bugs are otherwise diagnosed by staring at a slow terminal
and guessing."

`appInfo()` is `invoke`-only; there is no push channel for these numbers and this
story does not add one. So the group carries an explicit **Refresh** rather than
a subscription. A polling interval was considered and rejected: it would re-render
a settings pane every second for numbers nobody is watching, and the moment these
are useful is the moment the user deliberately asks for them.

Absent `pty` — no session has ever run — is rendered as a sentence saying so.
The field is omitted rather than empty precisely so this can be distinguished
from "sessions ran and moved no bytes", and the pane keeps that distinction.

The log location line lives here, at the bottom of the group, with the honest
copy described above.

## Data flow

Renderer verbs go in `src/lib/project-config.ts` alongside every other config
call, and components reach them through it — never `window.hive` directly.

- `revealConfigFile()` — fire-and-forget, no snapshot to install, so not routed
  through `mutate`. Returns silently with no bridge (the browser demo).
- `resetConfigToTemplate()` — routed through `mutate`, like every other write, so
  a refusal leaves the last good snapshot in place (the bug story 103 fixed).
- `readAppInfo()` — new, alongside `readIntegrationsStatus()` and
  `diagnoseAgentCommand()`, which are the two existing read-only bridge calls
  that install no snapshot. Returns `null` with no bridge or on a failed channel,
  and the pane says so rather than rendering fabricated version numbers.

The reload path already exists (`reloadProjectConfig`) and is used as-is.

## Testing

Unit tests mirror `src/`, per `AGENTS.md`:

- `tests/features/settings/components/advanced-section.test.tsx` — each group
  renders; reload reports its outcome; reset is gated by the confirmation and
  calls through only after it; refresh re-reads `appInfo`; no-bridge and
  no-`pty` states render their sentences rather than blanks.
- `tests/features/settings/components/config-reset-confirm.test.tsx` — the
  confirmation names the counts and cancels without calling through.
- `tests/lib/project-config.test.ts` — the three new lib functions, including
  the no-bridge and rejected-channel branches.
- `tests/electron/preload/bridge.test.ts` — the two new verbs invoke their
  channels.
- `tests/electron/main/config/*.test.ts` — reset writes the template, preserves
  nothing, and returns a snapshot with no projects.
- `tests/features/settings/components/settings-overlay.test.tsx` — the fifth nav
  entry.

E2E, against the built app and a `HIVE_CONFIG_PATH` sandbox:

- `tests/e2e/electron/security.spec.ts` — the two new keys, in the exact-set
  assertion.
- `tests/e2e/electron/advanced-settings.spec.ts` — the reset round trip against
  a sandbox config: add a project, reset, the file on disk is the template and
  the project list is empty. Reveal is asserted at the bridge level only —
  driving a real Finder window from a spec is not something to do to CI.

## Explicitly not in this story

- **A log file, a log sink, or log rotation.** Reported above.
- **A config file watcher.** The epic declined it and this story is the
  alternative, not a step toward it.
- **An About menu item.** The pane is the surface.
- **Exporting or importing a config.** Not asked for; it is a sync feature in
  a small coat, and the epic rules sync out.
