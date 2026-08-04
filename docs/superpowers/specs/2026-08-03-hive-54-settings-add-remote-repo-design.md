# HIVE-54 — Settings: Add a Remote Repository by URL (story 102)

The user pastes a repository URL, picks a folder to clone into, watches `git`
work in a real terminal they can type into, and ends with the cloned directory
registered as a project.

**Jira:** HIVE-54 · 8 points · Epic HIVE-51 (Settings) · blocked by HIVE-52
(story 101, merged in `a6e946d`) · blocks HIVE-55 (103) and HIVE-60 (108).

**Story file:** none. `stories/102-*.md` was never written, and this story does
not write it — the ticket is a placeholder that records what the epic knows and
says so. This spec is the acceptance criteria, the file-touch table and the test
plan the story file would have carried.

## Reconciliation decisions

Findings from checking HIVE-54 against the code as it exists after story 101.

### 1. The ticket is a placeholder, and the epic's own rule contradicts it

`stories/100-settings-epic.md:86` binds every story in the epic:

> Writes are confined to the config file. No verb takes a destination path.

Story 102 writes a whole directory tree, and "failure leaves no half-clone" means
it must delete one too. Taken literally the rule forbids the story.

**Resolution — the rule survives, restated precisely.** The renderer supplies a
**parent** directory and a URL. Main derives the final path segment from the URL
itself and joins it. No verb accepts a destination, no verb accepts a path to
remove, and the only directory main will ever delete is one it computed and
created within this operation. The rule was written to stop the renderer naming
a filesystem target; it still does.

### 2. A clone cannot be an `Entity`, and every terminal path wants one

`resolveTransport` resolves a live PTY only for a store entity that satisfies
`isSession` (`src/lib/terminal/resolve-transport.ts`), and `Session` requires
`project`, `branch`, `task`, `pr` and `cost` (`src/types/entity.ts:12-24`). A
clone in flight has none of those — the project is what it is creating.

**Resolution:** the clone terminal is not an entity view. It is a
`TerminalSurface` mounted inside the settings sub-view, driven by a transport
built for it. `TerminalSurface` takes `transport` and `readOnly` as plain props
and knows nothing about entities (`src/components/terminal/terminal-surface.tsx:39,119`),
so this needs no change to `resolve-transport.ts`, `resolve-view.ts`, the tab
bar, or the store.

### 3. Every PTY channel routes through the sessions layer

`pty:write`, `pty:resize`, `pty:ack` and `pty:kill` all call
`sessions?.<verb>(entityId, …)` (`electron/main/ipc/index.ts:229-246`), which
translates an entity id to a session id through the registry. A clone that
called `ptyIpc.spawn` directly would stream output fine and **silently swallow
every keystroke** — no credential prompt could ever be answered.

**Resolution:** the clone gets a registry entry in the sessions layer under a
reserved entity id. Every existing channel then works unchanged. This is the
decision that keeps the story at 8 points.

### 4. Story 101 left the schema ready

`ProjectOrigin` is already `'local' | 'cloned'` with a comment naming this story
(`electron/shared/config-contract.ts:29-30`), and `parse.ts:70` already accepts
`'cloned'`. **No schema work, no `CONFIG_VERSION` change.**

### 5. `chooseDirectory` already does the folder half

`config.chooseDirectory()` exists and is unchanged by this story
(`electron/shared/ipc-contract.ts:259`). Picking the parent folder needs no new
dialog verb.

### 6. The approved surface deviates from the ticket's wording

The ticket asks for progress "in the terminal the user already trusts", meaning
the center stage. `resolveView` puts settings above every other state and the
epic forbids settings changing `activeTab` (`src/lib/resolve-view.ts`), so
honouring that phrase literally would mean closing settings and switching tabs
mid-task.

**Resolution — approved with the user on the mockups:** the terminal lives in a
focused sub-view inside settings. This must be propagated to HIVE-54 as an
UPDATED SPECS note before the PR merges.

## Design decisions

### The clone is a session that runs `git` instead of a login shell

`sessions/` gains one lower-level verb:

