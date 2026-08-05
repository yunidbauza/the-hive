# Terminal architecture

**Scope:** the terminal surface, the transport seam, ANSI colour handling, xterm
configuration, and how live instances are kept alive across tab switches.

**Owned by story 042** (`../../stories/042-terminal-surface.md`).

## The seam

Everything the terminal renders, and every keystroke it produces, crosses one
interface:

```ts
export type TerminalDataHandler = (chunk: string, parsed?: () => void) => void;

export interface TerminalTransport {
  write(data: string): void;                 // keystrokes → backend
  onData(cb: TerminalDataHandler): () => void; // backend → terminal
  resize(cols: number, rows: number): void;
}
```

**`parsed` is the one thing this interface gained when the real backend arrived**
(story 094), and it is worth stating plainly rather than leaving to be
discovered. A pty can produce output faster than xterm can parse it; batching
does not fix that, and only an acknowledgement does. But an ack is only
meaningful if it means *parsed* rather than *received* — and the two facts
needed to say so live in different layers. The transport knows the sequence
number; only the surface knows when `xterm.write` has finished. `parsed` is the
handshake between them: the transport supplies it, the surface calls it from
`terminal.write`'s callback, and `StaticTransport` omits it entirely because it
has no backpressure to apply.

The alternative — a fourth method — was rejected. This is one optional argument
to an existing callback, and every caller that ignores it still compiles.

`src/components/terminal/` is written against that and nothing else. It cannot
import `features/`, `data/`, or `stores/` — the import zone in
`eslint.config.mjs` makes a violation fail `pnpm lint`, not review.

| Module | Knows about | Role |
| --- | --- | --- |
| `lib/terminal/terminal-transport.ts` | nothing | the interface |
| `lib/terminal/static-transport.ts` | the store | recorded transcripts |
| `lib/terminal/pty-transport.ts` | the bridge | a real pty (story 094) |
| `lib/terminal/resolve-transport.ts` | the store, the target | which of the two |
| `lib/terminal/ansi.ts` | the palette | `TermColor` → SGR truecolor |
| `lib/terminal/signals.ts` | nothing | signal number → name |
| `lib/terminal/auto-scroll.ts` | nothing | the bottom-stick predicate |
| `components/terminal/terminal-surface.tsx` | a transport | one live terminal |
| `components/terminal/terminal-host.tsx` | opaque ids | kept-alive registry |

Note which module reads the store and which does not. `PtyTransport` takes its
session and project ids as **arguments**; `resolveTransport` is the one that
looks them up. The lint zone permits a store import in either, so this is a
review rule rather than an enforced one — and it is the reason the transport can
be tested against nothing but a stubbed bridge.

**The rule that keeps it honest:** if a future story needs the terminal
component to read the store, that story is wrong — the data belongs in a
transport.

### Did the seam hold?

Story 094 was written as the audit of that claim, so the answer belongs here.
**Mostly, and the exception is instructive.** Swapping the backend needed no
change to `terminal-host.tsx`, no change to `center-stage.tsx`, and no new prop
naming a domain concept. What it did need was the `parsed` argument above and
the three lines in `terminal-surface.tsx` that call it — because story 093 built
a flow-control loop whose acknowledgement had no path back from the only layer
that could produce it. The fence held; the contract was one signal short.

## Sending text into a session

`src/lib/terminal/session-input.ts` is the whole coordination layer (story 097).
Both call sites that mean "say something to a session" — the console's
`send <id> <msg>` and, over a recorded transcript, the message row under a
terminal — collapse to:

```ts
pty.write(sessionId, text + '\r')
```

Claude Code's TUI sits at a prompt, so text plus a carriage return is what a
person typing would produce. There is no message bus, no protocol, no injection
format, and adding one would be the wrong shape.

Three details are load-bearing:

- **`\r`, not `\n`.** A terminal's Enter key sends carriage return; the line
  discipline is what turns it into "line submitted". A bare line feed is
  inserted literally by some shells and readline configurations, leaving the
  message typed but never sent. `sessions/bootstrap.ts` rests on the same fact.
