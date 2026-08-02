# Terminal architecture

**Scope:** the terminal surface, the transport seam, ANSI colour handling, xterm
configuration, and how live instances are kept alive across tab switches.

**Owned by story 042** (`../../stories/042-terminal-surface.md`). This file is a
placeholder until that story lands; it exists now so the routing table in
`../AGENTS.md` never points at a missing file.

## What already holds today

- `src/components/terminal/` may not import from `features/`, `data/`, or
  `stores/`. This is a lint zone, not a convention — see story 014.
- xterm paints to a canvas that CSS custom properties cannot reach, so terminal
  colour lives in JS: `TERM` and `XTERM_THEME` in `src/lib/terminal/ansi.ts` are
  the single definition, shared with the ANSI colorizer and
  `.claude/DESIGN-SYSTEM.md`.
- The terminal keeps its dark background in light mode.
- In unit tests xterm is a recording fake (`__mocks__/@xterm/`). Anything needing
  a rendered terminal is asserted in Playwright.

## What story 042 adds here

The `TerminalTransport` interface (`write` / `onData` / `resize`), the
`StaticTransport` prototype implementation, `terminal-host.tsx` and its keyed
kept-alive instances, and the scrollback/selection behaviour.
