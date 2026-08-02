# 095 — Interactive Terminal Surface

| | |
|---|---|
| **ID** | HIVE-095 |
| **Epic** | Real terminals |
| **Depends on** | [094-pty-transport.md](094-pty-transport.md), [042-terminal-surface.md](042-terminal-surface.md), [085-electron-test-harness.md](085-electron-test-harness.md) |
| **Blocks** | [096](096-session-lifecycle-claude.md), [097](097-orchestrator-drives-ptys.md) |
| **Points** | 5 |
| **Location** | `app/src/components/terminal/terminal-surface.tsx`, `app/src/lib/terminal/` |

## Story

> As a user, I want to type directly into the terminal — Ctrl-C, arrow keys, tab
> completion, a full-screen TUI — so that a Claude Code session in The Hive is the same
> thing I would get in iTerm, not a text box that resembles one.

The prototype's terminals are `readOnly: true` and every view that accepts input does it
through a DOM row beside them ([041](041-orchestrator-console.md),
[043](043-session-view.md)). With a real PTY behind the seam, Claude Code's TUI owns the
prompt, and the keyboard has to reach it.

## Read-only becomes conditional

| Surface | `readOnly` | Why |
|---|---|---|
| Session / agent terminal (desktop) | `false` | a live pty; the TUI owns the prompt |
| Session / agent terminal (browser) | `true` | a recording — [083](083-runtime-target-transport.md) |
| Orchestrator console | `true`, always | a command surface, not a shell |

When interactive, `cursorBlink` turns on. A non-blinking cursor on a live prompt reads
as a hung terminal.

```ts
useEffect(() => {
  if (readOnly) return;
  const sub = term.onData((data) => transport.write(data));
  return () => sub.dispose();
}, [term, transport, readOnly]);
```

`term.onData` already emits exactly the bytes a terminal should send — escape sequences
for arrows, `\x03` for Ctrl-C, bracketed paste when the application enables it. It is
passed through untouched ([092](092-pty-session-manager.md) interprets nothing).

## The keyboard conflicts

Three collisions between app shortcuts and terminal semantics. Each needs a decision,
and defaults produce a broken product.

### Ctrl-C

On macOS, copy is `Cmd+C`, so `Ctrl+C` is unambiguously the terminal's and passes
through as `\x03`. On Linux and Windows the conventional copy binding *is* `Ctrl+C`,
which would swallow the interrupt.

Rule, via `attachCustomKeyEventHandler`:

- **macOS** — `Cmd+C` copies (when a selection exists), `Ctrl+C` always goes to the pty.
- **Linux/Windows** — `Ctrl+Shift+C` / `Ctrl+Shift+V` copy and paste; bare `Ctrl+C` goes
  to the pty **unless** there is a selection, in which case it copies and clears the
  selection. This is what GNOME Terminal and VS Code do, and matching the platform
  convention beats inventing one.

### App navigation vs. the terminal

[060](060-keyboard-navigation.md) gives the app a keyboard-only path, and `←` returns to
the orchestrator from a session ([043](043-session-view.md)). Inside a live terminal
`←` is a cursor key that belongs to the child process.

Rule: **a focused interactive terminal wins every bare key.** App navigation from within
one uses an explicit modifier chord (`Cmd`/`Ctrl` + the existing key). The escape hatch
out of the terminal is a single documented chord shown in the key-hint row, which
already exists as a component (`key-hint.tsx`).

The existing keyboard e2e spec asserts the read-only path and must keep passing for the
browser target; the desktop path gets its own assertions.

### Focus

`center-stage.tsx` currently focuses the **message row** when the terminal area is
clicked. In desktop mode, clicking a live terminal must focus the **terminal** — the
click-to-focus code stays, its target becomes conditional on `can.typeIntoTerminal()`.

The selection guard in that handler stays exactly as it is: focus changes collapse the
document selection, so click-drag-release must not steal focus mid-selection. That
comment in `center-stage.tsx` is describing a real bug and it applies unchanged.

## Renderer: add WebGL

Install `@xterm/addon-webgl` (`0.19.0`) and load it when the terminal is interactive.

The DOM renderer ([`docs/terminal-architecture.md`](../app/docs/terminal-architecture.md))
was correct for static fixture transcripts. A live pty streaming a build log is a
different workload, and the DOM renderer allocates elements per cell.

Two mandatory guards:

- **`onContextLoss` → dispose the addon and fall back to DOM.** WebGL contexts are lost
  on GPU driver resets and when too many contexts exist — and this app can have a dozen
  live terminals. Without the handler the terminal simply stops painting, which looks
  like the session froze.
- **Cap the number of WebGL-backed instances.** Browsers limit concurrent WebGL contexts
  (commonly ~16). Attach the addon to the **visible** terminal only; hidden kept-alive
  instances ([042](042-terminal-surface.md)) do not need a GPU context. Attach on
  reveal, dispose on hide, reusing the existing visibility effect.

Theme changes still assign `terminal.options.theme` on the live instance — unchanged, and
still costs no scrollback.

## What does not change

The seam holds. `TerminalSurface` still takes `{ transport, theme, fontSize, readOnly,
visible }` and still knows nothing about sessions, stores or fixtures. This story adds
behaviour behind existing props; it adds no domain knowledge and no new prop that names
a domain concept.

## Tests

Vitest (`__mocks__/@xterm/` recording fakes — xterm is never really instantiated):

- `onData` is subscribed only when `readOnly` is false, and disposed on unmount.
- Keystrokes reach `transport.write` verbatim, including `\x03`.
- `cursorBlink` follows `readOnly`.
- The custom key handler: per-platform matrix for `Ctrl+C` with and without a selection,
  and for the copy/paste chords.
- WebGL addon is loaded on reveal, disposed on hide, and disposed on simulated context
  loss with a DOM fallback.
- Read-only surfaces never subscribe `onData` — the orchestrator-console regression.

Playwright (`tests/e2e/electron/`, real rendering, real pty):

- Type `echo hive-ok`, press Enter, the output appears.
- `Ctrl+C` during `sleep 100` returns the prompt.
- Selection survives a click that lands inside it.
- Copy chord puts terminal text on the clipboard.
- Arrow keys move the shell's cursor rather than navigating the app.

## Acceptance criteria

- [ ] Typing into a desktop session reaches the shell and echoes.
- [ ] `Ctrl+C` interrupts; the platform copy chord copies.
- [ ] `vim` opens, accepts input, and exits cleanly to a working prompt.
- [ ] Tab completion and shell history (`↑`) work.
- [ ] The orchestrator console remains read-only in both targets.
- [ ] The browser target remains read-only and all `tests/e2e/web/` specs pass.
- [ ] Simulated WebGL context loss falls back to DOM with no visible break.
- [ ] Twelve open terminals do not exhaust WebGL contexts.
- [ ] `TerminalSurface`'s prop interface is unchanged.

## Out of scope

- Search, links beyond the existing web-links addon, image protocols (sixel/kitty).
- Per-session font size or a settings surface.
- IME composition edge cases.
