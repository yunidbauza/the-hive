# Architecture

The map for contributors. Each box below has a deep dive; this page says which.

**On this page:** [At a glance](#at-a-glance) · [Processes](#processes) ·
[Where things live in the tree](#where-things-live-in-the-tree) · [The rules](#the-rules) ·
[Where to read next](#where-to-read-next)

## At a glance

The Hive is one Electron app with a strict process model. The renderer (`src/`) is React,
four Zustand stores and xterm; it reaches the main process only through verbs the preload
exposes on `window.hive`. Main (`electron/main`) is the single policy point: it validates
every call, owns the config, the ledger, session history and the hook receiver. Terminals run
in a separate PTY host process, so a crash there cannot take down main. Each `claude` starts
its own MCP host over stdio to reach the ledger (over HTTP from a container). `electron/shared` is the only code both
sides import.

## Processes

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/diagrams/processes.dark.svg">
  <img src="assets/diagrams/processes.light.svg" alt="Renderer, preload, main with the hook receiver and ledger, the PTY host, claude and its MCP host">
</picture>

| Process | Deep dive |
| --- | --- |
| Renderer shell, rails, views | [Component patterns](component-patterns.md) |
| Stores and selectors | [State and data](state-and-data.md) |
| The terminal component and transports | [Terminal architecture](terminal-architecture.md) |
| Main, IPC, the PTY host, status | [Desktop architecture](desktop-architecture.md) |
| Explorer and editor, the fs surface | [Explorer and editor](explorer-and-editor.md) |
| Ledger, MCP host, agents | [Agents and the ledger](agents-and-ledger.md) |
| Remote listener and pairing | [Server mode](server-mode.md) |
| Build, sign, publish, update | [Packaging and updates](packaging-and-updates.md) |

## Where things live in the tree

```text
src/
  components/layout/     the composition root: rails and centre stage mount features
  components/terminal/   the terminal seam (speaks only TerminalTransport)
  components/editor/     the editor seam
  features/<slice>/      agents, editor, explorer, inbox, orchestrator, projects,
                         pull-requests, sessions, settings, work, shared,
                         simulation (a placeholder)
  stores/                hive, ui, appearance, editor
electron/
  main/                  config, sessions, hooks, ledger, agents, integrations, server
  preload/               the bridge
  pty-host/              terminals
  mcp-host/              the hive MCP server
  shared/                contracts both sides import
tests/                   mirrors src/ and electron/
```

## The rules

Enforced by ESLint, proven by `pnpm verify:boundaries`. The full table is in
[`AGENTS.md`](../AGENTS.md).

- Feature slices never import each other (except `features/shared`).
- `src/components/terminal/` and `editor/` import no features, data or stores. The terminal
  seam is the most important invariant in the code.
- Components read stores only through named selector hooks. Derived values are never stored.
- Only `appearance-store` persists, to `localStorage`.
- No raw hex in components: colour comes from `--cc-*` tokens (the terminal from the theme's
  JS palette).

## Where to read next

- Changing the UI: [Component patterns](component-patterns.md), then the
  [design system](../.claude/DESIGN-SYSTEM.md).
- Touching IPC or sessions: [Desktop architecture](desktop-architecture.md).
- Before any change: [Contributing](contributing.md).
