# 083 — Runtime Target Detection & Transport Resolution

| | |
|---|---|
| **ID** | HIVE-083 |
| **Epic** | Desktop shell |
| **Depends on** | [082-preload-ipc-security.md](082-preload-ipc-security.md), [042-terminal-surface.md](042-terminal-surface.md) |
| **Blocks** | [094](094-pty-transport.md), [097](097-orchestrator-drives-ptys.md) |
| **Points** | 3 |
| **Location** | `src/config/runtime.ts`, `src/lib/terminal/resolve-transport.ts`, `src/components/layout/center-stage.tsx` |

## Story

> As a developer, I want one place that answers *"is there a real machine behind this
> terminal?"*, so the app can run in a browser for demos and in Electron for real work
> without either mode pretending to be the other.

## The rule

**Electron is the product. The browser build is a fixtures-only demo surface.**

It survives because it costs almost nothing — the transport seam
([042](042-terminal-surface.md)) already makes it a branch on one factory — and it buys
three real things: the six existing Playwright web specs keep passing unchanged, a demo
needs no install, and the whole coordination UI stays developable without spawning
processes.

It survives on one condition: **it must degrade visibly.** A browser build that looks
identical to the desktop build while its terminals are recordings is a trap, first for
the user and then for us the moment someone files a bug against a transcript.

## Detection

```ts
// src/config/runtime.ts
export const isDesktop = (): boolean =>
  typeof window !== 'undefined' && window.hive !== undefined;
```

Feature detection against the bridge that [082](082-preload-ipc-security.md) exposes —
not `navigator.userAgent`, not `process.versions.electron` (unreachable with
`nodeIntegration: false`), not a build-time `import.meta.env` flag.

The bridge is the capability. If it is there, PTYs are reachable; if it is not, they are
not — which stays true if the app is ever loaded in a browser from a dev server pointed
at the same bundle.

`window.hive` is typed in `src/types/hive-bridge.d.ts` with a **type-only** import from
`@shared/ipc-contract`. Type-only matters: a value import would pull main-process code
into the renderer bundle and trip the [080](080-electron-scaffold.md) lint zone.

## Transport resolution

```ts
// src/lib/terminal/resolve-transport.ts
export function resolveTransport(entityId: string): TerminalTransport {
  if (entityId === ORCHESTRATOR_ID) return createStaticTransport(entityId);
  return isDesktop() ? createPtyTransport(entityId) : createStaticTransport(entityId);
}
```

Two things this encodes, both deliberate:

- **The orchestrator console is always static**, in both targets. It is a command
  surface, not a shell ([041](041-orchestrator-console.md)); its verbs drive real PTYs
  ([097](097-orchestrator-drives-ptys.md)) but it does not own one.
- **The branch lives here and nowhere else.** `center-stage.tsx` swaps
  `createStaticTransport(id)` for `resolveTransport(id)` and is otherwise untouched;
  its transport cache, its identity discipline and its `readOnly` handling all stand.
  `PtyTransport` arrives in [094](094-pty-transport.md); until then this function has
  one live branch and a test double for the other.

`src/components/terminal/` does not learn that any of this happened. That is the seam
doing its job — the check it exists for.

## Degrading visibly

| Surface | Desktop | Browser |
|---|---|---|
| Header | model chip as today | model chip **+ a `demo` chip** |
| Session terminal | live PTY | recorded transcript |
| Message row placeholder | `message this session` | `demo mode — this transcript is a recording` |
| `spawn` in the console | creates a real session | prints `spawn requires the desktop app` and does nothing |
| New-session picker "Create" | creates a real session | disabled, tooltip explains why |
| Kill / restart session | available | absent |

The `demo` chip reuses the existing `chip.tsx` atom and the `--cc-amber` token — the
same colour the app already uses for "needs attention", which is the right register.
No new component.

Capability gating goes through one exported predicate rather than scattered
`isDesktop()` calls in components:

```ts
export const can = {
  spawnSession: isDesktop,
  killSession:  isDesktop,
  typeIntoTerminal: isDesktop,
};
```

A component asks `can.spawnSession()`. When a capability later becomes conditional on
something other than the target — a missing config file
([090](090-workspace-config.md)), for instance — it changes here.

## Tests

`tests/config/runtime.test.ts`, `tests/lib/terminal/resolve-transport.test.ts`:

- `isDesktop()` is false with no `window.hive`, true with a stub.
- `resolveTransport` returns the static transport for `ORCHESTRATOR_ID` in **both**
  modes — the regression that would otherwise turn the console into a shell.
- `resolveTransport` returns the PTY transport for a session id only in desktop mode.
- The picker's create action is disabled without the bridge; the console's `spawn`
  prints the refusal line rather than mutating the store.
- Header renders the `demo` chip without the bridge and not with it.

The existing `tests/e2e/*.spec.ts` continue to run against the browser target and must
stay green untouched. If a spec needs editing to accommodate this story, the story is
wrong — that suite is the contract that the demo surface still works.

## Acceptance criteria

- [ ] `pnpm dev` (browser) shows the `demo` chip, recorded transcripts, and a disabled
      create action with an explanatory tooltip.
- [ ] `pnpm desktop:dev` shows no `demo` chip and resolves session transports to the
      PTY implementation.
- [ ] The orchestrator console uses the static transport in both targets.
- [ ] `center-stage.tsx`'s diff is the import and the factory call — nothing else.
- [ ] `src/components/terminal/` has a zero-line diff in this story.
- [ ] All six existing `tests/e2e/` specs pass unmodified.
- [ ] `pnpm lint`, `pnpm type-check`, `pnpm test` green with coverage ≥ 80%.

## Out of scope

- The PTY transport itself — [094](094-pty-transport.md).
- Making the terminal writable — [095](095-interactive-terminal-surface.md).
- Any attempt to give the browser target real terminals. It will not have them; that
  is the point of the chip.
