# 104 — Runtime settings: shell, command, env (HIVE-56) — design

| | |
|---|---|
| **Ticket** | HIVE-56 |
| **Epic** | [100 — Settings](../../../stories/100-settings-epic.md) (HIVE-51) |
| **Depends on** | 101 (HIVE-52) — overlay, write path, schema v2; 105 (HIVE-57) — the section switcher |
| **Points** | 5 |
| **Location** | `app/electron/shared/`, `app/electron/main/config/`, `app/electron/main/sessions/`, `app/src/features/settings/` |

The epic's story table gives this story four items:

> `shell` and `claudeCommand` editable in the UI, per-project overrides,
> per-project env vars, a PATH diagnostic that says why `claude` was not found.

## What already exists (reconciled against the code, not the ticket)

- **Top-level `shell` and `claudeCommand` already round-trip.** They are on
  `ConfigSnapshot` (`config-contract.ts:79,81`), in `TOP_LEVEL_KEYS`
  (`parse.ts:67`), and defaulted (`DEFAULT_SHELL='/bin/sh'`,
  `DEFAULT_CLAUDE_COMMAND='claude'`). What is missing is any way to *write*
  them: no verb, no channel, no bridge method, no UI.
- **Per-project `shell`/`claudeCommand`/`env` do not exist at all.**
  `PROJECT_KEYS` (`parse.ts:68`) is `['id','path','name','icon','origin']`.
- **The env plumbing to the PTY already exists and is unused.**
  `buildEnv(base, cwd, injected)` (`pty-host/env.ts:75`) already merges an
  injected map, and `PtySpawn.env` threads down through `ipc/pty.ts:70` →
  `session-manager.ts:215`. Main simply always sends `env: {}`
  (`sessions/index.ts:436`). Per-project env is a main-process *resolution*
  problem, not a new pty-host capability.
- **No PATH/command resolution exists anywhere** — zero hits for `which`,
  `command -v`, or PATH inspection. `sessions/bootstrap.ts` types the command
  into the shell blind, so there is not even a failure signal today.
- **The section switcher now exists** (story 105). This story is two lines in
  `SECTIONS` + `PANES` plus its own pane.

## Decisions

### 1. Overrides are per-project, optional, and resolved in main

`RawProject` gains three optional keys — `shell`, `claudeCommand`, `env` — added
to `PROJECT_KEYS` so the parser stops reporting them as unknown. Resolution is a
single function in main, used by `sessions.spawn`:

```
effectiveShell(project)   = project.shell        ?? snapshot.shell
effectiveCommand(project) = project.claudeCommand ?? snapshot.claudeCommand
effectiveEnv(project)     = project.env ?? {}
```

Empty string is **not** an override — it is "unset". A blank field in the UI
clears the override rather than spawning `""`, which would fail with a message
no user could act on.

### 2. `env` is `Record<string, string>`, validated as strictly as a path

The guard rejects: non-string values, keys that are not
`[A-Za-z_][A-Za-z0-9_]*`, `__proto__`/`constructor`/`prototype` (already in
`FORBIDDEN_KEYS`), and the three variables the pty-host sets itself
(`TERM`, `COLORTERM`, `PWD`) — accepting those would let the config silently
fight `buildEnv`, which overwrites them after merging.

### 3. The PATH diagnostic answers one question, on demand

Not a background probe and not a spawn-time gate. A verb —
`config:diagnose-command` — takes a project id, resolves the effective command
and env, and reports:

- the command as resolved, and whether it is an absolute path or a bare name;
- for a bare name, each `PATH` entry searched and whether an executable of that
  name was found there;
- the `PATH` actually in effect (the merged env, not `process.env`), because the
  whole point is that the app's PATH and the user's login-shell PATH differ —
  which is precisely why `claude` "is installed" and still not found.

Read-only: it stats files and writes nothing, so it does not go through
`writeConfig`.

### 4. Security posture unchanged

Every new channel follows the established pattern exactly:
`handle(CH.x, (_event, payload) => verb(parseXRequest(payload)))`, `assertSender`
first (`ipc/index.ts:64`), a hand-written `assertShape` guard in `guards.ts`, no
casts, `__proto__` rejected. Writes stay confined to the config file.

## New surface

| Channel | Payload | Returns |
|---|---|---|
| `config:set-runtime` | `{ shell?, claudeCommand? }` | `ConfigSnapshot` |
| `config:set-project-runtime` | `{ id, shell?, claudeCommand?, env? }` | `ConfigSnapshot` |
| `config:diagnose-command` | `{ id? }` | `CommandDiagnostic` |

## Acceptance criteria

- [ ] Settings has a **Runtime** section; shell and agent command are editable
      and persist to the config file through the one write path.
- [ ] A project can override either, and set env vars; blank clears the override.
- [ ] A spawned session actually uses the effective shell, command and env.
- [ ] The diagnostic explains why `claude` was not found, naming the PATH it
      searched.
- [ ] Unknown top-level keys, `"//"` comments, and unknown *per-entry* keys all
      survive every new write.
- [ ] `pnpm lint`, `type-check`, `verify:boundaries`, `test` (80% gate) pass.
