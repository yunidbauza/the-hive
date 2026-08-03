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

## Colour

Terminal colour lives in JS, never CSS. xterm resolves colours from its own
`theme` option and paints them into markup it owns, so a `--cc-*` custom
property declared on `:root` has no path to a terminal cell.

> **A correction worth keeping.** Earlier revisions of these docs justified this
> with "xterm paints to a canvas". That reason was wrong even though the
> conclusion holds: xterm 6 core ships the **DOM** renderer by default, and this
> app installs neither `@xterm/addon-canvas` nor `@xterm/addon-webgl`. A live
> instance renders as `.xterm-dom-renderer-owner-*` with zero canvas elements.
> The palette has to be JS either way.

`TERM` and `XTERM_THEME` in `src/lib/terminal/ansi.ts` are the single
definition, shared with the colorizer and `.claude/DESIGN-SYSTEM.md`. Never
hand-write a hex into a terminal component.

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
