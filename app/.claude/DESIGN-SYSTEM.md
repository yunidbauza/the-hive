# Design system

Read this before any UI task. The visual source of truth is
[`../../concept/`](../../concept/) — when a story is silent on a colour, size, or
string, the concept file decides.

The values below are asserted against `src/styles/tokens.css` and
`src/lib/terminal/ansi.ts` by `tests/design-system.test.ts`. Edit them together or
the test fails.

## Colour tokens

Defined on `:root` (dark, the default) with a `body[data-theme="light"]` override,
and bound to Tailwind via `@theme inline` in `src/styles/tokens.css`.

| Token | Dark | Light | Used for |
| --- | --- | --- | --- |
| `--cc-bg` | `#10152a` | `#fdfdfb` | app background |
| `--cc-panel` | `#141a33` | `#ffffff` | rails, cards, panels |
| `--cc-panel-2` | `#121731` | `#f7fafb` | nested/recessed panels |
| `--cc-hover` | `#1b2344` | `#f4f9ff` | hover state |
| `--cc-active` | `#222c55` | `#e9f3fc` | active/selected row |
| `--cc-border` | `#273159` | `#d4dee3` | dividers, outlines |
| `--cc-border-soft` | `#1e2747` | `#edf2f4` | quieter dividers |
| `--cc-ink` | `#e9effc` | `#2c2f34` | primary text |
| `--cc-muted` | `#98a3cc` | `#73767c` | secondary text |
| `--cc-subtle` | `#6b779f` | `#8e949c` | tertiary text, idle status |
| `--cc-brand` | `#8fa7f2` | `#334fa9` | brand, done status |
| `--cc-green` | `#74b79c` | `#2e6b52` | working / online status |
| `--cc-amber` | `#ffac47` | `#c77414` | needs-input status |
| `--cc-red` | `#ff8d85` | `#d3372f` | errors, failing checks |
| `--cc-chip` | `#1c2648` | `#edf2f4` | chips, pills |
| `--cc-term-bg` | `#0b1023` | *(unchanged)* | terminal background |
| `--cc-term-input` | `#0e1430` | *(unchanged)* | terminal input bar |
| `--cc-term-row-hover` | `#161f45` | *(unchanged)* | session-table row hover |
| `--cc-term-row-active` | `#1a2450` | *(unchanged)* | session-table selected row |
| `--cc-term-head` | `#4d5a86` | *(unchanged)* | session-table column headers |
| `--cc-term-track` | `#3a4674` | *(unchanged)* | picker stepper track and dots |
| `--cc-brand-fill` | `#5e76d0` | *(unchanged)* | primary button |
| `--cc-brand-fill-hover` | `#4f6ac5` | *(unchanged)* | primary button hover |
| `--cc-brand-fill-strong` | `#334fa9` | *(unchanged)* | hive-mark tile (Serenity) |
| `--cc-on-brand` | `#ffffff` | *(unchanged)* | text/icons on a brand fill |
| `--cc-danger-solid` | `#d3372f` | *(unchanged)* | notification badge fill |

**The terminal stays dark in light mode.** The six `--cc-term-*` tokens are
deliberately not overridden — this matches the concept and most real terminal
tools. The row, header, and track tokens exist because the orchestrator's session table
(041) and the new-session picker (044) are **DOM, not xterm**, so they need real
CSS for surfaces the TERM palette does not cover.

Note what they are *not*: terminal **text** colours. Those live only in
`src/lib/terminal/ansi.ts` and never appear in this file or in `tokens.css` — a
rule with a test behind it. A DOM element sitting on the terminal background
takes its text colour from the ordinary UI tokens (`text-green`, `text-amber`,
`text-subtle`, `text-brand`), which is why the session table's status column
matches the rails rather than the transcript.

**Brand fills are surfaces, and do not flip with the theme.** `--cc-brand` is a
*text* colour and changes between themes so it stays legible on a panel. The
five tokens above paint filled shapes — the hive mark's tile, the primary
button, the unread badge — and keep the same value in both themes, exactly as
the concept does (`--blue-600/700/800` and `--color-error`, none of which its
light theme overrides). Painting the logo tile with `bg-brand` would turn it
pale blue in dark mode and read as a different logo.

`--cc-danger-solid` is darker than `--cc-red` on purpose: white badge text on
`#d3372f` clears WCAG AA at 4.87:1, where `--cc-red`'s dark-mode `#ff8d85` would
not.

### Tailwind mapping

