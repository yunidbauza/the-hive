# 107 — Advanced & Diagnostics

| | |
|---|---|
| **ID** | HIVE-107 |
| **Epic** | [Settings](100-settings-epic.md) |
| **Depends on** | [101-settings-add-local-project.md](101-settings-add-local-project.md) |
| **Blocks** | [108](100-settings-epic.md) |
| **Points** | 3 |
| **Location** | `app/src/features/settings/`, `app/electron/main/config/index.ts`, `app/electron/main/ipc/index.ts`, `app/electron/shared/ipc-contract.ts` |

## Story

> As a user, I want to see the config file, reload it after editing it by hand,
> put it back to its template, and read what this build is made of — so that
> when something is wrong I have somewhere to look that is not a console I was
> never asked to open.

## What the epic asked for, and what was already there

The epic's story table is the whole brief this story started from — the story
file did not exist, so there were no acceptance criteria to inherit:

> Reveal config in Finder, explicit reload, reset to template, versions and PTY
> diagnostics from `appInfo()`, log location.

Reconciling that against the codebase before planning anything changed the shape
of the work substantially. Two of the five items were already built and reached
no UI:

| The epic asked for | What was already there |
|---|---|
| Explicit reload | The whole path, since [090](090-workspace-config.md). `config.reload()` on the bridge, `reloadProjectConfig()` in `src/lib/project-config.ts` — called only by tests. |
| Versions and PTY diagnostics | `appInfo()` already answered with `version`, `electron`, `chrome`, `node`, `platform` and `pty?: PtyDiagnostics[]`. Nothing displayed any of it. |
| Reveal config | Nothing. `shell.showItemInFolder` appeared nowhere. |
| Reset to template | Nothing. `CONFIG_TEMPLATE` existed. |
| Log location | **Nothing writes a log file.** Main logs to stdout with a `[hive]` prefix; `app.getPath('logs')` was never called. |

So this story is two new verbs, one new field, one new pane — and the discovery
that the fifth item was a question the codebase could not answer honestly.

## Why there is no log file

The epic's *Explicitly not in this epic* list does not mention logging, so the
temptation was to build it. This story does not, and says so rather than quietly
narrowing the ask.

A real log file is a sink, rotation, a decision about what every `console.error`
in main becomes, and a second surface that has to be truthful about what it
captured. That is a logging feature which a diagnostics pane would then report
*on* — comfortably larger than three points, and a different story.

What the pane does instead is report `app.getPath('logs')` as text and say
exactly what is and is not there: that the app writes to stdout, and that the
directory is Electron's, where a crash report would land. A **Reveal logs**
button that opened an empty folder while implying the app had written to it
would answer the user's question *wrongly*, which is worse than not answering
it.

`logPath` therefore joins `AppInfo`, which already existed "for the About box
and bug reports". It is the same kind of fact as `electron` and `chrome`.

## The bridge surface

Two verbs, and **neither takes an argument**.

```ts
config: {
  revealConfig(): Promise<void>;
  resetConfig(): Promise<ConfigSnapshot>;
}
```

That is the whole security story for both, and it is the shape
[106](100-settings-epic.md)'s `integrations.status()` established. The epic's
binding rule is that no verb takes a destination path; taking no argument at all
is strictly stronger. With nothing arriving from the renderer there is no
payload guard to write, nothing to inject into, and no way for a compromised
renderer to aim either verb at a file main did not choose — main resolves the
target from its own `configPath()` in both cases.

`showItemInFolder` rather than `openPath`: it selects the file in a folder
window instead of handing it to whatever application has claimed `.json`, and it
is the one of the two that cannot launch a program.

`resetConfig` returns `ConfigSnapshot` because the epic requires every mutating
verb to, and because the pane must re-render the emptied project list without
following a write with a reload.

An earlier shape gave `reveal` a `target: 'config' | 'logs'` enum so the log
directory could be revealed too. It was dropped along with the reveal-logs
button: a closed enum would have been defensible, but an argument that exists to
serve a button that is not shipping is surface added for nothing.

## Reset is a write like any other — with one exception

