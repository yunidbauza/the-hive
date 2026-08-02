# 094 — `PtyTransport` — The Seam Swap

| | |
|---|---|
| **ID** | HIVE-094 |
| **Epic** | Real terminals |
| **Depends on** | [093-pty-ipc-protocol.md](093-pty-ipc-protocol.md), [083-runtime-target-transport.md](083-runtime-target-transport.md) |
| **Blocks** | [095](095-interactive-terminal-surface.md), [096](096-session-lifecycle-claude.md) |
| **Points** | 5 |
| **Location** | `app/src/lib/terminal/pty-transport.ts` |

## Story

> As a developer, I want the real backend to arrive as **one new file implementing three
> methods**, so the claim the architecture has been making since
> [042](042-terminal-surface.md) — that swapping the backend touches
> `src/lib/terminal/` and nothing else — is finally either true or falsified.

This story is the audit of every fence in this repo. If it needs to change a component,
a store, or the seam's interface, the fences were decorative.

## The implementation

```ts
export function createPtyTransport(entityId: string): TerminalTransport {
  return {
    write:  (data) => window.hive.pty.write({ sessionId: entityId, data }),
    resize: (cols, rows) => window.hive.pty.resize({ sessionId: entityId, cols, rows }),
    onData(cb) { /* below */ },
  };
}
```

`write` and `resize` are pass-throughs. `StaticTransport` implements both as no-ops
with a comment explaining that *"the methods exist because the interface is the
contract"* ([`static-transport.ts`](../app/src/lib/terminal/static-transport.ts)) —
this is that comment coming due.

## `onData`: subscribe first, spawn second

The ordering is the whole design, and it is easy to get backwards.

```ts
onData(cb) {
  const dispose = window.hive.pty.onData((e) => {
    if (e.sessionId !== entityId) return;
    cb(e.chunk);
  });

  ensureSpawned(entityId);        // idempotent, fire-and-forget

  return () => dispose();
}
```

Subscribing **before** requesting the spawn is what guarantees no output is lost. Spawn
resolves asynchronously and a shell prints its prompt immediately; a transport that
awaited the spawn before subscribing would race the first bytes and intermittently drop
the prompt — a bug that reproduces once in twenty runs and looks like a rendering
glitch.

`ensureSpawned` is idempotent and shared per entity. Two surfaces bound to one session
must both receive output, and neither may spawn a second process. The host's replay
buffer ([092](092-pty-session-manager.md)) means the second subscriber still gets the
full transcript.

**Filtering by `sessionId` in the callback** is required because the bridge exposes one
`pty:data` channel for all sessions — a deliberate choice in
[082](082-preload-ipc-security.md), since a per-session channel makes the allowlist
dynamic.

**The returned disposer only unsubscribes.** It does not kill the PTY. Unmounting a
surface happens on tab switches and re-renders; a session must keep running while the
user looks at something else — that is the product. Killing is an explicit user action
([096](096-session-lifecycle-claude.md)).

## Lifecycle events the terminal must show

Rendered as dim ANSI written into the terminal, not as React chrome — they belong to the
transcript, in the place and order they happened.

| Event | Rendered |
|---|---|
| process exit, code 0 | `── session exited ──` |
| process exit, non-zero | `── session exited (code N) ──` in `--cc-amber` |
| killed by signal | `── session terminated (SIGTERM) ──` |
| pty host crashed | `── session lost (pty host crashed) ──` |
| output gap detected | `── output gap detected ──` |

Colours come from `TERM` in `src/lib/terminal/ansi.ts` via `colorize()`, never a literal
— the existing rule ([042](042-terminal-surface.md)), unchanged.

## Reconnection

When the pty host restarts ([091](091-pty-host-process.md)), subscriptions survive
because they are held in the preload bridge, not in the host. The transport does **not**
auto-respawn: it writes the lost-session line and waits. A user-initiated restart calls
`ensureSpawned` again with a fresh process.

## What this story must not do

An explicit non-goal list, because these are the tempting shortcuts that would falsify
the architecture:

- **No store access.** `PtyTransport` lives in `src/lib/terminal/`, which the lint zones
  permit to read stores — `StaticTransport` does. It must not. Session ids arrive as
  arguments; everything else is the bridge. (The zone cannot enforce this one; it is a
  review rule, and the reason it is written here.)
- **No change to `TerminalTransport`.** If a real backend needs a fourth method, that is
  a finding worth surfacing loudly, not a quiet edit.
- **No change to `src/components/terminal/`.** Its diff in this story is zero lines.
- **No change to `center-stage.tsx`.** [083](083-runtime-target-transport.md) already
  routed it through `resolveTransport`; this story fills in a branch that was a test
  double.

## Tests

`tests/lib/terminal/pty-transport.test.ts` (bridge stubbed on `window.hive`):

- `write`/`resize` forward verbatim with the right `sessionId`.
- Subscription is registered **before** `spawn` is requested — assert call order.
- Two subscribers on one entity trigger exactly one spawn and both receive data.
- Chunks for a different `sessionId` are ignored.
- The disposer removes exactly one listener and does **not** kill the PTY.
- Each lifecycle event renders its exact line, with the amber code path distinct from
  the clean exit.
- Late subscription receives the replayed buffer before live chunks.

Plus the architectural assertion, as a test rather than a hope: `pnpm verify:boundaries`
gains a case proving `src/components/terminal/**` still cannot import
`src/lib/terminal/pty-transport.ts`'s dependencies — the fence that made this story a
one-file change.

## Acceptance criteria

- [ ] In the desktop build, opening a session shows a live shell prompt.
- [ ] `git diff --stat` for this story touches `src/lib/terminal/` and `tests/` only.
- [ ] `src/components/terminal/` diff is zero lines.
- [ ] `TerminalTransport`'s interface is unchanged.
- [ ] Two tabs on the same session show the same live output; closing one leaves the
      other running.
- [ ] Switching away for 30 seconds and back shows the output produced while away.
- [ ] Killing the shell renders the exit line and leaves the transcript readable.
- [ ] The browser target still resolves to `StaticTransport` and the browser e2e suite
      passes unmodified.
- [ ] `pnpm lint`, `pnpm type-check`, `pnpm test` green with coverage ≥ 80%.

## Out of scope

- Making the terminal accept keystrokes — [095](095-interactive-terminal-surface.md).
  Until then `write` is reachable but nothing calls it from the keyboard.
- Deciding what process to run — [096](096-session-lifecycle-claude.md).
