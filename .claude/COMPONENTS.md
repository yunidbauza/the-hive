# Components

Read this alongside [`DESIGN-SYSTEM.md`](DESIGN-SYSTEM.md) before any UI task.

Components live in three places, and the boundary between them is lint-enforced:

- `src/components/ui/` — shadcn primitives and Hive atoms. Domain-agnostic.
- `src/components/layout/` — app chrome, the fixed three-column shell.
- `src/components/terminal/` — the terminal. Infrastructure, not a feature.

`src/components/ui/**` and `src/components/terminal/**` may not import from
`src/features/**`. Atoms and the terminal stay domain-agnostic; a component that
needs to know about sessions belongs in a feature slice. `src/components/layout/`
is the exception — the composition root, where feature panels get mounted; see
below.

## shadcn/ui primitives

Only the primitives the UI actually needs are installed. **Do not bulk-install the
library** — every added primitive is code we own and must keep.

| Primitive | Why it is here |
| --- | --- |
| `dialog` | the new-session picker overlay (story 044) |
| `tooltip` | the meta-bar back button (story 040) |
| `dropdown-menu` | model / effort selection (story 044) |
| `popover` | the round-two connection item (HIVE-196) |

Everything else the concept needs is a Hive atom, because the concept's chrome is
tighter and more terminal-native than shadcn's defaults.

These files are vendored: they are generated output, adapted only where they had
to be. Two adaptations are in place and should be preserved on regeneration:

- Icons come from `@phosphor-icons/react`, not `lucide-react`. The app ships one
  icon library.
- `dialog.tsx`'s footer close control is a plain styled `DialogPrimitive.Close`
  rather than `ui/button.tsx`'s `Button` atom, which postdates it.

### `Popover` / `PopoverTrigger` / `PopoverContent`

`src/components/ui/popover.tsx` — HIVE-196. The shadcn wrapper over `radix-ui`'s `Popover`;
content portals, `sideOffset` 4, `bg-panel` with `border-border`. Esc, a click outside or a second
click closes it.

## Terminal

### `<TerminalSurface />`

`src/components/terminal/terminal-surface.tsx`

```ts
function TerminalSurface(props: {
  transport: TerminalTransport;
  theme: 'dark' | 'light';
  id?: string;        // opaque; surfaced as data-terminal-id for e2e
  fontSize?: number;  // default 12.5
  readOnly?: boolean; // true everywhere in the prototype
  visible?: boolean;  // hidden instances stay alive
}): JSX.Element
```

One live terminal, fed by a transport and nothing else. It has no idea what a
session is and cannot reach the store — `pnpm lint` fails if it tries.

Container and xterm instance are both held in **state behind callback refs**,
not `useRef`. Two reasons: a ref's `.current` is already populated when the
mount effect runs, making its null-check dead code that erodes the coverage
gate; and holding the *instance* in state is what lets the theme and
subscription effects re-run when a new terminal is constructed, rather than
writing into a disposed one.

`theme` and `transport` are handled by their own effects, so a theme toggle or a
transport swap never destroys scrollback. `fontSize` and `readOnly` are
structural — xterm cannot change `disableStdin` after construction — so they do
rebuild.

### `<TerminalHost />`

`src/components/terminal/terminal-host.tsx`

```ts
function TerminalHost(props: {
  entries: {
    id: string;
    terminalKey: string;
    transport: TerminalTransport;
    readOnly?: boolean;
  }[];
  activeId: string | null;
  endedId?: string | null;
  palette: TermPalette;
  fontFamily?: string;
  fontSize?: number;
  scrollback?: number;
}): JSX.Element
```

`terminalKey` is the React key, so a `/clear` can retire one row and open
another on the pty that is still running. `palette` is resolved colour, not a
theme name — xterm reads colour from JS, never from a custom property.

The kept-alive registry: **one xterm instance per entity, shown and hidden with
CSS**, never one shared instance re-fed on tab switch. Re-feeding would lose
scroll position and selection on every switch. Instances mount lazily on first
visit; ids are opaque here, and the composition root
(`layout/center-stage.tsx`) is what reads the stores and builds the transports.

Full rationale — the seam, colour, fitting, and the bottom-stick rule — is in
[`../docs/terminal-architecture.md`](../docs/terminal-architecture.md).

## Editor

### `<EditorSurface />`

`src/components/editor/editor-surface.tsx` — built.

A CodeMirror 6 instance, fenced exactly like `<TerminalSurface />`: it may not
import `features/`, `data/` or `stores/`, so the composition root reads the
stores and passes values down.

Props: `fileKey`, `value`, `languageLoad`, `readOnly`, `fontFamily`,
`fontSize`, `wordWrap`, `lineNumbers`, `tabWidth`, `onChange`, `onSave`.

- **One view, one `EditorState` per open file.** Cursor, scroll offset and undo
  history all live in the state, so a tab switch is `view.setState(cached)` and
  not a rebuild.
- **A configuration change clears the cache, the active entry included.**
  Extensions are baked in at construction; a state built with the old font would
  keep it and adopt it the moment it was switched to. Getting this wrong makes a
  font change apply to every open file *except* the one on screen.
- **`languageLoad` is a loader, not a resolved language**, so every CodeMirror
  import — including the seventeen dynamic ones — stays inside this directory.
  The document renders before the grammar arrives; that is the point.
- **Colour comes from `--cc-code-*` through `EditorView.theme`.** CodeMirror
  emits real CSS, so the editor follows `data-theme` with no JavaScript. No hex
  literal belongs in this directory.
