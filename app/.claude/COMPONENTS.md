# Components

Read this alongside [`DESIGN-SYSTEM.md`](DESIGN-SYSTEM.md) before any UI task.

Components live in three places, and the boundary between them is lint-enforced:

- `src/components/ui/` — shadcn primitives and Hive atoms. Domain-agnostic.
- `src/components/layout/` — app chrome, the fixed three-column shell.
- `src/components/terminal/` — the terminal. Infrastructure, not a feature.

`src/components/**` may not import from `src/features/**`. Chrome and atoms stay
domain-agnostic; a component that needs to know about sessions belongs in a
feature slice.

## shadcn/ui primitives

Only the primitives the UI actually needs are installed. **Do not bulk-install the
library** — every added primitive is code we own and must keep.

| Primitive | Why it is here |
| --- | --- |
| `dialog` | the new-session picker overlay (story 044) |
| `tooltip` | the meta-bar back button (story 040) |
| `dropdown-menu` | model / effort selection (story 044) |

Everything else the concept needs is a Hive atom, because the concept's chrome is
tighter and more terminal-native than shadcn's defaults.

These files are vendored: they are generated output, adapted only where they had
to be. Two adaptations are in place and should be preserved on regeneration:

- Icons come from `@phosphor-icons/react`, not `lucide-react`. The app ships one
  icon library.
- `dialog.tsx`'s footer close control is a plain styled `DialogPrimitive.Close`
  rather than the shadcn `button` primitive, which is not installed.

## Terminal

### `<TerminalSurface />`

`src/components/terminal/terminal-surface.tsx`

```ts
function TerminalSurface(): JSX.Element
```

Mounts an xterm instance, loads the fit addon, refits on container resize, and
disposes on unmount. Takes no props today.

Its container is held in **state behind a callback ref**, not a `useRef`. A ref's
`.current` is already populated when the mount effect runs, which makes a
null-check on it dead code — an untestable branch that erodes the coverage gate.
The callback ref makes the null case a genuine state React passes through.

**Story 042 replaces this** with the real surface: it will take a
`TerminalTransport` and nothing else, and keep instances alive across tab
switches. The invariant that starts here is the one that matters most in this
codebase — see [`../docs/terminal-architecture.md`](../docs/terminal-architecture.md).

## Hive atoms

Each is owned by the story that first needs it. Two are built; the rest are a
contract for their owning story, not existing code.

| Atom | File | Owner | Props | State |
| --- | --- | --- | --- | --- |
| `Chip` | `ui/chip.tsx` | 021 (also 040) | `children: ReactNode`, `tone?: Tone`, `title?: string`, `className?: string` | **built** |
| `Badge` | `ui/badge.tsx` | **021** (also 030, 050, 052) | `count: number`, `tone?: 'danger' \| 'brand' \| 'muted'`, `label?: string`, `className?: string` | **built** |
| `TabBar` | `ui/tab-bar.tsx` | **030** (reused by 050) | generic over `Id extends string`: `tabs: { id: Id; label: string; badgeCount?: number; badgeLabel?: string }[]`, `active: Id`, `onSelect(id: Id): void`, `label: string`, `className?: string` | **built** |
| `StatusDot` | `ui/status-dot.tsx` | **030** (used by 031, 032, 041) | `status: SessionStatus \| 'online'`, `pulse?: boolean`, `label?: string`, `className?: string` | **built** |
| `KeyHint` | `ui/key-hint.tsx` | 041 (also 043) | `keys: string[]`, `label: string` | planned |

`Badge` moved from story 030 to 021: the header's bell needs an unread count,
and 021 lands first. 030's tab-bar badges reuse it rather than building a second.

Rules for all of them:

- Colour through Tailwind token utilities (`bg-panel`, `text-muted`). **No raw hex
  literals.**
- `StatusDot` pulses via `animate-ccpulse` — never a hand-written keyframe.
- Status is never carried by colour alone; pair the dot with its label.
- Props are the whole API. An atom that reaches into a store is not an atom —
  move it into a feature slice.

Contracts worth knowing before reusing them:

- **`Badge` renders nothing at zero.** Every caller so far means *nothing to see*
  by a count of zero, so the empty badge is never the right answer.
- **`Badge`'s `label` is optional, and its absence is meaningful.** With a label
  it announces `"3 unread notifications"`; without one it is `aria-hidden`
  decoration. Omit it inside an already-labelled control — an ancestor
  `aria-label` replaces its descendants' text outright, so a label there would
  never be announced. The header's bell does exactly this.
- **`StatusDot` follows the same label contract.** With a `label` it announces
  `"lead-form status: needs input"`; without one it is `aria-hidden` decoration.
  Omit it wherever a visible status label already sits beside the dot (031); pass
  it where none does (032), so status is never carried by colour alone.
- **`StatusDot` derives its pulse from its status**, so only `working` pulses.
  `pulse` is an override for the rare caller that needs otherwise.
- **`STATUS_LABEL` is exported from `ui/status-dot.tsx`** and owns the
  `waiting → "needs input"` rename. Import it rather than re-deriving it.
