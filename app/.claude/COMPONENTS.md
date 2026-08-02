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

Not yet built. Each is owned by the story that first needs it; the signatures
below are the contract those stories should implement, not existing code.

| Atom | File | Owner | Intended props |
| --- | --- | --- | --- |
| `TabBar` | `ui/tab-bar.tsx` | 030 (reused by 050) | `tabs: { id: string; label: string; badge?: number }[]`, `active: string`, `onSelect(id: string): void` |
| `StatusDot` | `ui/status-dot.tsx` | 031 (also 032, 041) | `status: SessionStatus \| 'online'`, `pulse?: boolean` |
| `Chip` | `ui/chip.tsx` | 021 (also 040) | `children: ReactNode`, `tone?: Tone`, `title?: string` |
| `Badge` | `ui/badge.tsx` | 030 (also 050, 052) | `count: number`, `tone?: Tone` |
| `KeyHint` | `ui/key-hint.tsx` | 041 (also 043) | `keys: string[]`, `label: string` |

Rules for all of them:

- Colour through Tailwind token utilities (`bg-panel`, `text-muted`). **No raw hex
  literals.**
- `StatusDot` pulses via `animate-ccpulse` — never a hand-written keyframe.
- Status is never carried by colour alone; pair the dot with its label.
- Props are the whole API. An atom that reaches into a store is not an atom —
  move it into a feature slice.

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

### Region placeholders

Each is a bare panel today, owned by the story that fills it in. Story 020 built
the boxes; nothing else about them is settled.

| Region | File | Filled in by |
| --- | --- | --- |
| `Header` | `layout/header.tsx` | 021 — brand, model chip, counts, bell, New session |
| `LeftRail` | `layout/left-rail.tsx` | 030 — tab bar, projects/work/agents panels |
| `CenterStage` | `layout/center-stage.tsx` | 040 — view-state machine, session meta bar |
| `ActivityRail` | `layout/activity-rail.tsx` | 050 — tab bar, inbox/PRs/feed panels |

Two placeholders carry real behaviour on purpose, so the shell is exercised
rather than merely rendered:

- `Header` holds the theme toggle, moved out of `src/app.tsx` when the shell
  landed. Story 021 absorbs it into the real seven-zone header.
- `CenterStage` mounts `<TerminalSurface />`, so the `min-w-0` shrink contract is
  proven against a real xterm instance instead of an empty box.

Still unbuilt: `model-chip`, `status-counts` (021), `session-meta-bar` (040).
