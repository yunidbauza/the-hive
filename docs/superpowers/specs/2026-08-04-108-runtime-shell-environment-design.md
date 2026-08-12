# 108 — Login shell defaulting and workspace environment — design

| | |
|---|---|
| **Ticket** | unassigned |
| **Epic** | [100 — Settings](../../../stories/100-settings-epic.md) (HIVE-51) |
| **Depends on** | 104 (HIVE-56) — runtime section, `EnvEditor`, `effectiveRuntime`, the write path |
| **Points** | 3 |
| **Location** | `app/electron/shared/`, `app/electron/main/config/`, `app/src/features/settings/` |

Story 104 made `shell`, `claudeCommand` and per-project `env` editable. Using
it against real projects surfaced two things it did not cover: the default
shell is not the user's shell, and there is no environment layer above a single
project.

The reported symptom was a session that could not find a command the user runs
constantly in their terminal. The cause was not the command.

## What already exists (reconciled against the code, not the ticket)

- **`$SHELL` is documented but never read.** Three places promise it —
  `config-contract.ts:188` ("already defaulted from `$SHELL`"),
  `config-contract.ts:231` ("Used when the file names no shell and `$SHELL` is
  unset"), and `template.ts:25` ("Defaults to $SHELL") — but the only
  resolution site is `write.ts:219`, `validated.shell ?? DEFAULT_SHELL`. There
  is no `process.env.SHELL` read anywhere in `app/electron`. Every project
  without an explicit override has always spawned `/bin/sh`, on every platform.
  This is a documentation-versus-behaviour mismatch, not a default worth
  tuning.
- **Sessions are login shells.** `LOGIN_SHELL_ARGS = ['-l']`
  (`sessions/index.ts:132`), applied at `sessions/index.ts:497`. A login shell
  that is also interactive — which a PTY is — sources the user's rc file. With
  the right shell, `-l` already carries PATH, functions, aliases and exports
  into the session at no cost. With `/bin/sh` it carries none of them, because
  `sh` does not read `.zshrc`.
- **Environment is per-project only.** `ProjectConfig.env` exists
  (`config-contract.ts`), and `effectiveRuntime` resolves it as
  `env: { ...(project?.env ?? {}) }` (`config/runtime.ts:49`). `ConfigSnapshot`
  has top-level `shell` and `claudeCommand` but **no top-level `env`**. There is
  no way to say "these variables apply everywhere".
- **The editor already exists.** `env-editor.tsx` is a validated name/value row
  editor with draft state and explicit commit. It is bound to one project. It
  needs no changes to serve a second caller.
- **The guard already exists.** `unsafeEnvReason()` (`config-contract.ts`)
  rejects `LD_*`/`DYLD_*`, `NODE_OPTIONS`/`NODE_PATH`/`BASH_ENV`/
  `ELECTRON_RUN_AS_NODE`, and the reserved `TERM`/`COLORTERM`/`PWD`. It is
  scope-agnostic and applies unchanged to a second layer.
- **The pty-host needs nothing.** `buildEnv(base, cwd, injected)`
  (`pty-host/env.ts:75`) already merges an injected map. This is a resolution
  problem in main, exactly as story 104's env work was.

## Decisions

### 1. The default shell comes from the password database, not `$SHELL`

```
defaultShell() = os.userInfo().shell   when absolute
               = '/bin/zsh'            when platform is darwin
               = '/bin/sh'             otherwise
```

`os.userInfo()` reads `getpwuid`, which is the account's real login shell and
is present regardless of how the app was launched. `$SHELL` is not: a GUI app
opened from Finder or the Dock inherits launchd's environment, where `SHELL` is
unset. That is the same launch mode `config/runtime.ts:59-65` already warns
about for `PATH`, so honouring `$SHELL` literally would degrade to the fallback
in precisely the case that matters most — a packaged build.

The absolute-path check is not decoration. A relative or empty value from the
password database is unusable as a spawn target and must fall through rather
than reach `pty.spawn`, where it would fail inside the child with no context —
the failure mode `config/resolve.ts:26` already calls out for `cwd`.

**This lives in main, not `shared/`.** `config-contract.ts` states in its header
that it is "Types and constants only — no Node APIs, no DOM APIs", and it is
imported by the renderer. `node:os` cannot go there. New file:
`app/electron/main/config/shell.ts`, exporting `defaultShell(userInfo, platform)`
with both injected so tests can drive every branch without mocking modules.

`DEFAULT_SHELL` stays in `config-contract.ts` as the non-darwin constant it
already is. Only the resolution is new, and only main performs it.

The three false comments are corrected in the same change. Leaving them would
mean the next reader re-derives this from scratch.

### 2. A workspace environment layer, resolved like the other two

`ConfigSnapshot` gains `env: Record<string, string>`, always fully resolved to
`{}` rather than left optional — the same reasoning `config-contract.ts` gives
for `notifications`: main reads this on every spawn, and a consumer that must
remember to apply a default is one that will eventually forget on one branch.

`env` joins `TOP_LEVEL_KEYS` in `parse.ts` so the parser stops reporting it as
unknown, and is validated by the **existing** `unsafeEnvReason()` guard. Parity
matters more than the rule: a variable refused for a project and accepted
globally would be a hole in the posture story 104 established, where the
renderer is untrusted input.

`effectiveRuntime` (`config/runtime.ts:49`) becomes:

```
env = { ...snapshot.env, ...(project?.env ?? {}) }
```

Per-key, project wins. This is the shape `shell` and `claudeCommand` already
resolve with, so "project overrides default" stays true for all three runtime
values rather than being true for two of them and something else for the third.

### 3. The rc file wins, and the UI says so

Injected environment is applied by `buildEnv` before the shell starts. A login
shell then sources its rc file, which runs *after* and can overwrite anything.
With zsh as the default this stops being theoretical: an `export` in `.zshrc`
silently beats the same variable set in Settings.

The rc file is allowed to win. Forcing the opposite means typing `export`
statements into the PTY after startup — the mechanism `sessions/bootstrap.ts`
uses for the agent command — which would put shell code the user did not write
into their scrollback and re-open the arbitrary-code path `UNSAFE_ENV_KEYS`
exists to close. Every terminal emulator behaves the way we are choosing.
Deviating from that would surprise more than it helps.

What is not acceptable is for it to be invisible. The field carries the rule as
hint text:

> Set before the shell starts. A login shell's rc file runs afterward and can
> override these.

### 4. Secrets stay in the rc file

`~/.hive/config.json` is plaintext, and the settings UI writes to it. Tokens
typed into the environment editor would be persisted in the clear next to the
project list.

Once the default shell is the user's own, the rc file is already sourced — so
credentials keep working with nothing entered into the app at all, and the file
that holds them stays the one the user already chose for them. The section
description frames the editor as non-secret configuration. This is guidance,
not a guard: there is no reliable way to detect a secret, and a guard that
rejects `API_TOKEN` while accepting `TOKEN_API` teaches nothing.

### 5. An environment diagnostic, alongside the command diagnostic

Decision 3 is only safe if its consequence is observable. The Runtime section
gains a second diagnostic that runs the resolved shell once as
`<shell> -l -i -c printenv` and diffs the result against what was configured,
reporting each variable as applied or overridden-by-rc.

It is scoped exactly as `diagnoseCommand` is — `projectId: string | null`,
driven by the same project selector already on the section, so the shell it
runs is the shell that project's sessions would spawn. A diagnostic that
reported the default while the user was looking at an overriding project would
be worse than none.

**`-i` is not optional, and `-l -c` alone is a bug.** The first draft of this
spec said `-l -c`. That makes the probe *non-interactive*, and zsh sources
`.zshrc` only for interactive shells — so on the default macOS shell the probe
would miss the very file this diagnostic exists to expose, reporting a variable
as "kept" while the real session got the rc file's value. Measured:
`zsh -l -c printenv` does not see `.zshrc`; `zsh -l -i -c printenv` does.

A residual gap remains and is documented rather than hidden: the probe has no
TTY, so an rc file gated on `[[ -t 0 ]]` can still behave differently from a
real session. The view states the exact invocation it ran, so the user can see
what was and was not exercised.

**It must not block the main process.** `spawnSync`'s `timeout` only *sends*
`killSignal`; it does not guarantee return. Measured: a shell running
`trap '' TERM; sleep 20` blocked for 20.2s against a 2s timeout. Since this
runs a user-configured program that executes arbitrary rc code, and the button
is renderer-triggerable, a synchronous call is a renderer-triggerable freeze of
every window and every IPC channel. The probe is asynchronous; `ipcMain.handle`
already accepts a returned Promise.

It runs through `execFile` with `shell: false`, the pattern
`integrations/gh.ts:65` establishes and documents ("`execFile` semantics, never
a shell"). It is read-only and does not go through `writeConfig`, matching
`diagnoseCommand` (`config/runtime.ts:67`).

This is the only part of the story that is new mechanism rather than
composition, and it is the part that turns "my setting did nothing" into
something the user can act on — the same job the PATH diagnostic already does
for `claude`.

## Data flow

```
config.json ─ parse ─▶ ConfigSnapshot { shell, claudeCommand, env, projects }
                       │       shell defaults to defaultShell() here, at
                       │       write.ts:219 — so the snapshot's value is
                       │       always resolved and never undefined
                       ▼
                    effectiveRuntime(snapshot, project)
                      shell   = project.shell   ?? snapshot.shell
                      command = project.command ?? snapshot.claudeCommand
                      env     = { ...snapshot.env, ...project.env }
                              │
                              ▼
              pty.spawn(file: shell, args: ['-l'], env)
                              │
                              ▼
                    buildEnv strips ELECTRON_*/NODE_*, forces TERM/COLORTERM/PWD
                              │
                              ▼
                       shell starts ─▶ sources rc ─▶ may override env
```

## Error handling

- An unusable shell from the password database falls through to the platform
  default rather than reaching `pty.spawn`.
- A refused environment key is reported with `unsafeEnvReason()`'s message and
  the write is rejected whole, never partially applied — a setting that
  silently vanishes is worse than one that names itself.
- The environment diagnostic failing to run is reported as a failed diagnostic,
  not as a configuration error. It is an observation tool; its absence must not
  read as "your settings are wrong".

## Testing

- **Unit, `defaultShell()`** — absolute value from `userInfo`; relative and
  empty values falling through; darwin and non-darwin fallbacks. Both inputs
  injected, no module mocking.
- **Unit, resolution** — `effectiveRuntime` merge precedence, including a key
  present in both layers and a project with no `env` at all.
- **Unit, guard parity** — every `UNSAFE_ENV_KEYS`, `UNSAFE_ENV_PREFIXES` and
  `RESERVED_ENV_KEYS` member is refused at the workspace layer with the same
  message it produces at the project layer.
- **Conformance** — a spawned session's environment contains the merged map.
- **E2E** — set a workspace variable in Settings, spawn a session, read it back;
  assert a project override beats it.
- **Regression audit** — existing conformance and e2e specs seed `shell`
  explicitly (`runtime-settings.spec.ts:43` seeds, `:71` asserts), so they are
  unaffected. Any test asserting the *default* rather than a seeded value must
  be updated; this is an explicit step, because changing a default silently is
  how a green suite starts lying.

## Out of scope

Windows. The session model is POSIX throughout — `LOGIN_SHELL_ARGS` is `['-l']`
and `probe.ts:19` documents the deliberate omission of `PATHEXT`. Teaching only
this story about Windows would describe a session the app cannot start.