- **`TabBar`'s badge reuses `Badge` at `Badge`'s geometry**, not the concept's
  15px/9.5px. One badge geometry with three tones beats a second near-identical
  atom; the 1px difference is deliberate.
- **`TabBar` is generic over its id type.** Pass `Tab<LeftTab>[]` and `onSelect`
  hands back a `LeftTab`, not a `string` — no `as` cast at the call site, and an
  id outside the union stops compiling.
- **Set `badgeLabel` whenever you set `badgeCount`.** This is the one place the
  usual "omit the label" advice inverts: a tab is named by its *content*, not by
  an `aria-label`, so an unlabelled badge is `aria-hidden` and its number reaches
  nobody using a screen reader. With it, the tab announces `"Work 8 work items"`.
- **Use the exported `tabId(id)` helper** for a panel's `aria-labelledby` rather
  than re-spelling the `tab-${id}` convention; the atom owns that format.

## Layout

### `<AppShell />`

`src/components/layout/app-shell.tsx` — story 020, built.

```ts
function AppShell(): JSX.Element
```

The fixed three-column chrome: `<Header />` on top, then a row of `<LeftRail />`,
`<CenterStage />`, and `<ActivityRail />`. Takes no props; reads
`useShowActivityRail()` to decide whether the activity rail is mounted at all.

`src/app.tsx` renders `<AppShell />` and nothing else.

The four regions are landmark elements — `<header>`, `<nav>`, `<main>`,
`<aside>` — so tests address them by role. The flexbox contract that holds the
layout together is documented in
[`../docs/component-patterns.md`](../docs/component-patterns.md); do not touch
the `min-h-0` / `min-w-0` / `shrink-0` classes without reading it.

### `<Header />`

`src/components/layout/header.tsx` — story 021, built.

Seven zones, left to right: brand block, model chip (sessions only), spacer,
fleet status counts, theme toggle, inbox bell, New session. 56px tall, `gap-14px`,
`px-4`.

**The header composes and nothing else.** Every zone that reads domain state owns
its own subscription, so a session changing status repaints one span rather than
the whole bar. Its three sub-components are tested independently; the header's own
tests cover only the wiring.

| Sub-component | File | Reads | Notes |
| --- | --- | --- | --- |
| `BrandBlock` | `layout/brand-block.tsx` | — | pure; 30px tile + `/hive-mark.png` |
| `ModelChip` | `layout/model-chip.tsx` | `useActiveEntity()` | renders `null` unless the active tab is a **session** |
| `StatusCounts` | `layout/status-counts.tsx` | `useCounts()` | derived in the selector, never stored |

Two things here are easy to get wrong:

- **The brand tile uses `bg-brand-fill-strong`, not `bg-brand`.** `--cc-brand` is
  a text colour that flips per theme; using it would repaint the logo tile pale
  blue in dark mode. See the brand-fill note in
  [`DESIGN-SYSTEM.md`](DESIGN-SYSTEM.md).
- **The model chip's numbers are mock and *derived*, not stored** — see
  `src/lib/session-metrics.ts`. A stored percentage would need a fake clock to
  move it; a random one would jitter on every render. Deriving from the session's
  own id keeps a chip stable for the session's life while differing between
  sessions. When real metering arrives, `ctx`/`util` become `Session` fields and
  only those functions change.

The bell marks everything read rather than opening a dropdown — the inbox lives in
the activity rail (story 051), and two places to read the same list is one too
many.

### `<LeftRail />`

`src/components/layout/left-rail.tsx` — story 030, built.

268px fixed. A flex column of two children: a pinned `<TabBar />` and a scrolling
tab panel that mounts exactly one of `ProjectsPanel` (031), `WorkPanel` (032), or
`AgentsPanel` (033). Reads `useLeftTab()` / `useSetLeftTab()`, plus
`useTicketCount()` for the Work tab's badge.

**The tab bar does not scroll — the panel below it does.** Scrolling the rail as a
whole would push the tabs off-screen as soon as a project tree grew, taking away
the one control the user needs to get back out of it.

Panel state lives in the stores, never in the panels: `collapsed` in the ui-store
is why a collapsed project survives a round trip through the Agents tab even
though the panel unmounts on every switch.

### `components/layout/` is the composition root

It is the one place under `src/components/` allowed to import `src/features/**` —
the rails and the center stage exist to mount feature panels. `components/ui/` and
`components/terminal/` stay fully fenced. See AGENTS.md → Import zones;
`pnpm verify:boundaries` proves both halves.

### Region placeholders

Still bare panels, owned by the story that fills each in.

| Region | File | Filled in by |
| --- | --- | --- |
| `CenterStage` | `layout/center-stage.tsx` | 040 — view-state machine, session meta bar |
| `ActivityRail` | `layout/activity-rail.tsx` | 050 — tab bar, inbox/PRs/feed panels |

`CenterStage` mounts `<TerminalSurface />` on purpose, so the shell's `min-w-0`
shrink contract is proven against a real xterm instance rather than an empty box.

Still unbuilt: `session-meta-bar` (040), `KeyHint` (041).