```ts
openCommand(request: {
  entityId: string;
  cwd: string;
  file: string;
  args: string[];
  cols: number;
  rows: number;
}): void;
```

Same registry, same id translation, same batching and flow control. What it
deliberately does **not** do:

- **No project lookup.** The cwd arrives already resolved by the caller. The
  `unmapped` refusal (`sessions/index.ts:294-305`) is exactly what must not fire
  for a directory that does not exist yet.
- **No `bootstrap.arm`.** Arming `claudeCommand` (`sessions/index.ts:340`) would
  type `claude` into a `git clone`.
- **No activity tracking.** `session:status` for an entity the store has never
  heard of is noise at best.

`open()` becomes a thin wrapper: resolve the project, then delegate. This is a
refactor of code that already exists rather than a parallel path, so there is no
second way to spawn a PTY.

### Main owns the whole flow; the renderer owns none of it

The renderer starts a clone and renders what comes back. It does not decide when
the clone succeeded, does not write the config, and never learns the target path
except to display it. Main watches the exit code, writes on success, cleans up on
failure, and pushes one terminal event carrying the outcome and the fresh
snapshot.

The alternative — the renderer noticing `pty:exit` with code 0 and calling
`addProject` itself — puts the success criterion in the untrusted process and
makes a config write depend on a renderer that may have been closed.

### One clone at a time, under a reserved entity id

A single reserved id (`CLONE_ENTITY_ID`) is what lets the existing channels
carry clone traffic. It also caps concurrency at one, which the focused sub-view
already implies. A second `clone-start` while one is live is refused with a
reason rather than queued.

### The URL is validated, and `git` is never handed a shell string

`git` is spawned with an argv array, so no quoting rule can turn a URL into a
command. On top of that, `parse-url.ts` enforces:

- **Allowed:** `https://`, `ssh://`, scp-style `user@host:path`, `file://`, and
  an absolute local path. The last two are what let the e2e suite clone without
  a network.
- **Rejected:** anything beginning with `-` (this is what closes
  `git clone --ext::sh -c …` and `--upload-pack=…`), plaintext `http://` and
  `git://` — both with a message naming `https` as the fix.

The same module derives the folder name: last path segment, trailing `/` and
`.git` stripped. A URL that yields no usable name is rejected before anything
spawns.

### Cleanup is bounded to a path main created

Main records the target it computed and whether the directory existed before the
clone. It removes that path only when it created it and the clone did not
succeed. Cancel and quit-mid-clone route through the same cleanup, because those
are the two realistic ways to strand a half-clone — `git` cleans up after its own
ordinary failures, but not after `SIGKILL`.

### Sub-view state is local, not in `ui-store`

`ui-store` holds app-wide view state. Which pane the Projects section is showing
is scoped to one section and dies with it, exactly like story 101's `choosing`
flag (`projects-section.tsx:51`). A `useState` in `ProjectsSection`.

## Architecture

### Main

| File | Change |
| --- | --- |
| `electron/main/clone/parse-url.ts` | **New.** Pure: scheme allowlist, injection rejection, folder-name derivation. |
| `electron/main/clone/index.ts` | **New.** Pre-flight, spawn, exit handling, config write, cleanup. |
| `electron/main/sessions/index.ts` | Extract `openCommand`; `open` delegates to it. Add an exit hook for `clone/`. |
| `electron/main/config/index.ts` | `addProject(request, origin)` — second argument is main-internal and defaults to `'local'`, so a renderer cannot claim `'cloned'`. |
| `electron/main/ipc/index.ts` | Three handlers: `clone-start`, `clone-cancel`, and the `clone-done` push. |
| `electron/main/index.ts` | On `will-quit`, kill a live clone and run its cleanup. |

### Shared

| File | Change |
| --- | --- |
| `electron/shared/config-contract.ts` | `CloneRequest`, `CloneStartResult`, `CloneDoneEvent`, `CLONE_ENTITY_ID`. |
| `electron/shared/ipc-contract.ts` | Three channels; `clone-done` added to `EVENT_CHANNELS`; `config.clone*` on `HiveBridge`. |
| `electron/shared/guards.ts` | `parseCloneRequest`, beside `parseAddProjectRequest`. |

