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
  entries: { id: string; transport: TerminalTransport; readOnly?: boolean }[];
  activeId: string | null;
  theme: 'dark' | 'light';
  fontSize?: number;
}): JSX.Element
```

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

## Hive atoms

Each is owned by the story that first needs it. Two are built; the rest are a
contract for their owning story, not existing code.

| Atom | File | Owner | Props | State |
| --- | --- | --- | --- | --- |
| `Chip` | `ui/chip.tsx` | 021 (also 040) | `children: ReactNode`, `tone?: Tone`, `title?: string`, `className?: string` | **built** |
| `Badge` | `ui/badge.tsx` | **021** (also 030, 050) | `count: number`, `tone?: BadgeTone`, `label?: string`, `className?: string` | **built** |
| `Tag` | `ui/tag.tsx` | **052** | `children: ReactNode`, `tone: 'brand' \| 'green' \| 'amber' \| 'red' \| 'subtle'`, `className?: string` | **built** |
| `TabBar` | `ui/tab-bar.tsx` | **030** (reused by 050) | generic over `Id extends string`: `tabs: { id: Id; label: string; badgeCount?: number; badgeLabel?: string; badgeTone?: BadgeTone }[]`, `active: Id`, `onSelect(id: Id): void`, `label: string`, `className?: string` | **built** |
| `StatusDot` | `ui/status-dot.tsx` | **030** (used by 031, 032, 041) | `status: SessionStatus \| 'online'`, `pulse?: boolean`, `label?: string`, `className?: string` | **built** |
| `Icon` | `ui/icon.tsx` | **031** (also 033, 051, 053) | `name: string`, `size?: number`, `weight?: IconWeight`, `className?: string` | **built** |
| `KeyHint` | `ui/key-hint.tsx` | 041 (also 043) | `keys: string[]`, `label: string` | planned |
| `SecretField` | `ui/secret-field.tsx` | **HIVE-67** | `label: string`, `value: string`, `onChange(value: string): void`, `onCommit?(): void`, `placeholder?: string`, `hint?: string`, `className?: string` | **built** |
| `SplitHandle` | `ui/split-handle.tsx` | **explorer** | `axis: 'horizontal' \| 'vertical'`, `containerRef: RefObject<HTMLElement>`, `ratio: number`, `onRatio(ratio: number): void` | **built** |

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
- **`TabBar`'s badge reuses `Badge` at `Badge`'s geometry**, not the concept's
  15px/9.5px. One badge geometry with three tones beats a second near-identical
  atom; the 1px difference is deliberate.
- **`Tag` is the third pill, and the three do not overlap.** `Badge` takes a
  `count` and renders nothing at zero, so it cannot carry a word. `Chip` is a
  larger mono pill for dense status text (the header's model chip, the meta
  bar's branch) and has no `subtle` tone. `Tag` is proportional text at badge
  scale, used for the PRs panel's `merged` / `2 open findings` / `checks
  running` row. Reach for a fourth only when none of those three fits — and say
  why here.
- **`Tag`'s fill never changes, only its ink.** Every tone sits on `bg-chip`,
  which is what lets four of them wrap in one row without competing.
- **`TabBar`'s `badgeTone` defaults to `muted`.** The left rail's work count is
  an inventory and stays quiet; the activity rail passes `danger` because its
  unread count means the user is what an agent is blocked on (050).
- **`BadgeTone` is exported from `ui/badge.tsx`** and reused by `TabBar`, so the
  two atoms cannot drift to different tone vocabularies.
- **`TabBar` is generic over its id type.** Pass `Tab<LeftTab>[]` and `onSelect`
  hands back a `LeftTab`, not a `string` — no `as` cast at the call site, and an
  id outside the union stops compiling.
- **Set `badgeLabel` whenever you set `badgeCount`.** This is the one place the
  usual "omit the label" advice inverts: a tab is named by its *content*, not by
  an `aria-label`, so an unlabelled badge is `aria-hidden` and its number reaches
  nobody using a screen reader. With it, the tab announces `"Work 8 work items"`.
- **Use the exported `tabId(id)` helper** for a panel's `aria-labelledby` rather
  than re-spelling the `tab-${id}` convention; the atom owns that format.
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

### `<ActivityRail />`

`src/components/layout/activity-rail.tsx` — story 050, built.

316px fixed, and the only region the shell can hide (`showActivityRail`, 020).
Structurally a twin of `<LeftRail />`: a pinned `<TabBar />` over a scrolling tab
panel that mounts exactly one of `InboxPanel` (051), `PrsPanel` (052), or
`ExplorerPanel`. Reads `useRailState()` / `useSetRailTab()`, plus
`useUnreadCount()` for the Inbox badge.

- **The Inbox badge is `danger`, not `muted`.** It is the one count in the app
  that means *you are the blocker*; the left rail's work count is an inventory.
- **Scroll position resets on tab switch.** Story 050 asks for an explicit
  choice. Preserving it per panel means keeping all three mounted or mirroring
  `scrollTop` into the ui-store, and for three short lists neither earns the
  complexity — a stale offset into a list the simulation just prepended to is
  worse than starting at the top.

### `components/layout/` is the composition root

It is the one place under `src/components/` allowed to import `src/features/**` —
the rails and the center stage exist to mount feature panels. `components/ui/` and
`components/terminal/` stay fully fenced. See AGENTS.md → Import zones;
`pnpm verify:boundaries` proves both halves.

## Feature panels

### `<ProjectsPanel />`

`src/features/projects/components/projects-panel.tsx` — story 031, built.

A collapsible tree: `ProjectsPanel` → `ProjectRow` (per fixture project) →
`SessionRow` (per non-done session). The panel itself holds no state and reads no
session data — **each row owns its own subscription**, so one session changing
status repaints that row rather than the whole tree.

Three things here are easy to get wrong:

- **The count pill is a plain span, not `Badge`.** `Badge` renders nothing at
  zero, and a project with no live sessions must still show its `0` — that is the
  story's empty state, and losing the pill would read as a rendering bug.
- **Both rows are `<button>`s, not divs with `onClick`.** The project row carries
  `aria-expanded`; the session row carries `aria-current` when its tab is open.
  Keyboard reachability comes free that way.
- **`SessionRow` renders `null` for an id the store does not know.** The
  simulation (061) and the spawn flow (044) both mutate entities underneath open
  panels, so a row that assumes its entity exists is a race waiting to throw.

`collapsed` lives in the ui-store rather than in `ProjectRow` because the panel
unmounts on every left-rail tab switch; component state would forget the tree.

### `<WorkPanel />`

`src/features/work/components/work-panel.tsx` — story 032, built.

`WorkPanel` → `TicketCard` → `TicketSessionRow` / `TicketPrRow`. The same fleet the
projects panel groups by repo, grouped by work item instead.

- **The PR section — divider included — is omitted when no linked session has a
  PR.** A rule with nothing under it reads as a rendering bug.
- **`TicketSessionRow` passes `StatusDot` a `label`**, unlike the projects panel:
  these rows carry no visible status text, so without one the dot would convey
  status by colour alone.
- **A PR row opens the owning session's terminal when there is a live one, and
  the PR on GitHub when there is not.** A PR has no tab of its own in this app,
  and `Pr.session` is `null` unless a *live* session sits on the branch — which
  for anything merged in the last day it usually does not.

`useTicketPrs()` filters the live `prs` list by the branches the ticket's
sessions are on. It used to walk `Session.pr` instead, with the global list as a
fallback; nothing ever wrote that field, so the section was permanently empty and
only the fixtures made it look otherwise. It **cannot use
`useShallow`** — it builds new objects, and `useShallow` compares an array's
elements by identity, so every render would produce a new snapshot and React
would loop. It subscribes to the stable slices and memoises instead; the
resolution itself is the exported pure function `resolveTicketPrs()`.

Colour and findings wording live in `src/features/shared/pr-presentation.ts`,
because the PRs panel (052) is a separate slice that must agree with this one.

### `<AgentsPanel />`

`src/features/agents/components/agents-panel.tsx` — story 033, built.

`AgentsPanel` → `AgentRow`, one per id in `agentOrder`. Clicking a row opens the
agent's terminal — the session view with agent chips (043).

**The online dot is not `StatusDot`.** That atom is a 7px unringed dot; this one
is 9px with a 2px `--cc-panel` ring so it reads as lifted off the avatar tile.
Deliberately built inline rather than bending the atom to fit two shapes.

Its `online` text is `sr-only` and sits **last** in the row, so the row announces
`"slack-agent … online"` rather than leading with its status. Agents are always
online in this phase, but the state still may not ride on the green alone.

Creating and pausing agents is out of scope here — they are fixture-defined.

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

### `<PrsPanel />` and `<PrCard />`

`src/features/pull-requests/components/` — story 052, built.

One card per PR from `usePrs()`, with a wrapping badge row.

- **Badges come from `composeBadges()` in `features/shared/pr-presentation.ts`**,
  never from local `if`s — see the note in that file for why the rules live
  outside this slice.
- **The badge row is unguarded** because every `PrListState` yields at least one
  badge; an `if (badges.length)` would be an unreachable branch.
- **Clicking opens the owning *session* when one is live, and GitHub when none
  is.** The agent that produced a PR is where a human can act on the findings —
  but a merged PR's session has usually ended, and `openEntity` refuses those,
  so `Pr.session` resolves to `null` and the card becomes a real link instead.

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
- **The whole row is a `<button>`**, like `ProjectRow` — reachable by keyboard,
  with `aria-expanded` on directories and `aria-current` on the open file.
  Indentation is *padding on the button*, not a nested container, so the hover
  and selection backgrounds run the full width of the rail rather than being
  inset one level per depth.
- **Not a `role="tree"`.** A real ARIA tree needs roving tabindex, typeahead and
  arrow-key navigation across the whole widget to be correct; a half-built one
  announces capabilities that are not there. This is a list of buttons that all
  work, and full tree semantics are a deliberate follow-up.
- **It does not own the filesystem watcher.** That is `useProjectWatcher` at the
  composition root: an open editor buffer reconciles against the same events and
  outlives the rail tab. The panel reads the revision counter the watcher bumps.

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

### Region placeholders

Still bare panels, owned by the story that fills each in.

| Region | File | Filled in by |
| --- | --- | --- |
| `CenterStage` | `layout/center-stage.tsx` | 040 — view-state machine, session meta bar |

`ActivityRail` is no longer a placeholder — story 050 filled it in; see below.

`CenterStage` mounts `<TerminalHost />` and builds one `StaticTransport` per
entity, cached for the life of the app — transport identity matters, because a
surface resubscribes whenever its transport changes. Which of the four states it
renders comes from `resolveView()` in `src/lib/resolve-view.ts`.

### `<SessionMetaBar />`

`src/components/layout/session-meta-bar.tsx`

```ts
function SessionMetaBar(props: { entity: Entity }): JSX.Element
```

The bar above the terminal in the session and agent views (040): a back pill,
the entity id, its one-line task, and status chips. Sessions get branch, status,
and PR; agents get "dedicated agent" and "online".

Everything is derived from the entity, so a status change reaches this bar the
same moment it reaches the rails — including the `waiting → "needs input"`
rename, which comes from `STATUS_LABEL` rather than being spelled again here.
PR colour comes from `features/shared/pr-presentation`, shared with the work and
PRs panels.

The back pill uses a native `title` rather than the Radix tooltip: the app mounts
no `TooltipProvider`, and adding one to the root for a single affordance buys
nothing a title does not. The label names the shortcut story 060 will bind.

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
