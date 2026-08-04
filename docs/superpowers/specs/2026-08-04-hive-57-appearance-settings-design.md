# 105 — Appearance settings (HIVE-57) — design

| | |
|---|---|
| **Ticket** | HIVE-57 |
| **Epic** | [100 — Settings](../../../stories/100-settings-epic.md) (HIVE-51) |
| **Depends on** | 101 (HIVE-52) — the overlay, the section nav, the write path |
| **Points** | 5 |
| **Location** | `app/src/stores/appearance-store.ts`, `app/src/features/settings/components/`, `app/src/components/ui/`, `app/src/styles/tokens.css`, `app/src/components/terminal/` |

The epic's story table gives this story four items — theme including **system**,
terminal font family and size, scrollback limit, and rail density — and flags it
as the one story in the 104–107 group carrying an unresolved question:

> Everything else in the epic writes to `~/.hive/config.json` through main's
> single write path. These settings are renderer state, so where they live is
> genuinely undecided and this story has to decide it.

This document decides it, and records four other decisions the reconciliation
turned up that the ticket could not have known about.

## The decision the story carries: where renderer state lives

**`localStorage`, through zustand's `persist` middleware, in a new
`src/stores/appearance-store.ts`.** Not `~/.hive/config.json`.

The config file is main's, and everything in it describes the *workspace* — where
projects are, which shell to spawn, what command starts an agent. Those are facts
about the machine that a session needs before it can run. Appearance is a fact
about the person looking at the screen, needed by the renderer before its first
paint and by nothing else.

Three things follow from that and each of them argues the same way:

- **First paint.** The config arrives over an async bridge call. Theme read that
  way means the app paints dark, then flips — on every launch, forever. A
  synchronous `localStorage` read during store construction has no such frame.
- **The browser target exists.** `pnpm dev` serves a fixtures-only demo with no
  preload and therefore no `window.hive`. Appearance in the config file would
  need a renderer-side fallback anyway, so the config path buys a second
  mechanism rather than replacing one.
- **The config file is hand-editable and comment-heavy on purpose.** `template.ts`
  explains why. Adding `theme`, `terminalFontSize` and `railDensity` to it makes
  the file about two unrelated things, and grows `TOP_LEVEL_KEYS`, the guards,
  and `CONFIG_VERSION` for settings main never reads.

What this costs, stated plainly: appearance does not follow the user to another
machine and cannot be set by hand in an editor. Both are acceptable for a
single-machine, single-window app whose config file explicitly declines sync
(epic → *Explicitly not in this epic*).

The epic's binding "one write path, whole-file and atomic" is respected rather
than dodged — it binds *"to the extent any of these settings do land in the
config file"*, and none of them do.

### Why a new store rather than persisting `ui-store`

`ui-store` is view state: `activeTab`, `picker`, `selIdx`, `collapsed`. Persisting
it would restore a picker that was open when the app quit. `persist` has
`partialize` to whitelist fields, but that turns every future `ui-store` field
into a question somebody has to remember to answer, and answering it wrong is
silent.

A separate store makes the boundary structural: everything in `appearance-store`
is persisted, everything in `ui-store` is not. `theme` **moves** out of `ui-store`
into it — it has exactly two consumers (`header.tsx`, `center-stage.tsx`), so the
move is cheap now and gets more expensive with every story that adds one.

## Four corrections the ticket could not have known about

### 1. The section nav does not exist yet — this story builds it

The epic states the nav is "already built to hold six" (→ *The section list exists
from the first story*). It is not. `settings-overlay.tsx:38` is a one-item array
rendered as inert `<span>`s, with `<ProjectsSection />` hardcoded below it and no
`activeSection` state, no click handling, and no section→component map.

This story lands the real switcher, following `left-rail.tsx:26`'s `PANELS`
pattern exactly — a `Record<SectionId, ComponentType>` beside the array. It is
assigned here rather than to 104 because 105 is sequenced first (epic: *105 …
should not be last*), and whichever section lands second was always going to pay
this cost.

`activeSection` is component-local `useState`, not `ui-store`: settings should
always open on Projects. The realistic route in is the picker discovering it has
no projects, and reopening onto whatever pane was last visited would strand that
user in Appearance.

### 2. Terminal font size, family and scrollback change **in place**

`terminal-surface.tsx:239` lists `fontSize` in the mount effect's dependency
array, with a comment calling it "structural". That was true when nothing set it:
the prop existed and no caller passed it, so the rebuild path never ran.

The moment it becomes a live setting the comment is wrong in a way that costs the
user something real — a rebuild disposes the terminal, and disposing the terminal
throws away the scrollback of every kept-alive instance. Changing a font size
should not clear thirteen transcripts.

xterm supports all three in place:

```ts
terminal.options.fontFamily = …;
terminal.options.fontSize = …;
terminal.options.scrollback = …;
fitAddon.fit();   // font metrics changed, so the box must be re-measured
```

So they join `theme` in the re-configure-in-place effect and leave the mount
deps. `readOnly` stays structural and stays in the deps — `disableStdin` genuinely
cannot be changed after construction, which is what the comment was right about.

The refit is not optional: a font change alters cell width and height, and a
terminal that is not re-fitted afterwards reports stale `cols`/`rows` to its
transport and renders into the wrong box.

### 3. Terminal settings reach the terminal by prop, not by store

`src/components/terminal/**` may not import `src/stores/**` — the lint zone fails
the build. `center-stage.tsx` is in `components/layout/`, the composition root,
and already does exactly this for `theme`: reads the store, passes a prop. The
three new values follow the same wire. The seam is untouched.

### 4. Font choices are system faces, not webfonts

