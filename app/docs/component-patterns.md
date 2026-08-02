# Component patterns

**Scope:** panels, atoms, the rails, and the center-stage view-state machine.

**Owned by stories 020–053.** The shell (020) has landed; the panels have not.

## What already holds today

- Chrome lives in `src/components/layout/`, shared atoms in
  `src/components/ui/`, and domain surfaces in `src/features/<slice>/`.
- A feature slice follows the bulletproof-react shape: `components/`, `hooks/`,
  `stores/`, `types/`, `utils/`, plus an `index.ts` barrel that is the only thing
  outside code imports.
- Slices never import each other. Cross-slice communication goes through the
  store, or through `features/shared`.
- `src/components/**` may not import from `features/**` — chrome and atoms stay
  domain-agnostic.
- Colour comes from `--cc-*` tokens via Tailwind utilities. Raw hex literals in
  component code are banned.
- Only the shadcn primitives actually needed are installed: `dialog`, `tooltip`,
  `dropdown-menu`.

## The shell

`src/components/layout/app-shell.tsx` is the whole chrome. `src/app.tsx` renders
it and nothing else.

```
<body>                      100vh, overflow hidden, --cc-bg / --cc-ink
└── AppShell                flex column, h-full
    ├── Header              <header>  56px fixed, --cc-panel, border-bottom soft
    └── Row                 flex-1, min-h-0, flex
        ├── LeftRail        <nav>     268px fixed, --cc-panel, border-right soft,
        │                             own vertical scroll
        ├── CenterStage     <main>    flex-1, min-w-0, --cc-panel-2, flex column
        └── ActivityRail    <aside>   316px fixed, --cc-panel, border-left soft,
                                      own vertical scroll, unmounted when hidden
```

Each region is a landmark element, so tests address them by role
(`banner` / `navigation` / `main` / `complementary`) rather than by class.

### The rules the layout depends on

- **`min-h-0` on the row and `min-w-0` on the center stage.** A flex item
  defaults to `min-*: auto` and refuses to shrink below its content. Without
  `min-h-0` a tall rail pushes the shell past the viewport instead of scrolling
  inside itself; without `min-w-0` a long terminal line widens the center column,
  which xterm's fit addon then measures and grows into. Both are load-bearing,
  not defensive.
- **The rails never flex** (`w-[268px]` / `w-[316px]` + `shrink-0`), so the
  center column absorbs every width change and the document never gains a
  horizontal scrollbar.
- **The page never scrolls.** `body { overflow: hidden }` plus `overflow-y-auto`
  on each rail — three independent scrollbars, and the terminal keeps a stable
  size regardless of what lands in the rails.
- **The activity rail unmounts rather than hides.** `showActivityRail` in the
  ui-store is read through `useShowActivityRail()` — deliberately narrower than
  `useRailState()`, so switching rail tabs does not re-render the terminal.

Desktop-width only, by design: no responsive or mobile layout, and the rails are
not draggable. Both are explicit non-goals of story 020.

## The header

`src/components/layout/header.tsx` (story 021) fills the shell's top region.
Anatomy, sub-component contracts, and the two easy-to-get-wrong details live in
[`../.claude/COMPONENTS.md`](../.claude/COMPONENTS.md). The pattern worth
repeating in every other region:

**Chrome composes; the leaves subscribe.** The header itself reads only what its
own controls need. `ModelChip` and `StatusCounts` each own their store
subscription, so a session changing status repaints one span rather than the
whole bar. Rails and panels should be built the same way — a container that
subscribes on behalf of its children re-renders all of them.

Its corollary in tests: sub-components are asserted in their own files, and the
container's tests cover only the wiring.

## What later stories add here

The left rail and its three panels (030–033), the center-stage view-state machine
and session meta bar (040), the activity rail and its three panels (050–053), and
the atom inventory those stories introduce. Each fills in the placeholder region
it owns; the shell itself does not change.