`resetConfig` is `writeConfig(() => JSON.parse(CONFIG_TEMPLATE))` and nothing
more. It inherits the epic's whole write discipline rather than reimplementing
any of it: the file is re-read from disk first, the result is validated by the
*reader's* own parser before anything touches disk, the swap is a temp file plus
`rename`, and the file's mode and any symlink into a dotfiles repo survive. A
reset that wrote the template string straight to the path would be the one write
in the app that could leave a torn file.

`JSON.parse` of the template rather than the string verbatim, for two reasons:
the mutation keeps the same shape as every other (a `ConfigDocument` in, one
out), and the template goes through the reader's validator — so a template this
build could not read back fails in CI rather than on a user's machine. The
`"//"` comment keys survive `JSON.parse`, so what lands on disk is still the
commented file.

**This is the one mutation that deliberately discards user data**, and therefore
the one exception to the epic's preservation promise. Unknown top-level keys and
hand-written comments ride across every other write and are replaced here. That
is what reset means, and the confirmation says so in those words rather than
asking a generic "are you sure?".

`writeConfig` refuses when there is no file to read, so a reset with the config
deleted underneath reports that rather than recreating it. Recreating it is
`reload`'s job — `loadConfig` writes the template when the file is gone — and
exactly one path that creates the file is worth the extra click.

## The pane

A fifth nav entry, **Advanced**, last. Two lines in `SECTIONS` and `PANES`,
which is precisely what stories 104, 105 and 106 each cost and what the
overlay's own comment predicted. It sits last because it is the only section
that answers questions about the app rather than setting anything in it, and
because the one destructive verb in the product lives there.

Four groups, composed from the shared `SettingsGroup` like every other section.

**Config file.** The path in monospace, and two buttons. *Reveal* is labelled
per platform — Finder, Explorer, or a neutral "Show in file manager" — read from
`AppInfo.platform` rather than the user agent, which in Electron is a Chrome UA
and lies by design ([083](083-runtime-target-transport.md)). *Reload* is the
answer the epic promised when it declined a config watcher, so it is not a
convenience here but the entire mechanism by which a hand-edited file reaches a
running app. It **reports what it found** — a project count, or the problems the
reload surfaced — because a button that flashes and says nothing leaves the user
unable to tell a successful reload from a broken one, which is the question they
pressed it to answer.

That report is resolved in an effect keyed on the snapshot, not read in the
click handler. The handler's `snapshot` is that render's closure and is by
definition the *pre*-reload value, so counting there would always describe the
config the user was already looking at.

**Reset.** Behind an inline confirmation following `project-remove-confirm.tsx`
exactly, rather than a second dialect of "confirm a destructive thing". Focus
lands on Cancel, Escape backs out, and the copy names what is actually
irreversible: the projects, the overrides, the notification preferences, and the
comments no other write discards. It does not claim anything happens to the
repositories — resetting forgets where they are; the directories are untouched
and running PTYs keep running.

**About.** The versions. This is the About box the app has never had;
`electron/main/menu.ts` gains no About item, because the pane is the surface.

**Diagnostics.** The per-session flow-control counters, raw and not humanised —
the *ratio* between them is what diagnoses a bug (`bytesIn / batches` is the
coalescing ratio) and "2.1 MB" destroys exactly that precision. An absent `pty`
field renders as a sentence: main omits it rather than sending an empty array
precisely so "nothing has run" can be told apart from "sessions ran and moved no
bytes", and the pane keeps that distinction.

The counters carry an explicit **Refresh** rather than a subscription.
`appInfo()` is `invoke`-only, there is no push channel for these numbers and
this story adds none. Polling would re-render a settings pane every second for
numbers nobody is watching, and the moment they become useful is the moment the
user deliberately asks for them.

The log-location line closes the group.

## Files this touches