`@theme inline` binds each token to a Tailwind colour without copying its value,
so `tokens.css` stays the single source of truth and the light override keeps
working through the same variables:

```
--cc-bg → bg-bg / text-bg / border-bg
--cc-panel → bg-panel      --cc-panel-2 → bg-panel-2
--cc-hover → bg-hover      --cc-active → bg-active
--cc-border → border-border  --cc-border-soft → border-border-soft
--cc-ink → text-ink        --cc-muted → text-muted   --cc-subtle → text-subtle
--cc-brand → text-brand    --cc-green → text-green
--cc-amber → text-amber    --cc-red → text-red
--cc-chip → bg-chip        --cc-term-bg → bg-term-bg
--cc-brand-fill → bg-brand-fill    --cc-brand-fill-hover → bg-brand-fill-hover
--cc-brand-fill-strong → bg-brand-fill-strong
--cc-on-brand → text-on-brand      --cc-danger-solid → bg-danger-solid
```

`inline` matters: it makes utilities emit `var(--cc-*)` rather than resolving the
value at build time, which is what lets a single `data-theme` flip recolour the
whole app.

**Raw hex literals in component code are banned.** If a colour is missing, add a
token.

## Terminal text palette

Exported from `src/lib/terminal/ansi.ts`. Deliberately **not** in `@theme` — it
never reaches CSS. xterm resolves colours from its own `theme` option and paints
them into markup it owns, so a CSS custom property has no path to a terminal cell;
this palette is consumed as JS by xterm and by the ANSI colorizer.

In light mode the terminal stays dark (story 011). `buildXtermTheme(theme)` varies
only `selectionBackground` (`#33407a`) and `cursor` (`TERM.green`), because the
dark selection wash is nearly invisible against a bright surround.

| Key | Value | Used for |
| --- | --- | --- |
| `ink` | `#dbe4ff` | default foreground |
| `dim` | `#7c88b8` | secondary / meta |
| `green` | `#7ee2b8` | success, prompts |
| `blue` | `#8fb5ff` | tool calls (Read/Edit/Bash lines) |
| `amber` | `#ffc06e` | working spinner, questions |
| `red` | `#ff8d85` | errors |
| `cyan` | `#7edce2` | orchestrator-injected lines, PR refs |
| `bg` | `#0b1023` | terminal background |
| `selection` | `#222c55` | selection highlight |

The text colours are intentionally distinct from the UI palette — `TERM.green` is
not `--cc-green` — because text on a dark canvas needs more lift than the same
semantic colour does in chrome. Three surface values legitimately coincide with UI
tokens: `bg` is `--cc-term-bg`, `selection` is `--cc-active`, and `red` is shared
with `--cc-red`.

## Status → colour

| Status | Label | Token | Notes |
| --- | --- | --- | --- |
| `working` | working | `--cc-green` | dot pulses (`ccpulse`) |
| `waiting` | needs input | `--cc-amber` | blocked on user answer/permission |
| `idle` | idle | `--cc-subtle` | context saved, resumable |
| `done` | done | `--cc-brand` | listed under COMPLETED |
| `online` | online | `--cc-green` | agents only |

Status is never carried by colour alone — every status also has a label, so the
model survives colour-blindness and reduced-motion.

## Type

- **Family:** `ui-mono` stack — `ui-monospace, Menlo, 'SF Mono', monospace`,
  registered as `--font-mono` and available as `font-mono`. All terminal and UI
  text is monospace; the command center is a terminal tool and reads as one.
- **Base size:** 13px / 1.5 on `body`.
- **Terminal:** 12px inside xterm.

## Motion

| Animation | Utility | Definition |
| --- | --- | --- |
| `ccpulse` | `animate-ccpulse` | opacity 1 → .3 → 1, 1.6s ease-in-out infinite |
| `ccblink` | `animate-ccblink` | opacity 1 → 0 → 1, 1s step-end infinite |

Both are registered in `tokens.css` as `--animate-*`, so components use the
utility rather than hand-written CSS.

`prefers-reduced-motion: reduce` collapses all animation and transition durations
to ~0. Safe because animation here is always decoration — the pulsing dot repeats
information the label already carries.

## Chrome

- Header height **56px**; left rail **268px**; activity rail **316px**.
- Scrollbars are thin (10px), thumb `--cc-border`, transparent track, rounded.
- Interactive controls show a pointer cursor — a base rule in `global.css`, since
  Tailwind v4 dropped the one that used to provide this. Do not add
  `cursor-pointer` per component.