- **Newlines inside the text become spaces.** A multi-line paste would otherwise
  submit its first line and leave the rest half-typed at the prompt.
- **The renderer never echoes.** The pty echoes what it receives, so appending
  the sent text to the transcript as well would double-print every message.

### Liveness is a different question from `isLiveTerminal`

`isLiveTerminal(entityId)` answers *should* a PTY back this surface — desktop, a
session, not the console. It is a fact about the target and the build, and it is
what `readOnly` and the key-hint row ask.

`sessionChannelState(entityId)` answers *is there a process right now*:
`'live' | 'exited' | 'none'`. It reads `pty-transport.ts`'s module-level channel
map, which is the only thing in the renderer that knows a process has died.
Sending needs this one. Main's `write` returns early for an entity with no live
session — silently, and correctly, since it cannot tell a bug from a race — so
if the renderer did not refuse, a message to a dead session would vanish without
a word. A routing layer that fails silently is the worst outcome available.

The two are deliberately separate functions. Collapsing them would make a
surface typable whose transport was a recording, or make a send succeed into a
session that had already exited.

## Colour

Terminal colour lives in JS, never CSS. xterm resolves colours from its own
`theme` option and paints them into markup it owns, so a `--cc-*` custom
property declared on `:root` has no path to a terminal cell.

> **A correction worth keeping.** Earlier revisions of these docs justified this
> with "xterm paints to a canvas". That reason was wrong even though the
> conclusion holds: xterm 6 core ships the **DOM** renderer by default. Story
> 095 has since installed `@xterm/addon-webgl`, so *some* terminals really do
> paint to a canvas now — see below — but the palette has to be JS either way,
> which is why the conclusion never depended on the reason.

`TERM` and `XTERM_THEME` in `src/lib/terminal/ansi.ts` are the single
definition, shared with the colorizer and `.claude/DESIGN-SYSTEM.md`. Never
hand-write a hex into a terminal component.

## Renderers: which terminal paints how

| Surface | Renderer | Why |
| --- | --- | --- |
| Orchestrator console | DOM | a command surface, never a shell |
| Any browser-target terminal | DOM | a recording; it renders once |
| Visible desktop session | **WebGL** | a live pty streaming a build log |
| Hidden desktop session | DOM | kept alive, painting nothing |

The DOM renderer allocates elements per cell, which is fine for a fixture
transcript and wrong for a firehose. But WebGL contexts are a **capped,
process-wide** resource — browsers commonly allow ~16, and this app can hold a
dozen live terminals — so the addon follows *visibility*, not lifetime: exactly
one context exists, on the terminal being looked at. It is disposed on hide and
re-attached on reveal, and `onContextLoss` disposes it too, dropping back to DOM
with the buffer intact. Without that handler a lost context simply stops
painting, which is indistinguishable from a frozen session.

### The consequence that catches people out

**A WebGL-rendered terminal's text is not in the DOM.** `.xterm-rows` is never
populated; the transcript lives in canvases. Two things follow:

- **Tests cannot read it.** Every desktop spec that asserted terminal contents
  with `toContainText` broke the moment the addon landed, silently reading `''`.
  They now assert what the shell *did* — a marker file it wrote — which is
  stronger evidence anyway, or they read the pty events directly. See
  `tests/e2e/electron/interactive-terminal.spec.ts`.
- **Assistive technology cannot read it either.** xterm's answer is
  `screenReaderMode`, which maintains a separate accessibility buffer at a
  performance cost. It is **not** enabled, and that is an open gap rather than a
  decision this story was equipped to make — it trades against the exact
  throughput the renderer was introduced to get.

### Theming

The terminal keeps its dark background in light mode, like the concept and most
real tools. `buildXtermTheme(theme)` returns the dark palette for both app
themes and varies only selection and cursor: against a bright page the dark
selection wash reads as almost no highlight at all, and selection is the one
piece of terminal chrome the user drives directly.

Re-theming assigns `terminal.options.theme` on the live instance rather than
rebuilding it, so a theme toggle never costs a line of scrollback.

## Instance strategy

**One xterm instance per entity, kept alive and hidden with CSS — never one
shared instance re-fed on tab switch.**