### Preload

| File | Change |
| --- | --- |
| `electron/preload/index.ts` | `config.startClone`, `config.cancelClone`, `config.onCloneDone`. `BRIDGE_KEYS` is unchanged — these hang off the existing `config` key. |

### Renderer

| File | Change |
| --- | --- |
| `src/lib/terminal/clone-transport.ts` | **New.** `pty-transport`'s channel machinery without the self-spawn. |
| `src/lib/clone-repo.ts` | **New.** Bridge wrapper, mirroring `project-config.ts`. |
| `src/features/settings/components/clone-repo-view.tsx` | **New.** The sub-view: fields, derived-target line, terminal, cancel, failure. |
| `src/features/settings/components/projects-section.tsx` | `Clone from URL` button; `view` state; renders the sub-view. |

### Data flow

```
renderer  config.startClone({ url, parentPath, cols, rows })
main      parse-url → resolve parentPath → target must not exist
main      sessions.openCommand({ CLONE_ENTITY_ID, cwd: realParent,
                                 file: 'git',
                                 args: ['clone','--progress','--', url, name] })
main  →   pty:data ────────────────────────────────► renderer terminal
renderer  pty:write (keystrokes) ──────────────────► git's credential prompt
main      exit 0    → addProject({ path: target }, 'cloned')
          exit ≠ 0  → rm -rf target (only if main created it)
main  →   config:clone-done { ok, targetPath?, reason?, snapshot }
```

## Error handling

Every failure ends the same way: the directory is absent and the config is
untouched. Messages are surfaced verbatim where main or `git` already phrased
them well, following story 101's rule that re-phrasing loses the detail that
makes a problem fixable.

| Case | Behaviour |
| --- | --- |
| URL fails `parse-url` | Inline field error. Nothing spawns. |
| Parent path fails resolution | Inline field error, naming the resolution verdict. Nothing spawns. |
| Target already exists | Refused: `<target> already exists — choose another folder`. |
| `git` not on `PATH` | The host's own failure, verbatim: `could not start git in <cwd>`. |
| Non-zero exit | Git's output is already in the terminal; the view adds one line plus **Retry** and **Back**. Directory removed. |
| User cancels | PTY killed, then the same cleanup as a failure. |
| App quits mid-clone | `will-quit` kills the PTY and runs the cleanup. |
| A clone is already running | `clone-start` refused with a reason; the running clone is untouched. |

## Testing

| Level | Covers |
| --- | --- |
| Unit — `parse-url` | Every allowed scheme; `-`-leading and `--ext::`/`--upload-pack` rejection; `http`/`git` rejection with the `https` message; name derivation incl. trailing `/` and `.git`; a URL with no derivable name. |
| Unit — `clone/index` | Against a fake sessions layer: exact argv and cwd; `addProject` called with `'cloned'` on exit 0; removal on non-zero; no removal when the directory pre-existed; second start refused while one is live. |
| Unit — guards | `parseCloneRequest` rejects wrong shapes, `__proto__`, non-string fields. |
| Unit — renderer | Field validation, the derived-target line, cancel, failure state, and that the transport never self-spawns. |
| e2e — Playwright electron | Clone a **local bare-repo fixture** into a temp dir under a `HIVE_CONFIG_PATH` sandbox. No network. Asserts the project appears in the list and the file records `origin: "cloned"`. Plus a failing clone leaving no directory behind. |

`node-pty` is never loaded for real in unit tests (`app/CLAUDE.md`); the
recording fake in `__mocks__/node-pty.ts` carries the spawn assertions. Terminal
semantics stay with `pnpm test:pty`. The 80% coverage gate applies.

## Not in this story

- Rename, re-point, reorder — story 103.
- Any auth The Hive owns. Credentials are git's: credential helper, ssh-agent,
  or the interactive prompt in the PTY. No tokens are stored.
- Submodules, sparse checkout, branch or depth options. `git clone` with a URL.
- Resuming or retrying a clone after the app restarts.
- Cloning into a directory that already exists, including an empty one.
