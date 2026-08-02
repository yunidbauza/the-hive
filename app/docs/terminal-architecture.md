# Terminal architecture

**Scope:** the terminal surface, the transport seam, ANSI colour handling, xterm
configuration, and how live instances are kept alive across tab switches.

**Owned by story 042** (`../../stories/042-terminal-surface.md`).

## The seam

Everything the terminal renders, and every keystroke it produces, crosses one
interface:

```ts
export interface TerminalTransport {
  write(data: string): void;                       // keystrokes → backend
  onData(cb: (chunk: string) => void): () => void; // backend → terminal
  resize(cols: number, rows: number): void;
}
```

`src/components/terminal/` is written against that and nothing else. It cannot
import `features/`, `data/`, or `stores/` — the import zone in
`eslint.config.mjs` makes a violation fail `pnpm lint`, not review.

| Module | Knows about | Role |
| --- | --- | --- |
| `lib/terminal/terminal-transport.ts` | nothing | the interface |
| `lib/terminal/static-transport.ts` | the store | prototype implementation |
| `lib/terminal/ansi.ts` | the palette | `TermColor` → SGR truecolor |
| `lib/terminal/auto-scroll.ts` | nothing | the bottom-stick predicate |
| `components/terminal/terminal-surface.tsx` | a transport | one live terminal |
| `components/terminal/terminal-host.tsx` | opaque ids | kept-alive registry |

**The rule that keeps it honest:** if a future story needs the terminal
component to read the store, that story is wrong — the data belongs in a
transport. When the PTY daemon arrives, a `PtyTransport` implementing those
three methods drops in and no component changes.

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