The re-fed alternative is cheaper in memory and wrong in every way that matters:
it loses scroll position and selection on each switch, dropping the user at the
bottom of a transcript they were reading the middle of. `TerminalHost` mounts
surfaces lazily on first visit and keys them by id; thirteen entities at 5k
scrollback is nothing.

`TerminalHost` takes `entries` and an `activeId` as props and stays
domain-agnostic — the composition root (`components/layout/center-stage.tsx`)
is what reads the stores and builds the transports.

## Fitting

`FitAddon` is refit in exactly two places:

- the `ResizeObserver` on the terminal's container, which also calls
  `transport.resize(cols, rows)`; and
- the visibility effect, which covers both first paint and every later reveal.

There is deliberately **no** fit in the mount effect. A surface that mounts
hidden has no geometry to measure, and one that mounts visible would otherwise
be fitted twice.

Ancestors need `min-width: 0` / `min-height: 0` (story 020) or a long line
widens the column and the fit addon grows into it.

### Never fit a hidden surface (108)

**A hidden terminal must not be fitted, and its size must not be reported.** Both
halves are load-bearing, and getting this wrong destroyed transcripts.

Hiding a kept-alive instance fires its `ResizeObserver` with a zero box. An
element in a `display: none` subtree has no used values, so `getComputedStyle`
hands the fit addon back the *specified* `height: 100%` / `width: 100%` — which
it parses as the number `100`. That is not `NaN`, so the addon's own guard
passes, and it proposes roughly **11×5**. `fit()` then reflows the buffer to
eleven columns, and the new size goes on to the pty, so the child process
repaints its entire TUI that narrow. Returning to the session refits to the real
width and restores nothing: the wide rows were overwritten while nobody was
looking. The user sees their transcript shredded into a ribbon.

The guard is the `visible` prop, read through a ref **written during render**.
An effect-updated ref loses the race: React commits `display: none` → the browser
lays out → the observer fires → *then* passive effects run, so `visible` would
still be `true` at the moment the zero-box notification arrives.

A `clientWidth` check on the container would be synchronous too, and is the wrong
guard for a different reason: a visible surface briefly measuring zero mid-layout
would skip its fit and never get another, because no further resize is coming.
Visibility is the condition with a guaranteed follow-up — the visibility effect.

### The keyboard follows the fit

The same effect focuses the terminal when it becomes visible, if it is
interactive. A live session is the only input on its screen (story 108), so a
reveal that did not take the keyboard would make every newly opened session
demand a click first. Read-only surfaces are excluded: the orchestrator console
owns a separate command row that autofocuses itself.

## The bottom-stick rule

New output follows the cursor only when the viewport is already at the bottom —
`shouldAutoScroll(viewportY, baseY)`. Yanking the viewport down while someone
reads scrollback is the most irritating thing a log pane can do.

The predicate is measured *before* the write: afterwards `baseY` has already
advanced to include the new lines, so every append would look like "the user is
at the bottom".

Story 042 sketches the signature as `(viewportY, baseY, rows)`. The row count is
omitted deliberately — in xterm's buffer model `baseY` is already the
viewport-height-adjusted maximum scroll offset, so the height is baked into the
comparison.

## Testing

Split by what each tool can actually prove.

**Vitest** mocks xterm entirely (`__mocks__/@xterm/`) and asserts *plumbing*:
construction, options, subscription, refit calls, teardown, and the pure
predicates in `lib/terminal/`.

**Playwright** (`tests/e2e/terminal.spec.ts`) owns everything that needs a
rendered terminal: palette colours on screen, selection, scroll position across
tab switches, refit on resize, and re-theming.

Two gotchas worth knowing before writing a spec:

- **xterm 6 does not scroll `.xterm-viewport` natively.** It has no scroll area
  and reports `scrollHeight === clientHeight` at every position. Read the
  rendered `.xterm-rows > div` text instead — which lines are on screen is the
  only honest observable.
- **Fixture transcripts are short** (the longest, `hero-refresh`, is eight
  lines), so a spec that needs scrollback must shrink the viewport *before* the
  terminal mounts.