- **`readOnly` and `editable` are both set.** `readOnly` alone leaves a blinking
  cursor in a document that swallows every keystroke — a hung editor, not a
  read-only one.
- **Split-view sync props:** `onTopLineChange` reports the first visible line;
  `revealLine` scrolls a line to the top once and is cleared through
  `onRevealApplied`, the same request-and-consume shape as `cursor`.

### `<MarkdownPreview />` and `<MarkdownCode />`

`src/components/editor/markdown-preview.tsx`, `markdown-code.tsx` — built.

Props only, inside the editor fence. `MarkdownPreview` takes an `MdDocument`
(`lib/markdown/`), `fontSize`, `onOpenLink(RelativeHref)`, and for split view
`topLine` / `onTopLineChange`.

- **Every element is made from the model; nothing sets HTML.** Raw HTML was
  decided in `lib/markdown/html.ts`, every link goes through `classifyHref`.
- **Only `http(s)` becomes an `<a>`.** Relative and `#anchor` links are
  buttons, so no href resolves against the renderer's own origin.
- **Headings carry `data-anchor`, not `id`.**
- `MarkdownCode` is one fenced block: plain mono at once, highlighted through
  `codeClassHighlighter` when its grammar arrives.

## Hive atoms

Each is owned by the story that first needs it. Two are built; the rest are a
contract for their owning story, not existing code.

| Atom | File | Owner | Props | State |
| --- | --- | --- | --- | --- |
| `Chip` | `ui/chip.tsx` | 021 (also 040) | `children: ReactNode`, `tone?: Tone`, `title?: string`, `className?: string` | **built** |
| `Badge` | `ui/badge.tsx` | **021** (also 030, 050, HIVE-182) | `count: number`, `tone?: BadgeTone` (`danger` \| `brand` \| `muted` \| `green`), `text?: string`, `label?: string`, `className?: string` | **built** |
| `Tag` | `ui/tag.tsx` | **052** | `children: ReactNode`, `tone: 'brand' \| 'green' \| 'amber' \| 'red' \| 'subtle'`, `surface?: 'panel' \| 'raised'`, `title?: string`, `className?: string` | **built** |
| `StatusDot` | `ui/status-dot.tsx` | **030** (used by 031, 032, 041) | `status: SessionStatus \| 'online'`, `pulse?: boolean`, `label?: string`, `className?: string` | **built** |
| `Icon` | `ui/icon.tsx` | **031** (also 033, 051, 053) | `name: string`, `size?: number`, `weight?: IconWeight`, `className?: string` | **built** |
| `KeyHint` | `ui/key-hint.tsx` | 041 (also 043) | `keys: string[]`, `label: string` | planned |
| `SecretField` | `ui/secret-field.tsx` | **HIVE-67** | `label: string`, `value: string`, `onChange(value: string): void`, `onCommit?(): void`, `placeholder?: string`, `hint?: string`, `className?: string` | **built** |
| `SplitHandle` | `ui/split-handle.tsx` | **explorer** | `axis: 'horizontal' \| 'vertical'`, `containerRef: RefObject<HTMLElement>`, `label: string`, `value: number`, `onValue(value: number): void`, `min?`, `max?`, `step?`, `onReset?(): void`, `grip?: boolean`, `className?: string` | **built** |
| `Button` | `ui/button.tsx` | **HIVE-118** | `variant?: 'primary' \| 'secondary' \| 'danger' \| 'ghost'`, `size?: 'sm' \| 'md'`, plus `ButtonHTMLAttributes<HTMLButtonElement>` | **built** |
| `SearchBox` | `ui/search-box.tsx` | **HIVE-192** | `label: string`, `value: string`, `onChange(value: string): void`, `onClear(): void` | **built** |

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
  never be announced.
- **`StatusDot` follows the same label contract.** With a `label` it announces
  `"lead-form status: needs input"`; without one it is `aria-hidden` decoration.
- **`SecretField` is not a masked `TextField`, and must not become one.** It is
  **write-only**: it never displays a stored value, because the app cannot read
  one back. Its `value` is always a *new* secret on its way in, and what is
  already stored is described in prose beside the field. A `type="password"` prop
  on `TextField` would put a masked box on screen that implies a round trip which
  does not exist. It also sets `autocomplete="off"` and `spellcheck="false"`, and
  carries a reveal toggle so a truncated paste can be caught before saving.
  Omit it wherever a visible status label already sits beside the dot (031); pass
  it where none does (032), so status is never carried by colour alone.
- **`StatusDot` derives its pulse from its status**, so only `working` pulses.
  `pulse` is an override for the rare caller that needs otherwise.
- **`STATUS_LABEL` is exported from `ui/status-dot.tsx`** and owns the
  `waiting → "needs input"` rename. Import it rather than re-deriving it.