| File | Change |
|---|---|
| `electron/shared/ipc-contract.ts` | `CH.configReveal`, `CH.configReset`; `AppInfo.logPath`; two verbs on `HiveBridge.config`; `BRIDGE_CONFIG_KEYS` |
| `electron/main/config/index.ts` | **`resetConfig`**, on top of the existing `writeConfig` |
| `electron/main/ipc/index.ts` | two handlers, neither with a payload guard because neither takes a payload; `logPath` on the `appInfo` answer |
| `electron/preload/index.ts` | expose the two verbs |
| `src/lib/project-config.ts` | `revealConfigFile`, `resetConfigToTemplate`, `readAppInfo` |
| `src/features/settings/components/advanced-section.tsx` | **new** — the pane |
| `src/features/settings/components/config-reset-confirm.tsx` | **new** — the confirmation |
| `src/features/settings/components/settings-overlay.tsx` | the fifth `SECTIONS` row and `PANES` entry |

No guard was added to `electron/shared/guards.ts`, and that absence is the
point: there is no payload to guard.

## Tests

`tests/` mirrors `src/`; the 80% gate applies
([013](013-testing-infrastructure.md)).

**`tests/electron/main/config/reset.test.ts`** (new) — against real files, like
every other write test.

- A populated config becomes the commented template; `shell` and
  `claudeCommand` are gone and `"//"` is back.
- The unknown keys and comments every other verb preserves are discarded.
- The returned snapshot is one the renderer can install without reloading.
- With no file on disk the verb refuses and reports, rather than recreating one.

**`tests/electron/preload/bridge.test.ts`** — the two verbs reach their
channels, and a caller who tries to smuggle an argument has it dropped. The
existing exact-key-set assertion derives from `BRIDGE_CONFIG_KEYS` and updates
itself.

**`tests/lib/project-config.test.ts`** — reset goes through `mutate`, so a
refusal keeps the last good snapshot; reveal and `readAppInfo` do not, and
answer null or fall silent rather than installing anything.

**`tests/features/settings/components/config-reset-confirm.test.tsx`** (new) —
focus starts on Cancel, Escape backs out from either button, the destructive
callback fires only from the destructive button, and the copy names the
comments.

**`tests/features/settings/components/advanced-section.test.tsx`** (new) — the
platform-specific reveal label, the reload report against the snapshot the
reload *installed*, the confirmation gate, the counters and their refresh, the
absent-`pty` sentence, and the no-bridge degradation.

**`tests/e2e/electron/advanced-settings.spec.ts`** (new) — against the built
app and a `HIVE_CONFIG_PATH` sandbox: real versions over a real channel, reload
picking up an edit made underneath a running app, reset writing the template and
discarding the comment and unknown key it is allowed to eat, and cancel leaving
the file alone.

**Reveal is deliberately not driven in e2e.** `shell.showItemInFolder` opens a
real Finder window on whatever machine runs the suite. Its contract is covered
where it can be — the preload test and the security spec's key set.

## Acceptance criteria

- [x] Settings shows an **Advanced** section, last in the nav.
- [x] The config file's path is on screen, and one button reveals it in the
      platform's file manager.
- [x] Reload re-reads a file edited outside the app and **says what it found** —
      a project count, or the problems it surfaced.
- [x] Reset is gated by a confirmation that names the projects, the overrides,
      the preferences and the comments; cancelling writes nothing.
- [x] Reset produces the commented template on disk, atomically, and the project
      list empties without a reload.
- [x] The app version and Electron's, Chromium's and Node's are on screen.
- [x] Per-session PTY flow-control counters are on screen with an explicit
      refresh, and "no session has run yet" reads as a sentence rather than an
      empty list.
- [x] The log directory is named, with honest copy that the app writes no log
      file.
- [x] Neither new bridge verb accepts an argument, and both appear in
      `BRIDGE_CONFIG_KEYS` and the security spec's exact key set.
- [x] `pnpm lint`, `pnpm type-check`, `pnpm test:coverage`,
      `pnpm verify:boundaries` and `pnpm test:e2e` all pass.

## Out of scope

- **A log file, a log sink, or log rotation.** Reported above.
- **Watching the config file.** The epic declined it and this story is the
  alternative, not a step toward it.
- **An About menu item.** The pane is the surface.
- **Exporting or importing a config.** Not asked for, and it is a sync feature
  in a small coat — the epic rules sync out.
- **A push channel for the PTY counters.** Refresh, not a subscription.
