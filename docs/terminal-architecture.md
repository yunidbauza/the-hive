# Terminal architecture

**Scope:** the terminal surface, the transport seam, ANSI colour handling, xterm
configuration, and how live instances are kept alive across tab switches.

**Owned by story 042** (HIVE, Jira).

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
| `lib/terminal/ansi.ts` | both palettes | `TermColor` → indexed SGR; theme → xterm theme |
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

`TERM`, `TERM_LIGHT` and the themes built from them in
`src/lib/terminal/ansi.ts` are the single definition, shared with the colorizer
and `.claude/DESIGN-SYSTEM.md`. Never hand-write a hex into a terminal component.

The light palette is the one place a terminal colour and a CSS token hold the
same value — deliberately, and enforced by a test rather than by convention.
See **Theming** below.

### Slots 30 and 90 are surfaces (HIVE-82)

A palette decides what the *named* colours mean. Until HIVE-82 it named eleven
text colours and one ground, and `xtermThemeFor` bound ANSI `black` to
`palette.black` and `brightBlack` to `palette.dim` — both text.

**Claude Code paints its own chrome out of exactly those two slots**: the
submitted-prompt row, the composer sidebar, the bash block. So in the light
theme the row the user had just typed came back as a near-black bar across a
white terminal, and in dark as a light periwinkle slab on navy. The same
mismatch made an `AskUserQuestion` unreadable at **1.05:1**.

The palette now carries two surface roles, `surface` and `surfaceAlt`, and the
two slots resolve to them. They are **optional** in a theme file — `surfacesOf`
blends them out of `bg` when absent — so every theme exported under HIVE-80
imports unchanged.

The rule this replaced had a real reason: a CLI that detects a light terminal
picks slot 30 for body text, and against a light surface that text disappears.
That reason has moved rather than gone. `terminal-surface.tsx` passes
`minimumContrastRatio: 4.5`, so xterm lifts exactly that foreground — the rescue
the old note in `ansi.ts` correctly said was unavailable at the default of `1`.
A **background** has no equivalent: xterm adjusts foregrounds only. One of the
two had to give, and only one had a mechanism behind it.

The app's own `dim` transcript colour moved off slot 90 to 256-colour index
`244`, so it never depends on that rescue. It is still an *index*, which is what
keeps a theme toggle repainting transcript text written minutes ago.

### Why this is what makes a running session follow the theme

`hooks/settings.ts` pins Claude Code's own theme to **`dark-ansi`**, and that is
the other half of the fix rather than a cosmetic preference.

Under `dark` or `light`, Claude emits **24-bit** colour — measured against
2.1.245, the submitted-prompt row is `rgb(55,55,55)` and `rgb(240,240,240)`. A
truecolor cell stores its resolved RGB, so re-theming the terminal cannot reach
it: scrollback would stay wrong forever, and the live frame would stay wrong
until the process restarted, because the setting is read once at startup.

Under `dark-ansi` it emits **no truecolor at all** — every colour is an ANSI
index. An index is resolved against the active theme at paint time, so
reassigning `options.theme` repaints Claude's chrome *including scrollback*,
with nothing re-read and nothing restarted. That is why nothing in this app
tells a running session about a theme change: there is nothing to tell it.

`dark-ansi` rather than a `light-ansi`/`dark-ansi` pair, because a pinned theme
must be right in both modes and only one of them is. Its `text` is
`ansi:whiteBright` → `palette.ink`, which follows the mode. `light-ansi`'s
`text` is `ansi:black`, which is now a surface — invisible.

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

**The terminal follows the app theme** — and since HIVE-80 it does so without
knowing that. The surface takes a `palette` prop, exactly as it takes a font
stack, and `xtermThemeFor(palette)` maps any eleven-colour palette into xterm's
sixteen slots, so two palettes can differ in colour but never in structure.
Which one arrives is the composition root's decision: `center-stage.tsx` reads
`useTerminalAppearance()` and passes `palette` down. `TERM` and `TERM_LIGHT` are
the built-in theme's two `terminal` groups under a name.

This reverses stories 011 and 042, which pinned the terminal dark in both themes
and allowed only selection and cursor to vary. That reasoning — a terminal is
dark because that is what a terminal is — describes a terminal *emulator*, whose
window is the whole application. Here the terminal shares the centre stage with
an editor that follows the theme properly, and a dark slab in the middle of a
light app reads as a panel that failed to load. The seam was loudest exactly
where the two surfaces meet, which is what made it worth reversing.

Three details carry the change:

- **The light palette mirrors `tokens.css`.** Every `TERM_LIGHT` value is also a
  `--cc-*` token, because the light terminal shares the editor's ground and a
  second light identity would be the bug. xterm cannot read a custom property,
  so the value exists twice and `ansi.test.ts` fails if the copies drift. The
  dark palette keeps the opposite rule, for the reason above it.
- **`--cc-term-bg` must equal `TERM_LIGHT.bg`.** xterm paints its own
  background; the DOM paints the padding around it. Disagreement shows up as a
  rectangle at the terminal's edge.
- **Transcript colour is emitted as an ANSI index, not truecolor.** `colorize`
  writes `\e[32m`, not `\e[38;2;…m`. A baked RGB value lives in the cell
  and no later theme change can reach it; an index resolves against the active
  theme at paint time, so a toggle repaints scrollback written minutes ago.

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

**Playwright** owns everything that needs a rendered terminal: palette colours on
screen, selection, scroll position across tab switches, refit on resize, and
re-theming. That lives in `tests/e2e/electron/`, against real PTYs — the web
project's `terminal.spec.ts` covered it while the store booted with a seeded
fleet, and went with the seed. A browser has no way to open a session to render.

Two gotchas worth knowing before writing a spec:

- **xterm 6 does not scroll `.xterm-viewport` natively.** It has no scroll area
  and reports `scrollHeight === clientHeight` at every position. Read the
  rendered `.xterm-rows > div` text instead — which lines are on screen is the
  only honest observable.
- **Fixture transcripts are short** (the longest, `hero-refresh`, is eight
  lines), so a spec that needs scrollback must shrink the viewport *before* the
  terminal mounts.