- **`Tag` is the third pill, and the three do not overlap.** `Badge` takes a
  `count` and renders nothing at zero, so it cannot carry a word. `Chip` is a
  larger mono pill for dense status text (the session header's model chip) and has no `subtle` tone. `Tag` is proportional text at badge
  scale, used for the PRs panel's `merged` / `2 open findings` / `checks
  running` row. Reach for a fourth only when none of those three fits — and say
  why here.
- **`Tag`'s ink carries the tone; its fill carries the *surface*.** All five
  tones share one fill, which is what lets four of them wrap in one row without
  competing. Which fill depends on what is behind them: `surface="panel"` (the
  default) is `bg-chip`, and `surface="raised"` inverts to `bg-panel` for a card
  that is itself chip-filled — the PRs panel's live cards, where a chip pill on a
  chip card would leave only floating coloured text.
- **`Icon` bridges the fixtures' icon strings to the React package.** The
  fixtures carry `'ph-slack-logo'` because the concept used the phosphor
  *webfont*; this app ships the React components and no webfont, so `Icon` owns
  the lookup. **A fixture icon name that is not in its `GLYPHS` map renders a
  question mark** — visible in review rather than a silent gap. Adding a fixture
  icon means adding it there.
- **`Icon` is always `aria-hidden`.** Every icon in this app sits beside the text
  it illustrates, so it never announces a duplicate. An icon that must carry
  meaning alone needs a labelled sibling.
- **`STATUS_TEXT` pairs with `STATUS_FILL`** in `ui/status-dot.tsx`: the dot's
  `bg-*` and its label's `text-*` come from the same module, because a dot and
  its label drifting to different colours is the bug that file exists to prevent.
- **`Button` defaults to `variant="secondary"`, `size="md"`, `type="button"`.**
  The default type matters: a bare `<button>` inside a `<form>` submits it,
  which is never what a card's option row means; pass `type="submit"`
  explicitly on the rare button that really should. Its four variants are
  `primary`, `secondary`, `danger` and `ghost`; `primary` is the class string
  already hand-copied into eleven panes (`shared/…/agent-editor.tsx`,
  `projects-section.tsx`, `skill-editor.tsx`, `skills-section.tsx`,
  `env-editor.tsx`, `theme-gallery.tsx`, `clone-repo-view.tsx` ×2,
  `agents-section.tsx`, `new-session-picker.tsx`), lifted unchanged. **Landing
  the atom does not sweep those eleven call sites** — that is separate
  follow-up work, not an endorsement to keep hand-rolling the same string
  elsewhere.
- **`SearchBox` owns only the box.** The explorer, PR and Work rows each keep
  their own second line (mode, scope, count) and pass one `onClear` for both the
  clear button and Escape. Escape on an empty box is left alone, so it never
  takes a key something else wanted.

## Layout

### `<AppShell />`

`src/components/layout/app-shell.tsx` — story 020, one tree since HIVE-213.

```ts
function AppShell(): JSX.Element
```

The frame: `<TitleBar />` (the macOS drag strip; nothing off macOS or in the
browser), then one row of `<ActivityBar />` (the bar), `<ListPanel />` (the list
panel), `<CenterStage />` (the stage) and `<SessionPanel />` (the session panel).
Takes no props. It is also the composition root for the app's one-per-channel
subscriptions (session status, the ledger, agents, notifications, the remote
link, the project watcher, the panel chords).

`src/app.tsx` renders `<AppShell />` and nothing else.

The regions are landmark elements — `<nav aria-label="Places">`, `<section
aria-label="<Place> list">`, `<main>`, `<aside aria-label="Session panel">` — so
tests address them by role. The flexbox contract that holds the layout together
is documented in [`../docs/component-patterns.md`](../docs/component-patterns.md);
do not touch the `min-h-0` / `min-w-0` / `shrink-0` classes without reading it.

### `<SessionHeader />` and `<ModelChip />`

`src/components/layout/session-header.tsx` — HIVE-197, built.

The strip over a session or a terminal on the stage, `data-testid="session-header"`:
Back to overmind (its chord in the title), the session's status, task and
branch (or a terminal's label and cwd), the model chip, and the Session menu
with Terminal here. `ModelChip` (`layout/model-chip.tsx`) reads
`useActiveEntity()` and renders `null` unless the active tab is a **session**.

**The model chip's numbers are *observed*, and an unobserved one renders
nothing at all.** They arrive from Claude Code's own status line payload — see
`src/lib/session-metrics.ts` and `electron/main/hooks/settings.ts` — and each
stat carries its own gauge, percentage and separator, so a value nobody has
reported takes all three away with it rather than holding an em dash in a
labelled slot. That absence is routine, not exceptional: `rate_limits` is
missing until a session's first API response and for the whole life of an
API-key session, and the context percentage is null until the first assistant
turn. The chip grows as the session reports.

### `<SessionPanel />` and `<SessionPanelStrip />`

`src/components/layout/session-panel.tsx` — HIVE-201, built. `rowRef: RefObject<HTMLElement | null>`, the row its seam measures against.

The right of the frame while the stage shows a session or a terminal (never on
Home, the Overmind or an agent): open at `--cc-session-panel-w` with a tab per
thing the session has — Plan, Ticket, PR, Files, each drawn only when it
exists — or closed (⌘⌥B, or always under 1,200px) to `SessionPanelStrip`, a
`--cc-session-strip-w` column of the plan's glyphs and one icon per other tab
carrying its fact. Open, a `RailHandle` on its left seam drags the width.
The open tab, open state and width live in `appearance-store`
(`sessionPanelTab`, `sessionPanelOpen`, `sessionPanelWidth`), so they survive a relaunch.

### `<ActivityBar />`

`src/components/layout/activity-bar.tsx` — HIVE-195, built. No props.

Round two's left edge: a `<nav aria-label="Places">` at `--cc-bar-w`. The brand
mark on top is the dock icon's plates without its tile (`public/app-mark.png`,
written by `scripts/icon/generate-app-icon.py --mark`, through
`import.meta.env.BASE_URL`, 28px), alt "Hive TTY"; the team name lives on Home's headline. Below it the five places — Home, Sessions, Work, Agents, PRs — each a
52px button calling `selectPlace`; the active one has `aria-current="page"`.
The foot holds `ConnectionItem`, the theme toggle (HIVE-213: Phosphor `Sun` while the
resolved theme is dark, `Moon` while light, named and titled "Switch to light theme" /
"Switch to dark theme", calling `toggleTheme` through `useToggleTheme` and reading
`useResolvedTheme`) and Settings (`openSettings()`); no Search.
Sessions and Agents carry working counts in grey, PRs its needs-you count in
amber; a zero draws nothing (HIVE-196).

### `<ConnectionItem />`

`src/components/layout/connection-item.tsx` — HIVE-196. No props.

Round two's connection state at the bar's foot, `data-testid="connection-item"`. A dot over a
9.5px label; the label is the first of `connectionStates()` (`src/lib/connection-states.ts`):
disconnected › reconnecting › exposed › demo › attached › serving › local. Click opens a
`Popover` listing every state that holds, with today's chip sentences, the lost-actions note and
Clear, the next-try countdown, and `openSettings('advanced')` links. Reads only what is bound and
attached now (`useReceiverExposure`, `useServerExposure`, `useServingDeviceCount`, `useRemoteLink`,
`isDesktop`).

### `<ListPanel />`

`src/components/layout/list-panel.tsx` — HIVE-195, built. `rowRef: RefObject<HTMLElement | null>`, the row its seam measures against.

Today's panel for the current place, at `--cc-list-w`, in a
`<section aria-label="<Place> list">`: `SessionsPanel` for Sessions,
`WorkPanel`, `AgentsPanel`, `PrsPanel` (the Hatchery). Home has none, and nothing
renders when `panelOpen` is false, or for PRs while the Hatchery is quiet and no
search is open. A `RailHandle` on its right seam drags the width
(`listPanelWidth`); there is no collapsed strip, and the narrow overlay has no
seam. Each place's own story replaces its entry.

### `<RailHandle />`

`src/components/layout/rail-handle.tsx` — built. `rowRef`, `rail: 'list' | 'session'`,
`label: string`, `width: number`, `onWidth(px: number): void`.

The seam between a rail and the stage: a vertical `SplitHandle` with `grip`,
12px wide. The store keeps pixels and `SplitHandle` speaks ratios of the row, so
it converts both ways, measuring the row with a `ResizeObserver`. The ratio is
the seam's centre, so a drag keeps the grip under the cursor. Bounds come from
`PANEL_WIDTHS`; a double-click resets to the initial width.

### `components/layout/` is the composition root

It is the one place under `src/components/` allowed to import `src/features/**` —
the list panel, the stage and the session panel exist to mount feature panels. `components/ui/` and
`components/terminal/` stay fully fenced. See AGENTS.md → Import zones;
`pnpm verify:boundaries` proves both halves.

## Feature panels

### `<SessionsPanel />`

`src/features/projects/components/sessions-panel.tsx` — HIVE-197, built.

The Sessions list panel: a `Projects` head with `N live · N needs you` and a +
named "New session" (opens the picker), then "All projects" (widens the
Overmind again), then one `SessionsProjectRow` per project, folded, and
`NewProjectLink` at the foot. No projects yet: the empty state and the picker.

- **A project row is two buttons.** The caret folds (`aria-expanded`, named
  `Fold <project>` / `Unfold <project>`); the name narrows the Overmind to that
  project (`aria-current`). Keyboard reachability comes free that way.
- **`SessionRow` renders `null` for an id the store does not know.** The
  simulation (061) and the spawn flow (044) both mutate entities underneath open
  panels, so a row that assumes its entity exists is a race waiting to throw.
  `TerminalRow` does the same, and also for a row of the wrong kind.
- **The project line carries the actions.** `NewSessionLink` (`+`) and
  `NewTerminalLink` (`>_`) sit at its right end, folded or not, and show on
  hover or focus while the counts give way. The terminal link is named
  `Terminal in <project>` on purpose, so no locator that begins `New session`
  matches it.
- **A session's mark is a comb**, a hexagon in its status colour: filled while
  the main agent is busy, hollow once it is idle.

Folds and the project filter live in the ui-store rather than in the row because
the panel unmounts on every place switch; component state would forget them.

### `<WorkPanel />`

`src/features/work/components/work-panel.tsx` — story 032, built.

`WorkPanel` is the Work list panel: groups of `TicketRow`s (see *Round two's
Work* below). `TicketSessionRow` / `TicketPrRow` are the rows of a ticket page's
properties column (`TicketProperties`): the same fleet the Sessions panel groups
by repo, grouped by work item instead.

- **The PR section — divider included — is omitted when no linked session has a
  PR.** A rule with nothing under it reads as a rendering bug.
- **`TicketSessionRow` passes `StatusDot` a `label`**, unlike the Sessions panel:
  these rows carry no visible status text, so without one the dot would convey
  status by colour alone.
- **A PR row opens the owning session's terminal when there is a live one, and
  the PR on GitHub when there is not.** A PR has no tab of its own in this app,
  and `Pr.session` is `null` unless a *live* session sits on the branch — which
  for anything merged in the last day it usually does not.

`useTicketPrs()` filters the live `prs` list by the branches the ticket's
sessions are on. It used to walk `Session.pr` instead, with the global list as a
fallback; nothing ever wrote that field, so the section was permanently empty and
only the fixtures made it look otherwise. (The field itself is gone as of
HIVE-100, which found the last two surfaces still reading it — the fleet table's
`PR` column and the old session bar's chip, both empty for the same reason.) It **cannot use
`useShallow`** — it builds new objects, and `useShallow` compares an array's
elements by identity, so every render would produce a new snapshot and React
would loop. It subscribes to the stable slices and memoises instead; the
resolution itself is the exported pure function `resolveTicketPrs()`.

Colour and findings wording live in `src/features/shared/pr-presentation.ts`,
because the PRs panel (052) is a separate slice that must agree with this one.

### Round two's Work: `<TicketRow />`, `<WorkStage />` / `<TicketPage />`, `<TicketPageConversation />`, `<TicketProperties />`

`src/features/work/components/`, HIVE-203.

- **`WorkPanel variant="rows"`** (`WorkList`, what `ListPanel` mounts for
  Work) is the rows: a head (`N tickets · N need you`, a search
  toggle) and groups of `TicketRow`s with fold carets. Skeleton, notices, pull
  to refresh and both pollers live in `WorkPanel`.
- **`TicketRow`** — a tone dot, the title without its tags, and `KEY · fact`
  in mono. The fact and tone are `lib/ticket-activity.ts`'s, pure and tested
  rule by rule. `aria-current` marks the open ticket.
- **`WorkStage`** — what `CenterStage` renders for the `'work'` view: "Pick a
  ticket", else `TicketPage` keyed by the ticket so each open starts fresh.
- **`TicketPage`** — content (header, description, conversation) beside a
  260px properties column. It loads on open and mounts a 60 s poller; a status
  change re-reads the transitions. A failed section shows its message and
  Retry (`ticket-page-parts.tsx`); content already shown stays, "as of HH:MM".
- **`TicketPageConversation`** — Comments | Everything over the slice's
  comments and `useTicketEvents`. A comment's time sits in a fixed 120px slot
  that Reply and Copy link take over on hover or focus, so nothing shifts. The
  reply box posts through `addJiraComment` and appends; a refusal is amber and
  keeps the draft.
- **`TicketProperties`** — `useTicketProperties`' rows (a row without a value is
  left out), the ticket's sessions and PRs, and New session, Move to the next
  status, Open in Jira.
- **`TicketTab`** / **`TicketConstellation`** — HIVE-202: the session panel's
  Ticket tab (`ticket-tab.tsx`): header, acceptance criteria or description,
  latest comment, Links (verdict, constellation, a row per arc) and the footer
  with Open the ticket ›. The layout is `constellation.ts`'s numbers, the arcs and
  verdict `lib/ticket-links.ts`'s; the component draws them. It loads with
  `want: 'tab'` and polls once a minute while mounted, after its first load.

### `<AgentsPanel />`, `<AgentRow />` and `<AgentTile />`

`src/features/agents/components/` — stories 033 and HIVE-114, regrouped by
HIVE-116, into lanes by HIVE-204.

`AgentsPanel` → a header ("Agents", then `N summons` in amber and `N morphing`
in green, each omitted at zero, then a + button labelled "New agent") → one
`section` per lane, named by `aria-label` → a lane header (a chevron button
with `aria-expanded`, a 9px square in the lane's colour, the label and the
count) → `AgentRow`. The lanes are **Summons** (asking, failed or invalid),
**Morphing** (working) and **Burrowed** (sleeping, then paused). Every ordering
rule lives in `useAgentsByGroup` — asking first inside Summons, then the most
recent run; sleeping before paused; empty lanes omitted — so the panel renders a
decision rather than making one. Folds are `agentsFolded` in ui-store, all open
by default. In code a lane is a `group`: `lane:` is an agent frontmatter key.

`+ New agent…` at the foot and the header's + both open a never-saved agent page
on Definition (`openAgentPage(null, 'definition')`). Settings › Agents'
`+ New agent` does not: Settings edits in place, beside its list, with
`AgentDefinition layout="tabs"` from `features/shared/components/`.

`AgentTile` is the row's 38×40 hexagon: an inline SVG polygon stroked in the
state's colour (asking amber with a 22% fill and a soft glow, failed red with a
14% fill, working green, resting subtle, invalid amber outline), the agent's
`Icon` inside, and a live-run badge only past one. Fills go through
`color-mix` on the `--cc-*` token. It is `aria-hidden`.

`AgentRow` is the tile and two lines. Line 1 is the name and a fixed 44px slot
showing the age (`ageLabel`, through `useAge`) of line 2's entry. Line 2 is the
agent's last word on the ledger (`useAgentLastWord`): the kind as a coloured
mono keyword (`ask a3` amber, `failed` red, `event` brand, `post` subtle, `done`
green) and the entry's first line; `invalid` and its reason beat it, and a
paused agent that never wrote says `paused`. On hover or focus Run now and
Pause (Resume) show over the slot, as siblings of the row button so each keeps
its own tab stop. An answer that is not a start takes line 2 for five seconds,
amber, `role="status"`. The row button's accessible name says the state, the
live runs and the last word, so the tile's colour is never the only carrier.

### `<AgentView />`, `<AgentRunLog />` and `<AgentLedger />`

`src/features/agents/components/` — HIVE-116, built.

An agent's place on the centre stage, and **deliberately not a terminal**:
nothing is typed into a process, and the log is a transcript of turns that have
already ended. It keeps the terminal's rhythm — header, body, one input at the
bottom — and that is the whole of the resemblance.

Header, five fact tiles, then the two regions side by side, then the input. The
split is `minmax(0, 1fr) clamp(280px, 22%, 380px)` under a **container query**
that stacks below an 800px stage. Both halves of that are load-bearing and both
are argued in `docs/agents-and-ledger.md`; the short version is that the log is
elastic because it renders at the user's terminal type scale, `1fr` alone would
give the app a horizontal scrollbar, and the panels open and close so only the
container knows how wide the stage is.

`AgentRunLog` takes its colours from the theme's terminal palette in JS, the way
the xterm surface does — those four values already exist and are already
themeable, and a `--cc-run-*` group would be a second copy of them. Finished
runs are one-line receipts with no chevron: their lines were never kept.

`AgentLedger` stacks each entry's kind chip and timestamp **above** its body,
because an inline chip costs 44px of a 280px column. All nine `LedgerKind`
members get a chip. An open ask draws no option buttons — that control is
HIVE-118's, and until it lands the input below is the way to answer.

### `<InboxPanel />` and `<NotificationCard />`

`src/features/inbox/components/` — story 051, built.

A stack of notification cards, newest first, from `useNotifs()`.

- **Clicking a card does two things**: `openTab(notif.target)` and
  `markRead(index)`. Navigating without marking read would leave both badges
  lying about what is still waiting; marking read without navigating would lose
  the thread. This is the entry point of the payoff loop (043) — one click from
  "something needs you" to the terminal showing the amber prompt.
- **`markRead` addresses a notification by index**, so the panel passes the array
  position down even though the card renders from the object.
- **Cards are keyed by content, not index.** The simulation prepends; an index
  key would make React reuse the top card's DOM for a different notification.
- **Unread is carried by fill *and* a visually hidden "unread"**, because the
  count that fill implies is the whole point of the red tab badge, and colour
  alone puts it out of reach of a screen reader.
- The store caps the list at 8 (`NOTIF_CAP`); the panel renders what it is given.
- **A card carrying a `link` grows a wrapper, and the exit moves with it**
  (HIVE-123). `notif.link` renders as a real `<a>`, and an anchor inside a
  `<button>` is interactive content inside interactive content — so the link is
  the button's *sibling* under a wrapping `<div>`, the way `session-table.tsx`
  draws its row action. The card's dismissal — `overflow-hidden`, the measured
  `--cc-card-h`, `animate-ccslideout` and the list's own `mb-*` — then belongs
  to that wrapper rather than to the button: left on the button, the link and
  the margin below it held full height while the button collapsed, and the list
  jumped when the remainder unmounted.

### The Hatchery: `<PrsPanel />`, `<PrRow />`, `<Flap />`

`src/features/pull-requests/components/` — HIVE-205, built (replaced story 052's
`<PrCard />` and its badge row).

One two-line row per PR from `useHatchery()` (HIVE-215's order: SUMMONS first),
under a header that says `N open · M need you`.

- **Merged PRs fold under `HATCHED · N · last 24h`**, folded by default
  (`prsFolded` in the ui-store), drawn only when something merged.
- **Search is the header's icon**, shown only while the sweep is live (a search
  needs `gh`). It opens `PrSearchRow` with the box focused (`focusOnMount`, an
  effect, since jsx-a11y bans `autoFocus`); a search replaces the rows with
  `useHatcherySearch()`, by the same flap rules. Closing it clears it.
- **Rows are memoised by value** (`PrRow`'s `sameRow`) and keyed by
  `prKey(owner, repo, n)`; `onOpen` is a stable callback and `open` a string
  comparison, so a ledger append that names no PR re-renders no row.
- **The flap turns only when its word changes** between two renders of the same
  row: never on mount, so never on first render, a fold or a search. SUMMONS
  pulses. Under `useReducedMotion` it neither turns nor pulses.
- **A row opens the PR page** (`openPrPage`).

### The PR page: `<PrPage />`, `<ShipTrack />`, `<PrConversation />`, `<ThreadCard />`, `<PrProperties />`, `<PrCommentBox />`

`src/features/pull-requests/components/` — HIVE-205, built. `<PrsStage />` picks
what the stage shows: the empty Hatchery, the page for `useOpenPr()`, or "Pick a
pull request" while the sweep is not live.

- **The detail is polled** once a minute through its own `createPoller`; the page
  is keyed on the PR, so opening another is a new mount and a fresh read. A
  failed refresh keeps the last detail with the problem above it.
- **`PR_TABS` is the tab list** (Conversation, Files, Checks, Timeline); a stored tab this
  page does not have falls back to Conversation in the page, not in the store.
- **The ship track** is `bandStops()` over PR 1's `shipTrack`: the shipper's
  eight stops while it holds the PR, all eight ticked once merged after it ran,
  else the short Draft · Open · Review · Merge from GitHub's state.
- **A merged PR is read-only**: no comment box, and the actions are GitHub alone.
- **Merge answers the shipper's merge card** (`useMergeAsk`) with `allow-once`,
  the same answer the Inbox card's narrowest rung sends, and is disabled until
  that card exists. One ledger write at a time; a refusal or a failed call shows
  inline in amber. No `gh` write is added.
- **Nothing from GitHub is HTML.** Bodies and comments go through `<Markdown />`
  (`src/features/shared/components/markdown.tsx`): `marked`'s lexer to React
  elements, raw HTML as text, links only for `http(s):` and `mailto:`.

### The Files tab: `<PrFiles />`, `<PrFileTree />`, `<PrDiff />`, and `<ThreadCard />`'s writes

`src/features/pull-requests/components/` — HIVE-207, built. The tab strip's Files
entry carries the changed-file count ("Files 9") once the detail is read.

- **`<PrFiles pr detail fixerOnIt onOpenFile? />`** (`pr-files.tsx`) lays the tree
  beside the selected file's diff and reads the diff at `detail.headSha`, so the
  page's 60s detail poll moving the head re-reads it. A stored `prFile` no longer
  in the list falls back to the first file with an open thread, in render. A
  missing `prDiffs` entry reads as loading; a failed re-read keeps the old text
  under the problem.
- **`<PrFileTree detail selected onSelect />`** (`pr-file-tree.tsx`): "Filter
  files", the "9 files · 2 open threads · viewed 3 of 9" summary (plus a GitHub
  link when GitHub sent fewer files than changed), folders by their directory, and
  a row per file with its thread mark, viewed check or "changed", and +/−.
- **`<PrDiff file diff threads problem? loading? prUrl readOnly onViewed onOpenFile? writes? fixerOnIt />`**
  (`pr-diff.tsx`): the header (path, +/−, Viewed, Unified | Split, Open in the
  editor) and plain mono rows with no highlighting, each thread under the line it
  is about and outdated ones on top. Viewed is optimistic through the store and
  disabled while its write is pending and on a merged PR.
- **`<ThreadCard writes? />`** gains `writes?: ThreadWrites`: Reply (a box under
  the thread), Resolve and Unresolve, not optimistic, the reason inline on a
  refusal. `useThreadWrites(pr)` builds it for Conversation and Files, and
  answers none on a merged PR.

**The Checks tab** (`pr-checks.tsx`, HIVE-206). It mounts its own 60s poller,
so runs and jobs are read only while it is shown.
- **`RunBar`**: the shown run, its sha and age; the last eight pushes as 9 × 14 squares (a click shows that push); a chip per workflow file.
- **`ChecksGraphView`**: `layoutGraph`'s boxes (160 × 48) and edges.
  - Edges take their target's state, and an edge into a running job flows (`animate-ccflow`, still under reduced motion).
  - A matrix box opens into its legs.
- **The non-Actions checks** are a row of chips with links out.
- **`JobSteps`** is the shown job, with Re-run failed, Open the log, and "<holder> has it" (`holderIcon`). **`JobLog`** shows the cut log, toned by `classifyLogLine`.
- **No runs and no other checks** reads "No checks on <sha>".
- A tab can carry `SegmentedOption.alert`, a red dot that reads ", failing".

### The Timeline tab: `<PrTimeline />`, `<TimelineLane />`, `<TimeBuckets />`

`src/features/pull-requests/components/` — HIVE-208, built. Derivation is
`src/lib/pr-timeline.ts`; the component only draws `useTimelineModel`.

- **`<PrTimeline pr />`** (`pr-timeline.tsx`) mounts its own 60s poller, so the
  read runs only while the tab is shown. It draws a skeleton until the first read, a
  `SourceProblem` with Retry when that fails, and the problem above the lanes when a
  refresh fails. Six lanes (Flap, Commits, CI, Reviews, Comments, Agents), the tick
  row, a green "now" line while the PR is open, and `<TimeBuckets />` below.
- **`<TimelineLane label marks height? />`** (`timeline-lane.tsx`): a 130px label
  gutter (`GUTTER`; the axis, ticks and now line share it via `axisLeft`), lanes 52px
  high, the Flap lane 40px. `LaneMark` is `{ key, from, to?, shape, tone, word?, tip, onOpen }`:
  `from`/`to` are 0..1 on the axis, `tone` comes from a fixed class table, never
  built from data, and `word` is drawn inside a span only when it fits.
- **Marks are buttons** (`aria-label` is the tooltip text). One tooltip per lane
  shows on hover and on focus, so focus equals hover, and Enter is a native click.
- **Mark sizes:** flap 22px band; commit a 10px ring; CI bar 12px; review a 12px
  diamond (amber when it asks for changes); comment a 12 × 11px bubble; hold a 20px
  pill. Colours are tokens: green/red CI, brand for commits and comments,
  chitin for holds, amber for reviews that wait on you. MUTATING is green stripes.
- **Where each mark lands:** a CI bar opens Checks on its push (`showPrRun(sha)`);
  a commit opens GitHub in a new tab; a review, comment, flap or hold calls
  `focusPrEvent` and the Conversation scrolls to it (the ledger events by `e-<id>`,
  GitHub's by `r-<url>` / `c-<url>`). A flap or hold with no ledger event falls back to
  the Conversation tab, a hold to Everything.
- **`<TimeBuckets age buckets sentence />`** (`time-buckets.tsx`): "Where the 3h 20m
  went", one stacked bar of up to six buckets sized by time (a 24-minute floor so
  none vanishes), and the sentence. `dur` is the tab's one duration format.

### `<EmptyHatchery />`

`src/features/pull-requests/components/empty-hatchery.tsx` — HIVE-205, built.

When the sweep is live and empty the list panel draws nothing (unless a search
is open) and the stage shows a dormant egg on the creep, in tokens only. Search
older PRs opens the panel with the search; New session opens the picker. Under
reduced motion every animation class is dropped: the crack stays closed and no
spores are drawn. The panel slides in (`animate-ccslidein`) only on the quiet →
listed change, never on mount.

### `<ExplorerPanel />` and `<TreeNode />`

`src/features/explorer/components/` — built.

A lazy tree of the active session's repository. Replaced `<ActivityFeedPanel />`,
which rendered fixture rows narrating events the app already shows elsewhere.

- **The root follows the session**, through `useExplorerProject()`. There is no
  project picker: the app is already organised around "which session am I
  watching", and a second selector would be one more thing to keep in sync with
  the first. The orchestrator tab falls back to the last project the tree was
  rooted at.
- **A collapsed directory is never read.** Each expanded node owns its own
  `useDirectory()` call, which is what makes opening a repository cheap.
- **The whole row is a `<button>`**, like `SessionRow` — reachable by keyboard,
  with `aria-expanded` on directories and `aria-current` on the open file.
  Indentation is *padding on the button*, not a nested container, so the hover
  and selection backgrounds run the full width of the panel rather than being
  inset one level per depth.
- **Not a `role="tree"`.** A real ARIA tree needs roving tabindex, typeahead and
  arrow-key navigation across the whole widget to be correct; a half-built one
  announces capabilities that are not there. This is a list of buttons that all
  work, and full tree semantics are a deliberate follow-up.
- **It does not own the filesystem watcher.** That is `useProjectWatcher` at the
  composition root: an open editor buffer reconciles against the same events and
  outlives the session panel's Files tab. The panel reads the revision counter the watcher bumps.

### `<EditorPane />`, `<EditorTabStrip />` and `<EditorNotice />`

`src/features/editor/components/` — built.

The centre stage's document half: the strip of open files, the notices for when
the disk and the buffer disagree, and the CodeMirror surface itself.

- **The strip is stage chrome, not editor chrome**, and carries a Terminal entry
  exactly when the terminal is hidden — full-stage placement only.
- **The dirty dot sits inside the label, not in place of the ×.** Swapping the
  close control for a dot moves it at exactly the moment you most want to close
  a tab deliberately.
- **Notices are amber, never red.** An agent rewriting a file under you is the
  entire point of the app, not a failure.
- **`<ViewToggle />`** (Source · Preview · Split) mounts beside the tablist, never
  inside it, or in the single-file header, for a markdown file with text.
  **`<MarkdownStage />`** renders Preview or Split and falls back to the source
  with a notice if the parse fails.

### `<PlanTab />` and `<PlanGlyph />`

`src/features/plan/components/` — HIVE-181, the session panel's Plan tab since
HIVE-201. Props only — `plan`, `onOpenFile` — so the slice reads no store; the
session panel passes `usePlan`. `PlanTab` is the plan opened: where it is, what
it is doing now, and for how long (the clock ticks only while a task is in
progress and the tab is shown). `PlanGlyph` is one task's 16px ring: numbered on
`border-term-track` while pending, green and `ccpulse` while in progress, a
filled `bg-green` check when done, "proposed" for a plan-mode task. The closed
panel's strip stacks the glyphs on top. See `docs/component-patterns.md`, *The
session panel*.

### `<CenterStage />`

`src/components/layout/center-stage.tsx` — story 040, built.

`CenterStage` mounts `<TerminalHost />` and builds one `StaticTransport` per
entity, cached for the life of the app — transport identity matters, because a
surface resubscribes whenever its transport changes. Which of the four states it
renders comes from `resolveView()` in `src/lib/resolve-view.ts`.

Two covers are drawn *over* the live surface rather than instead of it, so the
terminal underneath stays mounted and keeps its scrollback: `SessionBootCover`
while a session's agent is starting, and `TerminalEndedCover` — a strip along
the foot, because the transcript above it is the evidence — when a terminal's
shell died unasked. A terminal the user exited is removed outright and has
nothing to cover.

### Feature components (epic HIVE-4)

| Component | File | Story |
| --- | --- | --- |
| `SessionTable` | `features/orchestrator/components/session-table.tsx` | 041 |
| `ConsoleInput` | `features/orchestrator/components/console-input.tsx` | 041 |
| `MessageInput` | `features/sessions/components/message-input.tsx` | 043 |
| `NewSessionPicker` | `features/sessions/components/new-session-picker.tsx` | 044 |
| `OptionStepper` | `features/sessions/components/option-stepper.tsx` | 044 |

`OptionStepper` is bespoke rather than a shadcn primitive — nothing else uses it
— but exposes `radiogroup`/`radio` roles, because that is what the four options
*are*. `NewSessionPicker` composes `radix-ui`'s Dialog directly rather than the
vendored `DialogContent`, which always portals to `document.body`; the picker
fills the center stage instead. Radix's focus trap, Escape, scroll lock, and
`aria-modal` are all retained.

### `<SlackGroup />`

`src/features/settings/components/slack-group.tsx` — Settings › Integrations,
HIVE-123. Design record:
https://claude.ai/code/artifact/efe48323-a347-4744-8c00-026f8ff086b8

One `SettingsGroup` (`src/features/shared/components/settings-group.tsx` since
HIVE-204, beside `InlineConfirm` and the shipped marker, so the agents slice can
use them too) — a status row (state pill · identity · actions), a
hairline, then one caption line and an `Advanced` disclosure closed by
default. Chosen over the two alternatives considered (mirroring Jira's three
nested groups, and a connection card), both of which cost roughly three times
the height to say one sentence.

- **The state pill** (`off` / `ok` / `wait` / `err`) collapses `SlackStatus`'s
  five `kind`s down to four — `not-added` and `needs-auth` read identically,
  both "sign in again" (`pillKindOf`).
- **The caption is one slot with a strict precedence** — an error message,
  else the approval sentence, else the Used-by summary — never two at once.
  That is what lets `pending-approval` and a failed sign-in fit without a
  fourth block; `Caption` is the one place the decision gets made.
- **Only two fields off `AgentSummary` are read**: `name` and `tools` — the
  Used-by line and the `grantsSlackTools` hint. `SlackGroupAgent` is typed
  narrower than the full summary on purpose; `AgentSummary` is structurally a
  superset, so `integrations-section.tsx` passes it straight through.
- **A broken bridge is reported, not swallowed.** `readSlackStatus` / `signIn`
  / `signOut` / `testSlack` (`src/lib/slack.ts`) all return `null` when the
  IPC call cannot reach main; the group turns that into an `error`-kind status
  rather than rendering nothing, the same choice `JiraCredentialGroup` makes
  for a failed Jira verb.