There is no webfont in the app and the design system declines one for a single
heading (`tokens.css:130`). Offering "JetBrains Mono" would silently render as
whatever the fallback is on a machine that lacks it, which reads as a broken
setting rather than an absent font.

So the list is faces that ship with an OS — the current stack as **System
default**, plus SF Mono, Menlo, Monaco, Consolas, Courier New — each as a stack
ending in `monospace`. The section says out loud that a face not installed falls
back.

## Rail density

Net-new; nothing like it exists. Implemented as CSS custom properties in
`tokens.css`, switched by `body[data-density='compact']`, the same mechanism
`data-theme` already uses. Component code reads them through Tailwind arbitrary
values (`w-[var(--cc-rail-w-left)]`), so the toggle is one attribute write and no
component re-renders.

Seven variables, chosen because they are what actually reads as "dense" — rail
width, the gap between a rail's tab bar and its panel, list gap, row padding,
card padding:

| Token | Comfortable | Compact | Read by |
|---|---|---|---|
| `--cc-rail-w-left` | `268px` | `232px` | left rail |
| `--cc-rail-w-right` | `316px` | `276px` | activity rail |
| `--cc-rail-gap` | `18px` | `11px` | both rails |
| `--cc-list-gap` | `10px` | `6px` | work, activity feed |
| `--cc-list-gap-sm` | `8px` | `5px` | inbox, PRs |
| `--cc-row-py` | `7px` | `4px` | agent row, project row |
| `--cc-card-py` | `10px` | `6px` | notification, PR, ticket cards |

There are **two** list-gap scales because the panels already had two: work and
the activity feed sit at 10px, the inbox and PRs at 8px. Collapsing them into
one token would have re-spaced two panels in *comfortable* mode — a visual
change this story is not making — so each keeps its own value and gets its own
compact one.

Rail widths change, so `min-w-0` on the center stage carries the resize into
xterm's fit addon — which is already how a window resize works. No new plumbing.

## The `system` theme

`Theme` becomes the stored **preference** `'system' | 'dark' | 'light'`; what the
DOM gets is a separate resolved value.

**The default stays `dark`.** This story adds `system` as an *option*; it does
not change what the app boots as. "Dark is the default" is story 011's decision,
it is what `:root` in tokens.css encodes, and `smoke.spec.ts` calls the header's
theme button "the one observable proof of which theme booted". Defaulting to
`system` was tried during implementation and broke three existing browser specs —
correctly, because it silently reversed a documented decision this story has no
mandate to reverse, and the only symptom would have been the app looking
different on someone else's laptop.

`system` is not a third palette — it is "ask the OS". The store keeps a
`systemDark: boolean`, updated by a `matchMedia('(prefers-color-scheme: dark)')`
listener, and `resolvedTheme` is computed in a **selector**, never stored, per
AGENTS.md's one-source-of-truth rule. `systemDark` is excluded from `partialize`:
it is an observation of the environment, not a preference, and persisting it
would restore a stale answer on a machine that has since changed.

`applyTheme` keeps its current contract — light sets `body[data-theme='light']`,
dark removes the attribute — and is now fed the resolved value.

The header's theme button keeps working. `toggleTheme` moves to "cycle through
the resolved pair": from `system` it commits to the opposite of what is currently
showing, which is what a user pressing it expects, rather than cycling three ways
through a state they never chose.

## Two new atoms

`components/ui/` has no form primitives at all — no input, select, switch, radio,
or slider. This story adds the two that cover every control it needs, and no more:

- **`segmented-control.tsx`** — theme (3) and density (2). A radio group in
  behaviour: arrow keys move and select, `role="radiogroup"`.
- **`select-field.tsx`** — font family, font size, scrollback. A styled native
  `<select>`; the platform menu is better than anything hand-rolled here and is
  keyboard- and screen-reader-correct for free.

## Acceptance criteria

- [ ] Settings has a working two-item nav; clicking **Appearance** shows the
      appearance pane and clicking **Projects** returns, with `aria-current`
      tracking the active item.
- [ ] Theme offers **System / Dark / Light**; System follows the OS and reacts to
      the OS changing while the app is open.
- [ ] Theme, terminal font family, font size, scrollback and density survive a
      full reload of the app.
- [ ] Changing font family, font size or scrollback **does not clear terminal
      scrollback**, and the terminal re-fits afterwards.
- [ ] Compact density visibly narrows both rails and tightens rows in every rail
      panel.
- [ ] A corrupt or absent `localStorage` entry falls back to defaults without
      throwing.
- [ ] `pnpm lint`, `pnpm type-check`, `pnpm test` (80% coverage gate) all pass.

## Files

| File | Change |
|---|---|
| `src/stores/appearance-store.ts` | **new** — persisted store, selectors |
| `src/stores/ui-store.ts` | remove `theme`/`setTheme`/`toggleTheme` and their selectors |
| `src/lib/terminal/fonts.ts` | **new** — the font stack table, size and scrollback choices |
| `src/components/ui/segmented-control.tsx` | **new** |
| `src/components/ui/select-field.tsx` | **new** |
| `src/features/settings/components/appearance-section.tsx` | **new** |
| `src/features/settings/components/settings-overlay.tsx` | real section switcher |
| `src/components/terminal/terminal-surface.tsx` | in-place font/scrollback, deps corrected |
| `src/components/terminal/terminal-host.tsx` | thread `fontFamily`/`scrollback` |
| `src/components/layout/center-stage.tsx` | read appearance store, pass props |
| `src/components/layout/header.tsx` | theme from the new store |
| `src/components/layout/left-rail.tsx`, `activity-rail.tsx` | density vars |
| `src/features/*/components/*row*.tsx`, `*card*.tsx` | density vars |
| `src/styles/tokens.css` | density custom properties |

Tests mirror each of these under `tests/`.
